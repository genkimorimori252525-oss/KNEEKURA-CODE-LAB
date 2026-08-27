import { evaluateClaimReuse } from './exploration-ledger.mjs';

export const SESSION_CONTINUATION_SCHEMA = 'core.session-continuation/v1';

export function planSessionContinuation({
  parentSession,
  targetSnapshotId,
  availableEvidenceIds = [],
  currentCoverageFingerprint = null,
  currentVerifierVersions = null,
  currentRuleVersions = null
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

  for (const claim of Object.values(parentSession.claims ?? {}).sort(compareClaim)) {
    const result = evaluateClaimReuse(claim, {
      availableEvidenceIds: reusedEvidenceIds,
      currentCoverageFingerprint,
      currentVerifierVersions,
      currentRuleVersions
    });

    if (result.reusable) {
      reusableClaimIds.push(claim.id);
    } else {
      invalidatedClaims.push({
        claim_id: claim.id,
        reasons: result.reasons
      });
    }
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
    )
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

function compareClaim(a, b) {
  return String(a?.id ?? '').localeCompare(String(b?.id ?? ''));
}
