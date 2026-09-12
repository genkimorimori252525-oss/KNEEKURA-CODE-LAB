import crypto from 'node:crypto';

import {
  ENGINE_IDS,
  validateEngineRunReceipt
} from './contracts.mjs';
import {
  createSanitizedReceipt,
  createSkillDeliveryZip,
  sanitizeDiagnosticText
} from './runtime.mjs';

const EXECUTION_SCHEMA = 'kneekura.code-lab.execution/v1';
const ALL_MODE_SCHEMA = 'kneekura.code-lab.all-mode-bundle/v1';
const COMPARISON_SCHEMA = 'kneekura.code-lab.operational-comparison/v1';
const ZIP_KIND_BY_ENGINE = Object.freeze({
  kneekura: 'KNEEKURA_HUMAN_EXPLORER_ZIP',
  'understand-anything': 'UA_SKILL_ZIP',
  archify: 'ARCHIFY_SKILL_ZIP'
});
const FAILURE_STATUSES = new Set(['FAILED', 'BLOCKED', 'SKIPPED', 'CANCELLED']);

export function composeSealedAllModeBundle({
  runId,
  snapshotId,
  scopeDigest,
  outcomes,
  contextMetadata = null
} = {}) {
  const normalizedRunId = requireText(runId, 'runId');
  const snapshot = requireText(snapshotId, 'snapshotId');
  const scope = requireText(scopeDigest, 'scopeDigest');
  if (!Array.isArray(outcomes) || outcomes.length !== ENGINE_IDS.length) {
    throw codedError('ALL_MODE_ENGINE_SET_INVALID', 'sealed ALL composition requires exactly three engine outcomes');
  }

  const byEngine = new Map();
  for (const raw of outcomes) {
    const engineId = String(raw?.engine_id ?? '');
    if (!ENGINE_IDS.includes(engineId) || byEngine.has(engineId)) {
      throw codedError('ALL_MODE_ENGINE_SET_INVALID', 'sealed ALL composition requires exactly one outcome per engine');
    }
    byEngine.set(engineId, normalizeOutcome(raw, { snapshot, scope }));
  }
  if (!ENGINE_IDS.every(engineId => byEngine.has(engineId))) {
    throw codedError('ALL_MODE_ENGINE_SET_INVALID', 'sealed ALL composition is missing a required engine slot');
  }

  const sealedOutcomes = ENGINE_IDS.map(engineId => byEngine.get(engineId));
  const operationalOutcomes = sealedOutcomes.map(stripPrivateOutcome);
  const semanticContexts = normalizeContextMetadata(contextMetadata);
  const status = computeAllModeStatus(operationalOutcomes);
  const comparison = deepFreeze({
    schema: COMPARISON_SCHEMA,
    mode: 'operational-side-by-side',
    semantic_fusion: false,
    canonical_truth_promotion: false,
    engine_substitution: false,
    snapshot_id: snapshot,
    scope_digest: scope,
    engines: operationalOutcomes.map(outcome => ({
      engine_id: outcome.engine_id,
      status: outcome.status,
      claim_level: outcome.claim_level,
      claim_satisfied: outcome.claim_satisfied,
      sealed_artifact: outcome.sealed_artifact,
      coverage_digest: outcome.coverage_digest,
      error_code: outcome.error?.code ?? null
    }))
  });

  const manifestFields = {
    schema: ALL_MODE_SCHEMA,
    run_id: normalizedRunId,
    snapshot_id: snapshot,
    scope_digest: scope,
    requested_engines: [...ENGINE_IDS],
    status,
    semantic_context_policy: semanticContexts == null
      ? 'fresh-per-engine'
      : 'independent-host-contexts',
    comparison_policy: 'sealed-operational-metadata-only',
    engines: operationalOutcomes
  };
  if (semanticContexts != null) manifestFields.semantic_contexts = semanticContexts;
  const runManifest = deepFreeze(manifestFields);

  const entries = [
    {
      classification: 'RUN_METADATA',
      path: 'run-manifest.json',
      data: stableJson(runManifest)
    },
    {
      classification: 'COMPARISON',
      path: 'comparison/operational.json',
      data: stableJson(comparison)
    }
  ];
  for (const outcome of sealedOutcomes) {
    entries.push({
      classification: 'SANITIZED_RECEIPT',
      path: `engines/${outcome.engine_id}/outcome.json`,
      data: stableJson(stripPrivateOutcome(outcome))
    });
    if (outcome.receipt != null) {
      entries.push({
        classification: 'SANITIZED_RECEIPT',
        path: `engines/${outcome.engine_id}/receipt.json`,
        data: stableJson(outcome.receipt)
      });
    }
    if (outcome.sealed_bytes != null) {
      entries.push({
        classification: 'ENGINE_ARTIFACT',
        path: `engines/${outcome.engine_id}/result.zip`,
        data: outcome.sealed_bytes
      });
    }
  }

  const bundleZip = createSkillDeliveryZip(entries);
  return Object.freeze({
    schema: EXECUTION_SCHEMA,
    kind: 'ALL_MODE_BUNDLE',
    status,
    snapshotId: snapshot,
    scopeDigest: scope,
    runId: normalizedRunId,
    runManifest,
    comparison,
    outcomes: deepFreeze(operationalOutcomes.map(outcome => structuredClone(outcome))),
    bundleZip,
    bundleZipDigest: `sha256:${sha256(bundleZip)}`
  });
}

