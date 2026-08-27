import { evaluateClaimReuse } from './exploration-ledger.mjs';

export const SESSION_CONTINUATION_SCHEMA = 'core.session-continuation/v1';

export function planSessionContinuation({
  parentSession,
  targetSnapshotId,
  availableEvidenceIds = [],
  currentCoverageFingerprint = null,
  currentVerifierVersions = null,
  currentRuleVersions = null,
  currentEngineFingerprint = null,
  currentRuleFingerprints = null
}) {
  if (!parentSession || typeof parentSession !== 'object') {
    throw new TypeError('parentSession is required');
  }
  if (typeof parentSession.session_id !== 'string' || !parentSession.session_id) {
    throw new TypeError('parentSession.session_id is required');
  }
  if (typeof targetSnapshotId !== 'string' || !targetSnapshotId) {
    throw new TypeError('targetSnapshotId is required');
  }

  const available = new Set(availableEvidenceIds.map(String));
  const parentEvidence = new Set((parentSession.evidence_ids ?? []).map(String));
  const reusedEvidenceIds = [...parentEvidence]
    .filter(id => available.has(id))
    .sort();
  const invalidatedEvidenceIds = [...parentEvidence]
    .filter(id => !available.has(id))
    .sort();

  const reusableClaimIds = [];
  const invalidatedClaims = [];
  const sessionReasons = sessionCompatibilityReasons(parentSession, {
    currentEngineFingerprint,
    currentRuleFingerprints
  });

  for (const claim of Object.values(parentSession.claims ?? {}).sort(compareClaim)) {
    const result = evaluateClaimReuse(claim, {
      availableEvidenceIds: reusedEvidenceIds,
      currentCoverageFingerprint,
      currentVerifierVersions,
      currentRuleVersions,
      requireCoverageFingerprint: true,
      requireVerifierVersions: true,
      requireRuleVersions: true
    });
    result.reasons.push(...sessionReasons);
    result.reusable = result.reasons.length === 0;

    if (result.reusable) {
      reusableClaimIds.push(claim.id);
    } else {
      invalidatedClaims.push({
        claim_id: claim.id,
        reasons: result.reasons
      });
    }
  }

  const invalidationReasons = {};
  for (const claim of invalidatedClaims) {
    for (const reason of claim.reasons) {
      const code = String(reason.code ?? 'UNKNOWN');
      invalidationReasons[code] = Number(invalidationReasons[code] ?? 0) + 1;
    }
  }
  if (invalidatedEvidenceIds.length) {
    invalidationReasons.EVIDENCE_NOT_AVAILABLE =
      Number(invalidationReasons.EVIDENCE_NOT_AVAILABLE ?? 0) +
      invalidatedEvidenceIds.length;
  }

  return {
    schema: SESSION_CONTINUATION_SCHEMA,
    parent_session_id: parentSession.session_id,
    parent_snapshot_id:
      parentSession.target_snapshot_id ??
      parentSession.snapshot?.snapshot_id ??
      null,
    target_snapshot_id: targetSnapshotId,
    reused_evidence_ids: reusedEvidenceIds,
    invalidated_evidence_ids: invalidatedEvidenceIds,
    reusable_claim_ids: reusableClaimIds.sort(),
    invalidated_claims: invalidatedClaims.sort((a, b) =>
      a.claim_id.localeCompare(b.claim_id)
    ),
    metrics_delta: {
      invalidation_reasons: invalidationReasons
    }
  };
}

export function assertNoPathOnlyReuse(continuation, parentSession) {
  if (!continuation || continuation.schema !== SESSION_CONTINUATION_SCHEMA) {
    throw new TypeError(SESSION_CONTINUATION_SCHEMA + ' is required');
  }

  const parentEvidence = new Map(
    (parentSession.evidence_records ?? []).map(record => [record.id, record])
  );

  for (const id of continuation.reused_evidence_ids) {
    const record = parentEvidence.get(id);
    if (!record) continue;
    const provenance = record.provenance ?? {};
    const hasContentIdentity = Boolean(
      record.integrity_digest ||
      provenance.artifact_digest ||
      provenance.git_object_id
    );
    if (!hasContentIdentity && provenance.path) {
      throw new Error(
        'cross-snapshot reuse cannot rely on path alone: ' + provenance.path
      );
    }
  }
  return true;
}

function sessionCompatibilityReasons(parentSession, {
  currentEngineFingerprint,
  currentRuleFingerprints
}) {
  const reasons = [];

  if (parentSession.engine_fingerprint) {
    if (!currentEngineFingerprint) {
      reasons.push({ code: 'ENGINE_DEPENDENCY_UNVERIFIED' });
    } else if (currentEngineFingerprint !== parentSession.engine_fingerprint) {
      reasons.push({
        code: 'ENGINE_CHANGED',
        previous: parentSession.engine_fingerprint,
        current: currentEngineFingerprint
      });
    }
  }

  const previousRules = [...new Set((parentSession.rule_fingerprints ?? []).map(String))].sort();
  if (previousRules.length) {
    if (!currentRuleFingerprints) {
      reasons.push({ code: 'RULESET_DEPENDENCIES_UNVERIFIED' });
    } else {
      const currentRules = [...new Set(currentRuleFingerprints.map(String))].sort();
      if (JSON.stringify(previousRules) !== JSON.stringify(currentRules)) {
        reasons.push({
          code: 'RULESET_CHANGED',
          previous: previousRules,
          current: currentRules
        });
      }
    }
  }

  return reasons;
}

function compareClaim(a, b) {
  return String(a?.id ?? '').localeCompare(String(b?.id ?? ''));
}
