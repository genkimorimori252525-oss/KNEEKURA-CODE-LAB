import crypto from 'node:crypto';
import {
  CLAIM_RECORD_SCHEMA,
  validateClaimRecordV1
} from '../schema/v1.mjs';

const CLAIM_TYPES = new Set([
  'OBSERVED','DERIVED','INFERRED','HYPOTHESIS','NEGATIVE','UNKNOWN'
]);

export function createClaimEvidenceLink({
  evidenceId,
  role = 'SUPPORT',
  strength = 'DIRECT',
  rationale = null
}) {
  if (typeof evidenceId !== 'string' || !evidenceId) throw new TypeError('evidenceId is required');
  const link = {
    evidence_id: evidenceId,
    role,
    strength
  };
  if (rationale) link.rationale = String(rationale);
  return link;
}

export function createClaimRecord({
  id = null,
  type,
  status = null,
  subject,
  predicate,
  objectOrValue,
  evidenceLinks = [],
  counterevidenceLinks = [],
  dependencyClaimIds = [],
  coverageRef,
  provenanceRefs = [],
  confidence = null,
  derivation = null,
  unresolvedReason = null
}) {
  if (!CLAIM_TYPES.has(type)) throw new TypeError('unsupported claim type: ' + type);
  if (typeof predicate !== 'string' || !predicate.trim()) throw new TypeError('claim predicate is required');
  if (coverageRef == null || String(coverageRef).trim() === '') throw new TypeError('coverageRef is required');

  const initialStatus = initialStatusFor(type, status);
  const normalizedConfidence = confidence ?? defaultConfidence(type);

  const claim = {
    schema: CLAIM_RECORD_SCHEMA,
    id: id ?? stableClaimId({
      type,
      subject,
      predicate,
      object_or_value: objectOrValue,
      evidence_links: evidenceLinks,
      counterevidence_links: counterevidenceLinks,
      dependency_claim_ids: dependencyClaimIds,
      coverage_ref: coverageRef,
      provenance_refs: provenanceRefs,
      derivation
    }),
    type,
    status: initialStatus,
    subject: structuredClone(subject),
    predicate,
    object_or_value: structuredClone(objectOrValue),
    evidence_links: evidenceLinks.map(item => structuredClone(item)),
    counterevidence_links: counterevidenceLinks.map(item => structuredClone(item)),
    dependency_claim_ids: [...dependencyClaimIds],
    coverage_ref: String(coverageRef),
    provenance_refs: [...provenanceRefs],
    confidence: structuredClone(normalizedConfidence),
    verifier_results: []
  };

  if (derivation) claim.derivation = structuredClone(derivation);
  if (type === 'UNKNOWN') claim.unresolved_reason = String(unresolvedReason ?? '').trim();

  validateConstructionRules(claim);
  validateClaimRecordV1(claim);
  return claim;
}

export function applyVerificationResult(claim, {
  status,
  verifierResults,
  confidence = null
}) {
  const next = structuredClone(claim);
  next.status = status;
  next.verifier_results = verifierResults.map(item => structuredClone(item));
  if (confidence) next.confidence = structuredClone(confidence);
  validateClaimRecordV1(next);
  return next;
}

export function stableClaimId(value) {
  return 'claim:sha256:' + crypto.createHash('sha256')
    .update(stableStringify(value))
    .digest('hex');
}

function initialStatusFor(type, requested) {
  if (type === 'UNKNOWN') {
    if (requested != null && requested !== 'UNRESOLVED') {
      throw new TypeError('UNKNOWN claims must begin UNRESOLVED');
    }
    return 'UNRESOLVED';
  }

  if (['INFERRED','HYPOTHESIS','NEGATIVE'].includes(type)) {
    if (requested != null && requested !== 'PROPOSED') {
      throw new TypeError(type + ' claims must begin PROPOSED');
    }
    return 'PROPOSED';
  }

  if (requested != null && requested !== 'PROPOSED') {
    throw new TypeError(type + ' claims must begin PROPOSED before verification');
  }
  return 'PROPOSED';
}

function validateConstructionRules(claim) {
  if (claim.type === 'OBSERVED') {
    const direct = claim.evidence_links.some(link =>
      link.role === 'SUPPORT' && link.strength === 'DIRECT'
    );
    if (!direct) throw new TypeError('OBSERVED claim construction requires DIRECT SUPPORT evidence');
  }

  if (claim.type === 'DERIVED') {
    if (!claim.dependency_claim_ids.length) {
      throw new TypeError('DERIVED claim construction requires dependency claims');
    }
    if (!claim.derivation?.rule_id || !claim.derivation?.rule_version) {
      throw new TypeError('DERIVED claim construction requires derivation rule id/version');
    }
  }

  if (claim.type === 'UNKNOWN' && !claim.unresolved_reason) {
    throw new TypeError('UNKNOWN claim construction requires unresolvedReason');
  }
}

function defaultConfidence(type) {
  if (type === 'OBSERVED') {
    return { level: 'HIGH', rationale: 'direct evidence awaits verifier confirmation' };
  }
  if (type === 'DERIVED') {
    return { level: 'HIGH', rationale: 'deterministic derivation awaits verifier confirmation' };
  }
  if (type === 'UNKNOWN') {
    return { level: 'LOW', rationale: 'claim is explicitly unresolved' };
  }
  return { level: 'LOW', rationale: 'proposal awaits verification' };
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
