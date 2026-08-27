export const EXPLORATION_LEDGER_SCHEMA = 'core.exploration-ledger/v1';

export function createExplorationLedger({
  snapshotId = null,
  parentSnapshotId = null
} = {}) {
  return {
    schema: EXPLORATION_LEDGER_SCHEMA,
    snapshot_id: snapshotId,
    parent_snapshot_id: parentSnapshotId,
    acquisitions: [],
    invalidations: [],
    metrics: {
      provider_acquisitions: 0,
      provider_reuse_count: 0,
      cache_hits: 0,
      cache_misses: 0
    }
  };
}

export function serializeExplorationLedger(ledger) {
  assertLedger(ledger);
  return structuredClone(ledger);
}

export function restoreExplorationLedger(value, {
  targetSnapshotId = null
} = {}) {
  if (!value || value.schema !== EXPLORATION_LEDGER_SCHEMA) {
    throw new TypeError(EXPLORATION_LEDGER_SCHEMA + ' is required');
  }
  const ledger = structuredClone(value);
  ledger.acquisitions ??= [];
  ledger.invalidations ??= [];
  ledger.metrics ??= {
    provider_acquisitions: 0,
    provider_reuse_count: 0,
    cache_hits: 0,
    cache_misses: 0
  };
  if (targetSnapshotId != null) ledger.snapshot_id = targetSnapshotId;
  for (const entry of ledger.acquisitions) {
    entry.stale = Boolean(entry.stale);
    entry.stale_reasons ??= [];
    entry.dependencies = canonicalRefs(entry.dependencies ?? []);
    entry.evidence_ids = canonicalRefs(entry.evidence_ids ?? []);
  }
  ledger.acquisitions.sort(compareAcquisition);
  return ledger;
}

export function recordProviderAcquisition(ledger, {
  providerId,
  providerVersion,
  dependencyFingerprint,
  cacheFingerprint = null,
  cacheScope = 'SNAPSHOT',
  fidelity = 0,
  dependencies = [],
  result,
  snapshotId = ledger.snapshot_id
}) {
  assertLedger(ledger);
  requireString(providerId, 'providerId');
  requireString(providerVersion, 'providerVersion');
  requireString(dependencyFingerprint, 'dependencyFingerprint');
  if (!['SNAPSHOT','CONTENT'].includes(cacheScope)) {
    throw new TypeError('cacheScope must be SNAPSHOT or CONTENT');
  }
  if (!Number.isFinite(fidelity) || fidelity < 0) {
    throw new TypeError('fidelity must be a non-negative number');
  }

  const entry = {
    provider_id: providerId,
    provider_version: providerVersion,
    dependency_fingerprint: dependencyFingerprint,
    cache_fingerprint: cacheFingerprint,
    cache_scope: cacheScope,
    fidelity,
    dependencies: canonicalRefs(dependencies),
    snapshot_id: snapshotId,
    stale: false,
    stale_reasons: [],
    evidence_ids: (result?.evidence ?? []).map(item => item.id).sort(),
    provider_result: structuredClone(result)
  };

  const existing = ledger.acquisitions.find(item =>
    acquisitionIdentity(item) === acquisitionIdentity(entry)
  );
  if (existing) {
    if (stableStringify(existing.provider_result) !== stableStringify(entry.provider_result)) {
      throw new Error('exploration acquisition identity collision with different result');
    }
    return existing;
  }

  ledger.acquisitions.push(entry);
  ledger.acquisitions.sort(compareAcquisition);
  ledger.metrics.provider_acquisitions += 1;
  return entry;
}

export function findReusableAcquisition(ledger, {
  providerId,
  providerVersion,
  dependencyFingerprint,
  cacheFingerprint = null,
  requiredFidelity = 0,
  allowCrossSnapshot = false,
  targetSnapshotId = ledger.snapshot_id
}) {
  assertLedger(ledger);
  const candidates = ledger.acquisitions.filter(entry => {
    if (entry.stale) return false;
    if (entry.provider_id !== providerId || entry.provider_version !== providerVersion) return false;
    if (entry.fidelity < requiredFidelity) return false;

    const sameSnapshotDependency =
      entry.dependency_fingerprint === dependencyFingerprint &&
      (!targetSnapshotId || !entry.snapshot_id || entry.snapshot_id === targetSnapshotId);
    if (sameSnapshotDependency) return true;

    return Boolean(
      allowCrossSnapshot &&
      entry.cache_scope === 'CONTENT' &&
      cacheFingerprint &&
      entry.cache_fingerprint === cacheFingerprint
    );
  });

  if (!candidates.length) {
    ledger.metrics.cache_misses += 1;
    return null;
  }

  candidates.sort((a, b) =>
    b.fidelity - a.fidelity ||
    compareAcquisition(a, b)
  );
  ledger.metrics.cache_hits += 1;
  ledger.metrics.provider_reuse_count += 1;
  return structuredClone(candidates[0]);
}

export function invalidateExplorationByDependencies(ledger, changedRefs, {
  reason = 'DEPENDENCY_CHANGED'
} = {}) {
  assertLedger(ledger);
  const changed = new Set(canonicalRefs(changedRefs));
  const invalidated = [];

  for (const entry of ledger.acquisitions) {
    if (entry.stale) continue;
    const hit = entry.dependencies.find(ref => changed.has(ref));
    if (!hit) continue;
    entry.stale = true;
    entry.stale_reasons.push({
      reason: String(reason),
      dependency: hit
    });
    invalidated.push(...entry.evidence_ids);
  }

  if (invalidated.length) {
    ledger.invalidations.push({
      reason: String(reason),
      changed_refs: [...changed].sort(),
      evidence_ids: [...new Set(invalidated)].sort()
    });
  }

  return [...new Set(invalidated)].sort();
}

