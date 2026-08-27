import crypto from 'node:crypto';

const PRECEDENCE = Object.freeze({
  builtin: 1,
  global: 2,
  workspace: 2,
  repository: 3,
  request: 4
});

export const BUILTIN_RULES = Object.freeze([
  {
    rule_id: 'core.java.structural',
    version: 'v1',
    source_class: 'builtin',
    trust: 'ENGINE_TRUSTED',
    selectors: { languages: ['java'] },
    content_reference: 'builtin:java-structural-v1'
  },
  {
    rule_id: 'core.forge.network-semantics',
    version: 'v1',
    source_class: 'builtin',
    trust: 'ENGINE_TRUSTED',
    selectors: { platforms: ['forge'] },
    content_reference: 'builtin:forge-network-semantics-v1'
  },
  {
    rule_id: 'core.ysm.semantic-contracts',
    version: 'v1',
    source_class: 'builtin',
    trust: 'ENGINE_TRUSTED',
    selectors: { node_kinds: ['molang_variable','animation_name','bone_name'] },
    content_reference: 'builtin:ysm-semantic-contracts-v1'
  },
  {
    rule_id: 'core.runtime.static-separation',
    version: 'v1',
    source_class: 'builtin',
    trust: 'ENGINE_TRUSTED',
    selectors: { evidence_kinds: ['RUNTIME'] },
    content_reference: 'builtin:runtime-static-separation-v1'
  }
]);

export function resolveRules({
  graph,
  request = {},
  scope,
  repositoryRules = [],
  workspaceRules = [],
  globalRules = [],
  builtinRules = BUILTIN_RULES
}) {
  const context = buildContext(graph, request, scope);
  const candidates = [
    ...normalizeRules(builtinRules, 'builtin'),
    ...normalizeRules(globalRules, 'global'),
    ...normalizeRules(workspaceRules, 'workspace'),
    ...normalizeRules(repositoryRules.length ? repositoryRules : (graph.meta?.rules ?? []), 'repository'),
    ...normalizeRules(request.ruleset_overrides ?? [], 'request')
  ];

  const decorated = candidates.map(rule => ({
    ...rule,
    precedence: PRECEDENCE[rule.source_class] ?? 0,
    rule_hash: ruleHash(rule)
  })).sort(compareRules);

  const applied = [];
  const rejected = [];
  const seenRuleIds = new Set();

  for (const rule of decorated) {
    if (seenRuleIds.has(rule.rule_id)) {
      rejected.push(resultRule(rule, false, 'shadowed by higher-precedence rule with same rule_id'));
      continue;
    }

    const match = matchSelectors(rule.selectors ?? {}, context);
    if (!match.applies) {
      rejected.push(resultRule(rule, false, match.reason));
      continue;
    }

    seenRuleIds.add(rule.rule_id);
    applied.push(resultRule(rule, true, match.reason));
  }

  const resolution = {
    applied,
    rejected,
    context_summary: {
      mode: context.mode,
      languages: [...context.languages].sort(),
      platforms: [...context.platforms].sort(),
      node_kinds: [...context.nodeKinds].sort(),
      edge_kinds: [...context.edgeKinds].sort(),
      evidence_kinds: [...context.evidenceKinds].sort()
    }
  };
  resolution.resolution_fingerprint = digestObject({
    applied: applied.map(rule => [rule.rule_id, rule.version, rule.rule_hash, rule.precedence]),
    rejected: rejected.map(rule => [rule.rule_id, rule.version, rule.rule_hash, rule.reason])
  });
  return resolution;
}

export function ruleMatchesNode(rule, node) {
  const selectors = rule.selectors ?? {};
  if (selectors.languages?.length && !selectors.languages.includes(node.language)) return false;
  if (selectors.node_kinds?.length && !selectors.node_kinds.includes(node.kind)) return false;
  if (selectors.paths?.length && !selectors.paths.some(pattern => pathMatches(node.path, pattern))) return false;
  return true;
}

function buildContext(graph, request, scope) {
  const selectedNodeIds = new Set(
    (scope?.items ?? [])
      .filter(item => item.selected !== false && item.node_id)
      .map(item => item.node_id)
  );
  const selectedNodes = selectedNodeIds.size
    ? graph.nodes.filter(node => selectedNodeIds.has(node.id))
    : graph.nodes;

  const languages = new Set(selectedNodes.map(node => node.language).filter(Boolean));
  const paths = new Set(selectedNodes.map(node => node.path).filter(Boolean));
  const nodeKinds = new Set(selectedNodes.map(node => node.kind).filter(Boolean));
  const edgeKinds = new Set(
    graph.edges
      .filter(edge => !selectedNodeIds.size || selectedNodeIds.has(edge.from) || selectedNodeIds.has(edge.to))
      .map(edge => edge.type)
  );
  const evidenceRecords = graph.meta?.evidence ?? [];
  const selectedEvidenceIds = new Set(
    (scope?.items ?? [])
      .filter(item => item.selected !== false && item.evidence_id)
      .map(item => item.evidence_id)
  );
  const runtimeRefs = new Set();
  for (const node of selectedNodes) {
    for (const value of [
      node.runtime_run_id,
      node.run,
      node.artifact_id,
      node.artifactId,
      node.artifact_digest,
      node.artifactDigest
    ]) {
      if (value != null) runtimeRefs.add(String(value));
    }
  }
  const scopedEvidence = scope?.items
    ? evidenceRecords.filter(record =>
        evidenceInScope(record, selectedEvidenceIds, paths, runtimeRefs)
      )
    : evidenceRecords;
  const evidenceKinds = new Set(scopedEvidence.map(record => record.kind).filter(Boolean));
  const riskTags = new Set();
  for (const node of selectedNodes) {
    for (const tag of node.riskTags ?? node.risk_tags ?? []) riskTags.add(tag);
    if (node.riskTag) riskTags.add(node.riskTag);
  }

  const platforms = new Set();
  const loader = graph.meta?.platform?.detected?.loader;
  if (loader) platforms.add(loader);
  const profileKey = graph.meta?.platform?.primaryTarget?.key;
  if (profileKey) platforms.add(profileKey);

  return {
    mode: request.mode ?? 'UNDERSTAND',
    languages,
    platforms,
    paths,
    nodeKinds,
    edgeKinds,
    evidenceKinds,
    riskTags
  };
}

