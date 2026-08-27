import crypto from 'node:crypto';

export const CACHE_TIERS = Object.freeze(['C0','C1','C2','C3','C4']);

export function contentDigest(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  return 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex');
}

export function dependencyFingerprint(dependencies = []) {
  return digestObject(canonicalDependencies(dependencies));
}

export function cacheKey(tier, basis) {
  if (!CACHE_TIERS.includes(tier)) throw new TypeError('invalid cache tier: ' + tier);
  return tier.toLowerCase() + ':sha256:' + digestObject({
    tier,
    basis: canonicalValue(basis)
  }).slice('sha256:'.length);
}

export function c0BlobKey(value) {
  return 'c0:' + contentDigest(value);
}

export function c1ArtifactKey({
  content_digest,
  provider_id,
  provider_version,
  analyzer_config_fingerprint = 'config:none',
  dependencies = []
}) {
  requireString(content_digest, 'content_digest');
  requireString(provider_id, 'provider_id');
  requireString(provider_version, 'provider_version');
  return cacheKey('C1', {
    content_digest,
    provider_id,
    provider_version,
    analyzer_config_fingerprint,
    dependencies: canonicalDependencies(dependencies)
  });
}

export function c2GraphKey({
  snapshot_id,
  provider_dependencies = [],
  ontology_fingerprint = 'ontology:none'
}) {
  requireString(snapshot_id, 'snapshot_id');
  return cacheKey('C2', {
    snapshot_id,
    provider_dependencies: canonicalDependencies(provider_dependencies),
    ontology_fingerprint
  });
}

export function c3PlanningKey({
  snapshot_id,
  normalized_seeds,
  planner_version,
  mode = null,
  policy = null,
  graph_dependency = null,
  rule_dependency = null
}) {
  requireString(snapshot_id, 'snapshot_id');
  requireString(planner_version, 'planner_version');
  return cacheKey('C3', {
    snapshot_id,
    normalized_seeds: canonicalValue(normalized_seeds),
    planner_version,
    mode,
    policy,
    graph_dependency,
    rule_dependency
  });
}

export function c4AnalysisKey({
  snapshot_id,
  normalized_request,
  engine_fingerprint,
  rule_dependencies = [],
  runtime_dependencies = [],
  reasoning_dependency = null
}) {
  requireString(snapshot_id, 'snapshot_id');
  requireString(engine_fingerprint, 'engine_fingerprint');
  return cacheKey('C4', {
    snapshot_id,
    normalized_request: canonicalValue(normalized_request),
    engine_fingerprint,
    rule_dependencies: canonicalDependencies(rule_dependencies),
    runtime_dependencies: canonicalDependencies(runtime_dependencies),
    reasoning_dependency
  });
}

export function verifiedClaimDependencies({
  evidence_ids = [],
  coverage_fingerprint,
  verifier_versions = [],
  rule_dependencies = []
}) {
  requireString(coverage_fingerprint, 'coverage_fingerprint');
  return canonicalDependencies([
    ...evidence_ids.map(id => ({ kind: 'evidence', id })),
    { kind: 'coverage', id: coverage_fingerprint },
    ...verifier_versions.map(id => ({ kind: 'verifier', id })),
    ...rule_dependencies.map(id => (
      typeof id === 'string' ? { kind: 'rule', id } : id
    ))
  ]);
}

export function canonicalDependencies(dependencies = []) {
  if (!Array.isArray(dependencies)) throw new TypeError('dependencies must be an array');
  const rows = dependencies.map((dependency, index) => {
    if (typeof dependency === 'string') {
      return { kind: 'ref', id: dependency };
    }
    if (!dependency || typeof dependency !== 'object' || Array.isArray(dependency)) {
      throw new TypeError('dependency at index ' + index + ' must be a string or object');
    }
    const normalized = canonicalValue(dependency);
    if (!normalized.kind) normalized.kind = 'ref';
    return normalized;
  });
  const unique = new Map(rows.map(row => [stableStringify(row), row]));
  return [...unique.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, row]) => row);
}

export function digestObject(value) {
  return 'sha256:' + crypto.createHash('sha256')
    .update(stableStringify(canonicalValue(value)))
    .digest('hex');
}

export function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      const item = value[key];
      if (item !== undefined) out[key] = canonicalValue(item);
    }
    return out;
  }
  return value;
}

export function stableStringify(value) {
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key =>
      JSON.stringify(key) + ':' + stableStringify(value[key])
    ).join(',') + '}';
  }
  return JSON.stringify(value);
}

function requireString(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(name + ' is required');
  }
}