export function evaluateClaimReuse(claim, {
  availableEvidenceIds = [],
  currentCoverageFingerprint = null,
  currentVerifierVersions = null,
  currentRuleVersions = null,
  requireCoverageFingerprint = false,
  requireVerifierVersions = false,
  requireRuleVersions = false
} = {}) {
  if (!claim || typeof claim !== 'object') throw new TypeError('claim is required');
  const reasons = [];
  const available = new Set(availableEvidenceIds.map(String));

  for (const link of [
    ...(claim.evidence_links ?? []),
    ...(claim.counterevidence_links ?? [])
  ]) {
    if (!available.has(link.evidence_id)) {
      reasons.push({
        code: 'EVIDENCE_INVALIDATED',
        ref: link.evidence_id
      });
    }
  }

  if (requireCoverageFingerprint && !currentCoverageFingerprint) {
    reasons.push({
      code: 'COVERAGE_UNVERIFIED_FOR_REUSE'
    });
  } else if (currentCoverageFingerprint) {
    const expected = 'coverage:' + currentCoverageFingerprint;
    if (claim.coverage_ref !== expected) {
      reasons.push({
        code: 'COVERAGE_CHANGED',
        expected,
        actual: claim.coverage_ref
      });
    }
  }

  if (requireVerifierVersions && !currentVerifierVersions && (claim.verifier_results ?? []).length) {
    reasons.push({
      code: 'VERIFIER_DEPENDENCIES_UNVERIFIED'
    });
  } else if (currentVerifierVersions) {
    const versions = currentVerifierVersions instanceof Map
      ? currentVerifierVersions
      : new Map(Object.entries(currentVerifierVersions));
    for (const record of claim.verifier_results ?? []) {
      if (!versions.has(record.verifier_id)) {
        reasons.push({
          code: 'VERIFIER_UNAVAILABLE',
          verifier_id: record.verifier_id,
          previous: record.verifier_version
        });
        continue;
      }
      const current = versions.get(record.verifier_id);
      if (current !== record.verifier_version) {
        reasons.push({
          code: 'VERIFIER_CHANGED',
          verifier_id: record.verifier_id,
          previous: record.verifier_version,
          current
        });
      }
    }
  }

  if (claim.derivation && requireRuleVersions && !currentRuleVersions) {
    reasons.push({
      code: 'RULE_DEPENDENCIES_UNVERIFIED',
      rule_id: claim.derivation.rule_id
    });
  } else if (claim.derivation && currentRuleVersions) {
    const versions = currentRuleVersions instanceof Map
      ? currentRuleVersions
      : new Map(Object.entries(currentRuleVersions));
    if (!versions.has(claim.derivation.rule_id)) {
      reasons.push({
        code: 'RULE_UNAVAILABLE',
        rule_id: claim.derivation.rule_id,
        previous: claim.derivation.rule_version
      });
    } else {
      const current = versions.get(claim.derivation.rule_id);
      if (current !== claim.derivation.rule_version) {
        reasons.push({
          code: 'RULE_CHANGED',
          rule_id: claim.derivation.rule_id,
          previous: claim.derivation.rule_version,
          current
        });
      }
    }
  }

  return {
    reusable: reasons.length === 0,
    reasons
  };
}

export function createChildExplorationLedger(parent, {
  targetSnapshotId,
  reusedEvidenceIds = [],
  invalidatedEvidenceIds = []
}) {
  assertLedger(parent);
  requireString(targetSnapshotId, 'targetSnapshotId');
  const child = createExplorationLedger({
    snapshotId: targetSnapshotId,
    parentSnapshotId: parent.snapshot_id
  });
  const reused = new Set(reusedEvidenceIds.map(String));
  const invalidated = new Set(invalidatedEvidenceIds.map(String));

  child.acquisitions = parent.acquisitions
    .filter(entry =>
      entry.cache_scope === 'CONTENT' &&
      !entry.stale &&
      entry.evidence_ids.some(id => reused.has(id)) &&
      !entry.evidence_ids.some(id => invalidated.has(id))
    )
    .map(entry => ({
      ...structuredClone(entry),
      snapshot_id: targetSnapshotId
    }));
  child.invalidations = invalidated.size ? [{
    reason: 'CHILD_SESSION_INVALIDATION',
    changed_refs: [],
    evidence_ids: [...invalidated].sort()
  }] : [];
  return child;
}

function acquisitionIdentity(entry) {
  return [
    entry.provider_id,
    entry.provider_version,
    entry.dependency_fingerprint,
    entry.cache_fingerprint ?? '',
    entry.snapshot_id ?? '',
    String(entry.fidelity)
  ].join('\0');
}

function compareAcquisition(a, b) {
  return acquisitionIdentity(a).localeCompare(acquisitionIdentity(b));
}

function canonicalRefs(values) {
  return [...new Set((values ?? []).map(String))].sort();
}

function assertLedger(ledger) {
  if (!ledger || ledger.schema !== EXPLORATION_LEDGER_SCHEMA) {
    throw new TypeError(EXPLORATION_LEDGER_SCHEMA + ' is required');
  }
}

function requireString(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(name + ' is required');
  }
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
