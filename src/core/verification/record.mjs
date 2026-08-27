import crypto from 'node:crypto';

export const VERIFICATION_RECORD_SCHEMA = 'core.verification/v1';
export const VERIFICATION_STATUSES = Object.freeze([
  'VERIFIED',
  'VERIFIED_WITH_LIMITS',
  'REJECTED',
  'UNRESOLVED'
]);

const STATUS_SET = new Set(VERIFICATION_STATUSES);

export function createVerificationRecord({
  verifierId,
  verifierVersion = 'v1',
  status,
  checkedRefs = [],
  findings = []
}) {
  if (typeof verifierId !== 'string' || !verifierId.trim()) {
    throw new TypeError('verifierId is required');
  }
  if (typeof verifierVersion !== 'string' || !verifierVersion.trim()) {
    throw new TypeError('verifierVersion is required');
  }
  if (!STATUS_SET.has(status)) throw new TypeError('invalid verification status: ' + status);

  const body = {
    schema: VERIFICATION_RECORD_SCHEMA,
    verifier_id: verifierId,
    verifier_version: verifierVersion,
    status,
    checked_refs: [...new Set(checkedRefs.map(String))].sort(),
    findings: findings.map(normalizeFinding)
  };

  return {
    ...body,
    id: 'verification:sha256:' + crypto.createHash('sha256')
      .update(stableStringify(body))
      .digest('hex')
  };
}

export function finding(code, message, {
  severity = 'INFO',
  refs = [],
  details = null
} = {}) {
  if (typeof code !== 'string' || !code) throw new TypeError('finding code is required');
  if (typeof message !== 'string' || !message) throw new TypeError('finding message is required');
  return normalizeFinding({ code, message, severity, refs, details });
}

export function aggregateVerificationStatus(records) {
  if (records.some(record => record.status === 'REJECTED')) return 'REJECTED';
  if (records.some(record => record.status === 'UNRESOLVED')) return 'UNRESOLVED';
  if (records.some(record => record.status === 'VERIFIED_WITH_LIMITS')) return 'VERIFIED_WITH_LIMITS';
  return 'VERIFIED';
}

function normalizeFinding(value) {
  if (!value || typeof value !== 'object') throw new TypeError('verification finding must be an object');
  const out = {
    code: String(value.code ?? ''),
    message: String(value.message ?? ''),
    severity: String(value.severity ?? 'INFO'),
    refs: [...new Set((value.refs ?? []).map(String))].sort()
  };
  if (!out.code || !out.message) throw new TypeError('verification finding requires code/message');
  if (value.details != null) out.details = structuredClone(value.details);
  return out;
}

function stableStringify(value) {
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key =>
      JSON.stringify(key) + ':' + stableStringify(value[key])
    ).join(',') + '}';
  }
  return JSON.stringify(value);
}