function normalizeOutcome(raw, { snapshot, scope }) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('sealed ALL outcome must be an object');
  }
  const engineId = String(raw.engine_id ?? '');
  if (!ENGINE_IDS.includes(engineId)) throw codedError('ALL_MODE_ENGINE_SET_INVALID', `unsupported engine outcome: ${engineId}`);
  const attemptId = requireText(raw.attempt_id, `${engineId}.attempt_id`);
  const semanticContextId = requireText(raw.semantic_context_id, `${engineId}.semantic_context_id`);

  if (raw.receipt == null) {
    const status = String(raw.status ?? 'FAILED');
    if (!FAILURE_STATUSES.has(status)) {
      throw codedError('ALL_MODE_OUTCOME_BINDING_MISMATCH', `${engineId} missing receipt for non-failure status ${status}`);
    }
    if (raw.sealed_bytes != null || raw.sealed_artifact != null) {
      throw codedError('ALL_MODE_OUTCOME_BINDING_MISMATCH', `${engineId} failure outcome may not carry a sealed artifact`);
    }
    return {
      engine_id: engineId,
      status,
      claim_level: null,
      claim_satisfied: false,
      attempt_id: attemptId,
      semantic_context_id: semanticContextId,
      sealed_artifact: null,
      coverage_digest: null,
      error: raw.error == null ? null : sanitizeError(raw.error),
      receipt: null,
      sealed_bytes: null
    };
  }

  validateEngineRunReceipt(raw.receipt);
  if (
    raw.receipt.engineId !== engineId ||
    raw.receipt.snapshotId !== snapshot ||
    raw.receipt.scopeDigest !== scope ||
    raw.receipt.attemptId !== attemptId
  ) {
    throw codedError('ALL_MODE_OUTCOME_BINDING_MISMATCH', `${engineId} receipt identity does not match the ALL composition binding`);
  }

  const receipt = createSanitizedReceipt(raw.receipt);
  const sealedBytes = raw.sealed_bytes == null ? null : requireBuffer(raw.sealed_bytes, `${engineId}.sealed_bytes`);
  let sealedArtifact = null;
  if (sealedBytes != null) {
    const computed = `sha256:${sha256(sealedBytes)}`;
    const supplied = normalizeArtifact(raw.sealed_artifact, `${engineId}.sealed_artifact`);
    if (supplied.digest !== computed || supplied.bytes !== sealedBytes.length) {
      throw codedError('ALL_MODE_OUTCOME_BINDING_MISMATCH', `${engineId} sealed artifact metadata does not match exact bytes`);
    }
    const kind = ZIP_KIND_BY_ENGINE[engineId];
    const receiptArtifact = receipt.artifacts.find(candidate => candidate?.kind === kind);
    if (!receiptArtifact || normalizeDigest(receiptArtifact.digest) !== computed || Number(receiptArtifact.bytes) !== sealedBytes.length) {
      throw codedError('ALL_MODE_OUTCOME_BINDING_MISMATCH', `${engineId} receipt does not bind the exact sealed bytes`);
    }
    sealedArtifact = supplied;
  }
  if (['SUCCESS', 'PARTIAL'].includes(receipt.status) && sealedBytes == null) {
    throw codedError('ALL_MODE_OUTCOME_BINDING_MISMATCH', `${engineId} ${receipt.status} outcome requires sealed bytes`);
  }

  return {
    engine_id: engineId,
    status: receipt.status,
    claim_level: receipt.claimLevel,
    claim_satisfied: receipt.claimSatisfied,
    attempt_id: attemptId,
    semantic_context_id: semanticContextId,
    sealed_artifact: sealedArtifact,
    coverage_digest: `sha256:${sha256(Buffer.from(stableJson(receipt.coverage), 'utf8'))}`,
    error: raw.error == null ? null : sanitizeError(raw.error),
    receipt,
    sealed_bytes: sealedBytes
  };
}

