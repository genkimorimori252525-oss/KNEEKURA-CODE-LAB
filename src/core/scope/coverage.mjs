import crypto from 'node:crypto';
import { validateCoverageManifestV1 } from '../schema/v1.mjs';

export const COVERAGE_ROLES = Object.freeze([
  'PRIMARY',
  'DEPENDENCY',
  'SUPPORTING_CONTEXT',
  'RUNTIME_ARTIFACT'
]);

export const COVERAGE_STATUSES = Object.freeze([
  'PENDING',
  'ANALYZED',
  'REUSED',
  'SKIPPED',
  'FAILED',
  'UNEXPLORED'
]);

const ROLE_SET = new Set(COVERAGE_ROLES);
const STATUS_SET = new Set(COVERAGE_STATUSES);

export function createCoverageManifest(items, {
  universeEnumerable = true,
  closure = { kind: 'FULL', boundary_reached: false },
  snapshotId = null
} = {}) {
  if (!Array.isArray(items)) throw new TypeError('coverage items must be an array');
  const seen = new Set();
  const entries = items.map((item, index) => {
    if (!item || typeof item !== 'object') throw new TypeError('coverage item must be an object');
    const id = String(item.id ?? '').trim();
    if (!id) throw new TypeError('coverage item id is required');
    if (seen.has(id)) throw new TypeError('duplicate coverage item id: ' + id);
    seen.add(id);

    const role = item.role ?? 'SUPPORTING_CONTEXT';
    if (!ROLE_SET.has(role)) throw new TypeError('invalid coverage role: ' + role);
    const status = item.status ?? 'PENDING';
    if (!STATUS_SET.has(status)) throw new TypeError('invalid coverage status: ' + status);

    const entry = {
      id,
      role,
      status,
      ...(item.kind ? { kind: item.kind } : {}),
      ...(item.node_id ? { node_id: item.node_id } : {}),
      ...(item.evidence_id ? { evidence_id: item.evidence_id } : {}),
      ...(item.path ? { path: item.path } : {}),
      ...(item.label ? { label: item.label } : {}),
      ...(item.reason ? { reason: item.reason } : {}),
      ...(item.reason_code ? { reason_code: item.reason_code } : {}),
      ...(Number.isInteger(item.depth) ? { depth: item.depth } : {}),
      order: index
    };

    if (['SKIPPED','FAILED','UNEXPLORED'].includes(status) && !entry.reason) {
      entry.reason = defaultReason(status);
    }
    return entry;
  });

  return {
    schema: 'core.coverage/v1',
    completeness: 'UNKNOWN',
    entries,
    universe_enumerable: Boolean(universeEnumerable),
    closure: structuredClone(closure ?? { kind: 'FULL', boundary_reached: false }),
    ...(snapshotId ? { snapshot_id: snapshotId } : {})
  };
}

export function updateCoverageEntry(manifest, id, status, {
  reason = null,
  reasonCode = null
} = {}) {
  if (!STATUS_SET.has(status)) throw new TypeError('invalid coverage status: ' + status);
  const entry = manifest.entries.find(item => item.id === id);
  if (!entry) throw new Error('coverage entry not found: ' + id);
  entry.status = status;
  if (reason) entry.reason = String(reason);
  else if (['SKIPPED','FAILED','UNEXPLORED'].includes(status)) entry.reason = entry.reason ?? defaultReason(status);
  else delete entry.reason;

  if (reasonCode) entry.reason_code = String(reasonCode);
  else if (!['SKIPPED','FAILED','UNEXPLORED'].includes(status)) delete entry.reason_code;
  return entry;
}

export function accountCoverageFromGraph(manifest, graph) {
  const next = structuredClone(manifest);
  const nodeIds = new Set((graph.nodes ?? []).map(node => node.id));
  const evidenceIds = new Set((graph.meta?.evidence ?? []).map(record => record.id));
  const failures = graph.meta?.providerFailures ?? [];

  for (const entry of next.entries) {
    if (entry.status !== 'PENDING') continue;

    const matchingFailure = failures.find(failure =>
      entry.path &&
      failure.unit_ref &&
      normalizeRef(failure.unit_ref) === normalizeRef(entry.path)
    );
    if (matchingFailure) {
      updateCoverageEntry(next, entry.id, 'FAILED', {
        reason: 'provider failure: ' + matchingFailure.code,
        reasonCode: matchingFailure.code
      });
      continue;
    }

    if (entry.node_id && nodeIds.has(entry.node_id)) {
      updateCoverageEntry(next, entry.id, 'ANALYZED');
      continue;
    }
    if (entry.evidence_id && evidenceIds.has(entry.evidence_id)) {
      updateCoverageEntry(next, entry.id, 'ANALYZED');
      continue;
    }

    updateCoverageEntry(next, entry.id, 'UNEXPLORED', {
      reason: 'selected item was not accounted by the analyzed graph',
      reasonCode: 'NOT_ACCOUNTED'
    });
  }
  return next;
}

export function finalizeCoverage(manifest) {
  const next = structuredClone(manifest);

  for (const entry of next.entries) {
    if (entry.status === 'PENDING') {
      updateCoverageEntry(next, entry.id, 'UNEXPLORED', {
        reason: 'coverage finalization backstop: selected item remained pending',
        reasonCode: 'FINALIZE_BACKSTOP'
      });
    }
  }

  const statuses = next.entries.map(entry => entry.status);
  const unexplored = next.entries.filter(entry => entry.status === 'UNEXPLORED');
  const hasFailure = statuses.includes('FAILED');

  if (!next.universe_enumerable) {
    next.completeness = 'UNKNOWN';
  } else if (hasFailure) {
    next.completeness = 'PARTIAL';
  } else if (unexplored.length) {
    const onlyDepthBoundary = unexplored.every(entry => entry.reason_code === 'DEPTH_HORIZON');
    next.completeness = onlyDepthBoundary ? 'BOUNDED' : 'PARTIAL';
  } else if (next.closure?.kind === 'DEPTH_HORIZON' && next.closure?.boundary_reached) {
    next.completeness = 'BOUNDED';
  } else {
    next.completeness = 'COMPLETE';
  }

  next.fingerprint = coverageFingerprint(next);
  validateCoverageManifestV1(next);
  return next;
}

export function coverageFingerprint(manifest) {
  const basis = {
    schema: manifest.schema,
    completeness: manifest.completeness,
    universe_enumerable: manifest.universe_enumerable,
    closure: manifest.closure,
    entries: manifest.entries.map(entry => ({
      id: entry.id,
      role: entry.role,
      status: entry.status,
      reason: entry.reason ?? null,
      reason_code: entry.reason_code ?? null
    }))
  };
  return 'sha256:' + crypto.createHash('sha256').update(stableStringify(basis)).digest('hex');
}

export function assertCoveragePartition(manifest, expectedIds) {
  const expected = new Set(expectedIds);
  const actual = new Set(manifest.entries.map(entry => entry.id));
  if (expected.size !== actual.size) throw new Error('coverage partition size mismatch');
  for (const id of expected) if (!actual.has(id)) throw new Error('coverage missing item: ' + id);
  for (const entry of manifest.entries) {
    if (entry.status === 'PENDING') throw new Error('coverage contains pending item: ' + entry.id);
  }
  return true;
}

function defaultReason(status) {
  if (status === 'SKIPPED') return 'item was deterministically skipped';
  if (status === 'FAILED') return 'analysis failed for this item';
  return 'item was not explored';
}

function normalizeRef(value) {
  return String(value).replaceAll('\\', '/').replace(/^artifact:[^:]+:/, '');
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
