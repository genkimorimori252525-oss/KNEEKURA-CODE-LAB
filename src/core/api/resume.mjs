import {
  planSessionContinuation
} from '../session/resume.mjs';

export const SESSION_HANDLE_SCHEMA = 'core.session-handle/v1';

export async function resumeAnalysisSession({
  sessionStore,
  sessionId,
  targetSnapshotId = null,
  currentEngineFingerprint
}) {
  if (!sessionStore?.replay) {
    throw new TypeError(
      'core.session.resume requires a configured persistent session store'
    );
  }
  if (typeof sessionId !== 'string' || !sessionId) {
    throw new TypeError('sessionId is required');
  }

  const parent = await sessionStore.replay(sessionId);
  if (!parent.finalized) {
    throw new Error('only finalized AnalysisSessions can be resumed');
  }

  const target =
    targetSnapshotId ??
    parent.target_snapshot_id ??
    parent.snapshot?.snapshot_id;
  if (typeof target !== 'string' || !target) {
    throw new Error('resume target snapshot cannot be resolved');
  }

  const sameSnapshot = target === parent.target_snapshot_id;
  let explorationAvailable = false;
  let availableEvidenceIds = [];

  if (sameSnapshot && typeof sessionStore.readExplorationLedger === 'function') {
    try {
      const exploration = await sessionStore.readExplorationLedger(
        sessionId,
        { targetSnapshotId: target }
      );
      explorationAvailable = true;
      availableEvidenceIds = explorationEvidenceIds(exploration);
    } catch {
      explorationAvailable = false;
      availableEvidenceIds = [];
    }
  }

  const currentVerifierVersions = sameSnapshot
    ? verifierVersionsFromClaims(parent.claims)
    : null;
  const currentRuleVersions = sameSnapshot
    ? derivationRuleVersionsFromClaims(parent.claims)
    : null;

  const continuation = planSessionContinuation({
    parentSession: parent,
    targetSnapshotId: target,
    availableEvidenceIds: sameSnapshot
      ? availableEvidenceIds
      : [],
    currentCoverageFingerprint: sameSnapshot
      ? parent.coverage?.fingerprint ?? null
      : null,
    currentVerifierVersions,
    currentRuleVersions,
    currentEngineFingerprint,
    currentRuleFingerprints: sameSnapshot
      ? parent.rule_fingerprints ?? []
      : null
  });

  return {
    schema: SESSION_HANDLE_SCHEMA,
    session_id: sessionId,
    target_snapshot_id: target,
    mode: sameSnapshot
      ? 'SAME_SNAPSHOT'
      : 'CROSS_SNAPSHOT_REVALIDATION',
    reusable_evidence_ids: continuation.reused_evidence_ids,
    invalidated_evidence_ids: continuation.invalidated_evidence_ids,
    reusable_claim_ids: continuation.reusable_claim_ids,
    invalidated_claims: continuation.invalidated_claims,
    exploration_state_available: explorationAvailable,
    requires_reanalysis:
      !sameSnapshot ||
      continuation.invalidated_evidence_ids.length > 0 ||
      continuation.invalidated_claims.length > 0
  };
}

function explorationEvidenceIds(exploration) {
  const ids = [];
  for (const acquisition of exploration?.acquisitions ?? []) {
    if (acquisition.stale) continue;
    for (const id of acquisition.evidence_ids ?? []) ids.push(String(id));
  }
  return [...new Set(ids)].sort();
}

function verifierVersionsFromClaims(claims) {
  const versions = {};
  for (const claim of Object.values(claims ?? {})) {
    for (const record of claim.verifier_results ?? []) {
      if (!record?.verifier_id || !record?.verifier_version) continue;
      const previous = versions[record.verifier_id];
      if (
        previous != null &&
        previous !== record.verifier_version
      ) {
        throw new Error(
          'parent session contains conflicting verifier versions for ' +
          record.verifier_id
        );
      }
      versions[record.verifier_id] = record.verifier_version;
    }
  }
  return versions;
}

function derivationRuleVersionsFromClaims(claims) {
  const versions = {};
  for (const claim of Object.values(claims ?? {})) {
    const derivation = claim.derivation;
    if (!derivation?.rule_id || !derivation?.rule_version) continue;
    const previous = versions[derivation.rule_id];
    if (
      previous != null &&
      previous !== derivation.rule_version
    ) {
      throw new Error(
        'parent session contains conflicting derivation rule versions for ' +
        derivation.rule_id
      );
    }
    versions[derivation.rule_id] = derivation.rule_version;
  }
  return versions;
}