function normalizeContextMetadata(value) {
  if (value == null) return null;
  if (!Array.isArray(value) || value.length !== ENGINE_IDS.length) {
    throw codedError('BLOCKED_SEMANTIC_CONTEXT_ISOLATION', 'ALL host context metadata must contain exactly three children');
  }
  const byEngine = new Map();
  const contexts = new Set();
  const issues = new Set();
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('ALL context metadata row must be an object');
    const engineId = String(raw.engine_id ?? '');
    if (!ENGINE_IDS.includes(engineId) || byEngine.has(engineId)) {
      throw codedError('BLOCKED_SEMANTIC_CONTEXT_ISOLATION', 'ALL context metadata must contain exactly one row per engine');
    }
    const contextId = requireText(raw.host_context_id, `${engineId}.host_context_id`);
    const assuranceClass = requireText(raw.assurance_class, `${engineId}.assurance_class`);
    const issueNumber = Number(raw.child_issue_number);
    if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) throw new TypeError(`${engineId}.child_issue_number must be a positive safe integer`);
    if (contexts.has(contextId)) throw codedError('BLOCKED_SEMANTIC_CONTEXT_ISOLATION', 'ALL children must use distinct host semantic contexts');
    if (issues.has(issueNumber)) throw codedError('BLOCKED_SEMANTIC_CONTEXT_ISOLATION', 'ALL children must use distinct child Issues');
    contexts.add(contextId);
    issues.add(issueNumber);
    byEngine.set(engineId, {
      engine_id: engineId,
      host_context_id: contextId,
      assurance_class: assuranceClass,
      child_issue_number: issueNumber
    });
  }
  if (!ENGINE_IDS.every(engineId => byEngine.has(engineId))) {
    throw codedError('BLOCKED_SEMANTIC_CONTEXT_ISOLATION', 'ALL context metadata is missing a required engine');
  }
  return deepFreeze(ENGINE_IDS.map(engineId => byEngine.get(engineId)));
}

function normalizeArtifact(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  const bytes = Number(value.bytes);
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new TypeError(`${label}.bytes must be a non-negative safe integer`);
  return { digest: normalizeDigest(value.digest), bytes };
}

function sanitizeError(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('outcome error must be an object');
  return {
    code: sanitizeDiagnosticText(String(value.code ?? 'ENGINE_EXECUTION_FAILED'), { maxBytes: 256 }),
    message: sanitizeDiagnosticText(String(value.message ?? ''), { maxBytes: 4096 })
  };
}

function stripPrivateOutcome(outcome) {
  return deepFreeze({
    engine_id: outcome.engine_id,
    status: outcome.status,
    claim_level: outcome.claim_level,
    claim_satisfied: outcome.claim_satisfied,
    attempt_id: outcome.attempt_id,
    semantic_context_id: outcome.semantic_context_id,
    sealed_artifact: outcome.sealed_artifact == null ? null : { ...outcome.sealed_artifact },
    coverage_digest: outcome.coverage_digest,
    error: outcome.error == null ? null : { ...outcome.error }
  });
}

function computeAllModeStatus(outcomes) {
  if (outcomes.every(outcome => outcome.status === 'SUCCESS' && outcome.claim_satisfied === true)) return 'SUCCESS';
  if (outcomes.some(outcome => ['SUCCESS', 'PARTIAL'].includes(outcome.status))) return 'PARTIAL';
  return 'FAILED';
}

function normalizeDigest(value) {
  const text = String(value ?? '').trim().toLowerCase();
  const normalized = text.startsWith('sha256:') ? text : `sha256:${text}`;
  if (!/^sha256:[0-9a-f]{64}$/.test(normalized)) throw new TypeError('artifact digest must be sha256:<64 hex>');
  return normalized;
}

function requireBuffer(value, label) {
  if (!Buffer.isBuffer(value)) throw new TypeError(`${label} must be a Buffer`);
  return Buffer.from(value);
}

function stableJson(value) {
  return JSON.stringify(sortObject(value), null, 2) + '\n';
}

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (value && typeof value === 'object' && !Buffer.isBuffer(value)) {
    return Object.fromEntries(Object.keys(value).sort(compareText).map(key => [key, sortObject(value[key])]));
  }
  return value;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function requireText(value, label) {
  const text = String(value ?? '').trim();
  if (!text) throw new TypeError(`${label} must be a non-empty string`);
  return text;
}

function compareText(a, b) {
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Buffer.isBuffer(value) || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}