function evidenceInScope(record, selectedEvidenceIds, selectedPaths, runtimeRefs) {
  if (selectedEvidenceIds.has(record.id)) return true;
  const provenance = record.provenance ?? {};
  if (provenance.path && selectedPaths.has(provenance.path)) return true;
  for (const value of [
    provenance.runtime_run_id,
    provenance.artifact_id,
    provenance.artifact_digest
  ]) {
    if (value != null && runtimeRefs.has(String(value))) return true;
  }
  return false;
}

function matchSelectors(selectors, context) {
  const checks = [];
  if (selectors.modes?.length) checks.push(['mode', selectors.modes.includes(context.mode)]);
  if (selectors.languages?.length) checks.push(['language', overlaps(selectors.languages, context.languages)]);
  if (selectors.platforms?.length) checks.push(['platform', overlaps(selectors.platforms, context.platforms)]);
  if (selectors.paths?.length) checks.push(['path', [...context.paths].some(path => selectors.paths.some(pattern => pathMatches(path, pattern)))]);
  if (selectors.node_kinds?.length) checks.push(['node kind', overlaps(selectors.node_kinds, context.nodeKinds)]);
  if (selectors.edge_kinds?.length) checks.push(['edge kind', overlaps(selectors.edge_kinds, context.edgeKinds)]);
  if (selectors.evidence_kinds?.length) checks.push(['evidence kind', overlaps(selectors.evidence_kinds, context.evidenceKinds)]);
  if (selectors.risk_tags?.length) checks.push(['risk tag', overlaps(selectors.risk_tags, context.riskTags)]);

  const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
  return failed.length
    ? { applies: false, reason: 'selector mismatch: ' + failed.join(', ') }
    : { applies: true, reason: checks.length ? 'all selectors matched' : 'rule has no restricting selectors' };
}

function normalizeRules(rules, sourceClass) {
  return (rules ?? []).filter(Boolean).map((raw, index) => ({
    rule_id: String(raw.rule_id ?? raw.id ?? sourceClass + '.rule.' + index),
    version: String(raw.version ?? 'v1'),
    source_class: String(raw.source_class ?? sourceClass),
    trust: String(raw.trust ?? (sourceClass === 'builtin' ? 'ENGINE_TRUSTED' : 'REPOSITORY_UNTRUSTED')),
    selectors: structuredClone(raw.selectors ?? {}),
    content_reference: raw.content_reference ?? raw.content ?? null,
    source: raw.source ?? sourceClass
  }));
}

function resultRule(rule, applies, reason) {
  return {
    rule_id: rule.rule_id,
    version: rule.version,
    rule_hash: rule.rule_hash,
    source_class: rule.source_class,
    source: rule.source,
    trust: rule.trust,
    precedence: rule.precedence,
    selectors: structuredClone(rule.selectors ?? {}),
    content_reference: rule.content_reference,
    status: applies ? 'APPLIED' : 'REJECTED',
    reason
  };
}

function compareRules(a, b) {
  return b.precedence - a.precedence ||
    a.rule_id.localeCompare(b.rule_id) ||
    a.version.localeCompare(b.version) ||
    a.rule_hash.localeCompare(b.rule_hash);
}

function ruleHash(rule) {
  return digestObject({
    rule_id: rule.rule_id,
    version: rule.version,
    source_class: rule.source_class,
    trust: rule.trust,
    selectors: rule.selectors ?? {},
    content_reference: rule.content_reference ?? null,
    source: rule.source ?? null
  });
}

function overlaps(values, set) {
  return values.some(value => set.has(value));
}

function pathMatches(path, pattern) {
  if (!path) return false;
  const p = String(path).replaceAll('\\', '/');
  const q = String(pattern).replaceAll('\\', '/');
  if (q.endsWith('/**')) return p.startsWith(q.slice(0, -3));
  if (q.startsWith('*.')) return p.endsWith(q.slice(1));
  return p === q || p.startsWith(q.endsWith('/') ? q : q + '/');
}

function digestObject(value) {
  return 'sha256:' + crypto.createHash('sha256').update(stableStringify(value)).digest('hex');
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
