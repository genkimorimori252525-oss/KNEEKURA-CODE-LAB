export function evaluateNegativeGate({
  searchedProperty,
  providerId = null,
  graph,
  coverage,
  searchUniverse,
  irrelevantItemIds = [],
  evidenceRecords = [],
  counterevidenceLinks = [],
  currentSnapshotIds = [],
  staleEvidenceIds = [],
  stale = false
}) {
  const property = String(searchedProperty ?? '').trim();
  if (!property) return denied('SEARCHED_PROPERTY_UNSPECIFIED', 'searched property is required');

  const providers = (graph?.meta?.providers ?? []).filter(provider =>
    (!providerId || provider.id === providerId) &&
    provider.capabilities?.supported_properties?.includes(property)
  );
  if (!providers.length) {
    return denied(
      'ANALYZER_UNSUPPORTED',
      'no active provider declares support for searched property ' + property
    );
  }

  const activeProviderIds = new Set(providers.map(provider => provider.id));
  const failures = (graph?.meta?.providerFailures ?? []).filter(failure =>
    activeProviderIds.has(failure.provider_id)
  );
  if (failures.length) {
    return denied(
      'ANALYZER_FAILED',
      'a relevant provider failed while evaluating the searched property',
      { failure_codes: [...new Set(failures.map(failure => failure.code))].sort() }
    );
  }

  if (!searchUniverse || typeof searchUniverse !== 'object') {
    return denied('SEARCH_UNIVERSE_NOT_EXPLICIT', 'negative verification requires an explicit search universe');
  }
  if (typeof searchUniverse.id !== 'string' || !searchUniverse.id.trim()) {
    return denied('SEARCH_UNIVERSE_NOT_EXPLICIT', 'search universe must have a stable id');
  }
  if (searchUniverse.enumerable !== true) {
    return denied('SEARCH_UNIVERSE_NOT_ENUMERABLE', 'search universe must be enumerable');
  }
  if (!Array.isArray(searchUniverse.item_ids)) {
    return denied('SEARCH_UNIVERSE_NOT_EXPLICIT', 'search universe item_ids are required');
  }

  if (!coverage || !Array.isArray(coverage.entries)) {
    return denied('COVERAGE_MISSING', 'negative verification requires Coverage Manifest entries');
  }

  const irrelevant = new Set(irrelevantItemIds);
  const coverageById = new Map(coverage.entries.map(entry => [entry.id, entry]));
  for (const id of searchUniverse.item_ids) {
    const entry = coverageById.get(id);
    if (!entry) {
      return denied(
        'COVERAGE_MISSING_ITEM',
        'search-universe item is not represented in Coverage Manifest',
        { item_id: id }
      );
    }

    if (entry.status === 'FAILED') {
      return denied(
        'ANALYZER_FAILED',
        'relevant coverage item failed analysis',
        { item_id: id, reason: entry.reason ?? null }
      );
    }

    if (['UNEXPLORED','PENDING'].includes(entry.status)) {
      return denied(
        'COVERAGE_GAP',
        'relevant coverage item remains unexplored',
        { item_id: id, status: entry.status, reason: entry.reason ?? null }
      );
    }

    if (entry.status === 'SKIPPED' && !irrelevant.has(id) && entry.proven_irrelevant !== true) {
      return denied(
        'SKIPPED_NOT_PROVEN_IRRELEVANT',
        'skipped search-universe item was not deterministically proven irrelevant',
        { item_id: id }
      );
    }

    if (!['ANALYZED','REUSED','SKIPPED'].includes(entry.status)) {
      return denied(
        'COVERAGE_NOT_TERMINAL',
        'relevant coverage item is not terminally accounted',
        { item_id: id, status: entry.status }
      );
    }
  }

  if (stale) return denied('STALE_SNAPSHOT', 'negative verification context is stale');

  const staleIds = new Set(staleEvidenceIds);
  if (evidenceRecords.some(record => staleIds.has(record.id))) {
    return denied('STALE_EVIDENCE', 'negative verification depends on stale evidence');
  }

  const current = new Set(currentSnapshotIds);
  if (current.size) {
    if (coverage.snapshot_id && !current.has(coverage.snapshot_id)) {
      return denied('STALE_SNAPSHOT', 'Coverage Manifest belongs to a different snapshot');
    }
    for (const record of evidenceRecords) {
      if (!current.has(record.provenance?.snapshot_id)) {
        return denied(
          'STALE_SNAPSHOT',
          'negative verification evidence belongs to a different snapshot',
          { evidence_id: record.id }
        );
      }
    }
  }

  if (counterevidenceLinks.length) {
    return denied(
      'COUNTEREVIDENCE_PRESENT',
      'counterevidence prevents a strong negative claim',
      { evidence_ids: counterevidenceLinks.map(link => link.evidence_id).sort() }
    );
  }

  return {
    allowed: true,
    outcome: 'VERIFIED',
    reason_code: 'NEGATIVE_GATE_PASSED',
    message: 'explicit enumerable universe is fully accounted with supported current-snapshot analysis and no counterevidence',
    provider_ids: [...activeProviderIds].sort(),
    search_universe_id: searchUniverse.id
  };
}

function denied(reasonCode, message, details = null) {
  return {
    allowed: false,
    outcome: 'UNKNOWN',
    reason_code: reasonCode,
    message,
    ...(details ? { details: structuredClone(details) } : {})
  };
}
