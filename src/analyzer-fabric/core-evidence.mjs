import { createEvidenceRecord } from '../core/evidence/provider.mjs';
import { createEvidenceLedger, finalizeEvidenceLedger, storeEvidence } from '../core/ledger/evidence-ledger.mjs';

function trustClass(observation) {
  switch (observation.strength) {
    case 'RESOLVED': return 'RESOLVED_SEMANTIC_EVIDENCE';
    case 'EXACT': return 'EXACT_DETERMINISTIC_EVIDENCE';
    case 'RUNTIME_OBSERVED': return 'RUNTIME_OBSERVED_EVIDENCE';
    case 'STRUCTURAL': return 'STRUCTURAL_EVIDENCE';
    case 'HEURISTIC': return 'HEURISTIC_EVIDENCE';
    default: return `FABRIC_${String(observation.strength ?? 'UNKNOWN')}`;
  }
}

export function fabricObservationToCoreEvidence(observation) {
  if (!observation?.snapshot?.repository_id || !observation?.snapshot?.snapshot_id) {
    throw new TypeError('Fabric observation snapshot identity is required');
  }
  const range = observation.source_range?.start_line && observation.source_range?.end_line
    ? {
        start_line: observation.source_range.start_line,
        end_line: observation.source_range.end_line
      }
    : null;
  return createEvidenceRecord({
    kind: 'STATIC_ANALYSIS',
    observation: {
      schema: observation.schema,
      capability: observation.capability,
      observation_type: observation.observation_type,
      subject: structuredClone(observation.subject),
      ...(observation.object ? { object: structuredClone(observation.object) } : {}),
      strength: observation.strength,
      origin: observation.origin,
      ...(observation.source_file ? { source_file: observation.source_file } : {}),
      ...(observation.source_range ? { source_range: structuredClone(observation.source_range) } : {}),
      ...(observation.raw_provider_ref ? { raw_provider_ref: structuredClone(observation.raw_provider_ref) } : {}),
      ...(observation.provider_payload ? { provider_payload: structuredClone(observation.provider_payload) } : {})
    },
    provenance: {
      repository_id: observation.snapshot.repository_id,
      snapshot_id: observation.snapshot.snapshot_id,
      provider_id: observation.provider_id,
      provider_version: observation.provider_version,
      extraction_method: `ANALYZER_FABRIC:${observation.capability}:${observation.observation_type}`,
      ...(observation.source_file ? { path: observation.source_file } : {}),
      ...(range ? { range } : {})
    },
    trustClass: trustClass(observation),
    providerId: observation.provider_id,
    providerVersion: observation.provider_version
  });
}

export function fabricCoverageToCoreCoverage(fabricCoverage, { scopePrefix = 'fabric' } = {}) {
  const entries = [];
  for (const item of fabricCoverage ?? []) {
    const path = item.scope?.path ?? '<repository>';
    let status;
    let reason = null;
    let reasonCode = null;
    if (item.support_status === 'NONE') {
      status = 'SKIPPED';
      reason = item.support_reason ?? 'No provider supports this capability for the selected file.';
      reasonCode = 'NO_PROVIDER_SUPPORT';
    } else if (item.execution_status === 'FAILED') {
      status = 'FAILED';
      reason = item.execution_reason ?? 'All selected providers failed.';
      reasonCode = 'FABRIC_EXECUTION_FAILED';
    } else if (item.execution_status === 'UNEXPLORED') {
      status = 'UNEXPLORED';
      reason = item.execution_reason ?? 'No provider execution receipt exists.';
      reasonCode = 'FABRIC_UNEXPLORED';
    } else if (item.execution_status === 'SKIPPED') {
      status = 'SKIPPED';
      reason = item.execution_reason ?? 'Provider execution was skipped.';
      reasonCode = 'FABRIC_SKIPPED';
    } else if (item.execution_status === 'PARTIAL' || item.support_status === 'PARTIAL') {
      status = 'UNEXPLORED';
      reason = item.execution_reason ?? item.support_reason ?? 'Capability is only partially supported; uncovered cases remain unknown.';
      reasonCode = 'FABRIC_PARTIAL_CAPABILITY';
    } else {
      status = 'ANALYZED';
    }
    entries.push({
      id: `${scopePrefix}:${item.id}`,
      role: 'PRIMARY',
      status,
      path,
      capability: item.capability,
      support_status: item.support_status,
      execution_status: item.execution_status,
      provider_refs: structuredClone(item.provider_refs ?? []),
      ...(reason ? { reason } : {}),
      ...(reasonCode ? { reason_code: reasonCode } : {})
    });
  }
  const hasFailed = entries.some(entry => entry.status === 'FAILED');
  const hasUnknown = entries.some(entry => entry.status === 'UNEXPLORED');
  const completeness = hasFailed ? 'PARTIAL' : hasUnknown ? 'BOUNDED' : 'COMPLETE';
  return {
    schema: 'core.coverage/v1',
    completeness,
    entries
  };
}

export function buildCoreEvidenceLedgerFromFabric({ repositoryId, snapshotId, observations, fabricCoverage }) {
  const coverage = fabricCoverageToCoreCoverage(fabricCoverage);
  const ledger = createEvidenceLedger({
    repositoryIds: [repositoryId],
    snapshotIds: [snapshotId],
    coverage
  });
  const records = (observations ?? []).map(fabricObservationToCoreEvidence);
  storeEvidence(ledger, records);
  return finalizeEvidenceLedger(ledger);
}
