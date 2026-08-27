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
  if (subject == null) throw new TypeError('claim subject is required');
  if (typeof predicate !== 'string' || !predicate.trim()) throw new TypeError('claim predicate is required');
  if (objectOrValue === undefined) throw new TypeError('claim objectOrValue is required');
  if (coverageRef == null || String(coverageRef).trim() === '') throw new TypeError('coverageRef is required');

  const initialStatus = initialStatusFor(type, status);
  const normalizedConfidence = confidence ?? defaultConfidence(type);
  const normalizedEvidenceLinks = canonicalizeLinks(evidenceLinks);
  const normalizedCounterevidenceLinks = canonicalizeLinks(counterevidenceLinks);
  const normalizedDependencyClaimIds = canonicalizeStrings(dependencyClaimIds);
  const normalizedProvenanceRefs = canonicalizeStrings(provenanceRefs);
  const normalizedDerivation = derivation ? structuredClone(derivation) : null;

  const claimIdentity = {
    type,
    subject: structuredClone(subject),
    predicate,
    object_or_value: structuredClone(objectOrValue),
    dependency_claim_ids: normalizedDependencyClaimIds,
    derivation: normalizedDerivation
  };

  const canonicalId = stableClaimId(claimIdentity);
  if (id != null && id !== canonicalId) {
    throw new TypeError('claim id must match the canonical semantic proposition identity');
  }

  const claim = {
    schema: CLAIM_RECORD_SCHEMA,
    id: canonicalId,
    type,
    status: initialStatus,
    subject: structuredClone(subject),
    predicate,
    object_or_value: structuredClone(objectOrValue),
    evidence_links: normalizedEvidenceLinks,
    counterevidence_links: normalizedCounterevidenceLinks,
    dependency_claim_ids: normalizedDependencyClaimIds,
    coverage_ref: String(coverageRef),
    provenance_refs: normalizedProvenanceRefs,
    confidence: structuredClone(normalizedConfidence),
    verifier_results: []
  };

  if (normalizedDerivation) claim.derivation = normalizedDerivation;
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

function canonicalizeLinks(links) {
  return links
    .map(item => structuredClone(item))
    .sort((a, b) =>
      String(a.evidence_id).localeCompare(String(b.evidence_id)) ||
      String(a.role).localeCompare(String(b.role)) ||
      String(a.strength).localeCompare(String(b.strength)) ||
      String(a.rationale ?? '').localeCompare(String(b.rationale ?? ''))
    );
}

function canonicalizeStrings(values) {
  return [...new Set(values.map(String))].sort();
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
