import { canonicalizeGraphForSnapshot } from '../core/graph.mjs';
import { EVIDENCE_PACK_SCHEMA, stableDigest } from './schema.mjs';

export function createHumanAnalysisEvidencePack({
  repository,
  snapshot,
  graph = { nodes: [], edges: [] },
  result = { claims: [], unknowns: [], coverage: { completeness: 'UNKNOWN', entries: [] } },
  evidence = [],
  source_catalog = []
}) {
  const repositoryId = String(repository?.repository_id ?? repository?.repositoryId ?? '').trim();
  const snapshotId = String(snapshot?.snapshot_id ?? snapshot?.snapshotId ?? '').trim();
  if (!repositoryId || !snapshotId) throw new TypeError('repository/snapshot identity is required');
  if (!Array.isArray(graph?.nodes) || !Array.isArray(graph?.edges)) throw new TypeError('graph nodes/edges are required');
  const claims = Array.isArray(result?.claims) ? result.claims : [];
  const unknowns = Array.isArray(result?.unknowns) ? result.unknowns : [];
  const coverage = result?.coverage && Array.isArray(result.coverage.entries)
    ? result.coverage
    : { completeness: 'UNKNOWN', entries: [] };
  if (!Array.isArray(evidence)) throw new TypeError('evidence must be an array');
  if (!Array.isArray(source_catalog)) throw new TypeError('source_catalog must be an array');

  const canonical = {
    graph: canonicalizeGraphForSnapshot(graph),
    result: {
      claims: structuredClone(claims),
      unknowns: structuredClone(unknowns),
      coverage: structuredClone(coverage)
    },
    evidence: structuredClone(evidence)
  };
  const indexes = buildIndexes(canonical);
  const catalog = normalizeSourceCatalog(source_catalog);
  const packCore = {
    schema: EVIDENCE_PACK_SCHEMA,
    repository: { repository_id: repositoryId, snapshot_id: snapshotId },
    canonical,
    source_catalog: catalog,
    indexes,
    trust_boundary: {
      repository_content_instruction_authority: false,
      canonical_authority: 'KNEEKURA_CORE_REGISTERED_ANALYZERS_AND_RUNTIME_EVIDENCE',
      semantic_authoring_authority: 'AI_INTERPRETATION_ONLY'
    }
  };
  const canonicalDigest = stableDigest(canonical);
  const packId = 'evidence-pack:' + stableDigest({ repositoryId, snapshotId, canonicalDigest, catalog }).slice('sha256:'.length);
  return deepFreeze({
    ...packCore,
    pack_id: packId,
    canonical_digest: canonicalDigest,
    pack_digest: stableDigest(packCore)
  });
}

export function assertEvidencePackUnchanged(pack, expectedCanonicalDigest) {
  const actual = stableDigest(pack.canonical);
  if (actual !== expectedCanonicalDigest || pack.canonical_digest !== expectedCanonicalDigest) {
    throw new TypeError('canonical evidence pack mutated during semantic authoring');
  }
  return true;
}

function buildIndexes(canonical) {
  return {
    evidence_ids: canonical.evidence.map(item => item?.id).filter(Boolean).map(String).sort(),
    claim_ids: canonical.result.claims.map(item => item?.id).filter(Boolean).map(String).sort(),
    coverage_ids: canonical.result.coverage.entries.map(item => item?.id).filter(Boolean).map(String).sort(),
    unknown_ids: canonical.result.unknowns.map(item => item?.id ?? item?.ref).filter(Boolean).map(String).sort(),
    node_ids: canonical.graph.nodes.map(item => item?.id).filter(Boolean).map(String).sort(),
    edge_ids: canonical.graph.edges.map(item => item?.id).filter(Boolean).map(String).sort()
  };
}

function normalizeSourceCatalog(entries) {
  const seen = new Set();
  return entries.map(entry => {
    const path = normalizeRepoPath(entry?.path);
    if (seen.has(path)) throw new TypeError(`duplicate source path: ${path}`);
    seen.add(path);
    const contentDigest = String(entry?.content_digest ?? '');
    if (!contentDigest.startsWith('sha256:')) throw new TypeError(`source catalog content_digest is required for ${path}`);
    return {
      path,
      content_digest: contentDigest,
      line_count: Number.isInteger(entry?.line_count) ? entry.line_count : null
    };
  }).sort((a, b) => a.path.localeCompare(b.path));
}

function normalizeRepoPath(value) {
  const path = String(value ?? '').replaceAll('\\', '/').replace(/^\.\//, '');
  if (!path || path.startsWith('/') || /^[A-Za-z]:\//.test(path) || path.split('/').includes('..')) {
    throw new TypeError(`unsafe repository source path: ${value}`);
  }
  return path;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}