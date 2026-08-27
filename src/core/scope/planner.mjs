import crypto from 'node:crypto';
import { createCoverageManifest } from './coverage.mjs';
import { isFlowSemanticEdge, isStrongSemanticEdge } from './relationships.mjs';

export const SCOPE_PLANNER_ID = 'core-scope-planner';
export const SCOPE_PLANNER_VERSION = 'v1';

const DEFAULT_DEPTH = Object.freeze({
  UNDERSTAND: 2,
  TRACE: 4,
  DIAGNOSE: 3,
  IMPACT: 3,
  REVIEW: 2,
  AUDIT: 4,
  RUNTIME: 3
});

export function planScope(graph, request = {}, options = {}) {
  if (!graph?.nodes || !graph?.edges) throw new TypeError('scope planner requires a graph');

  const mode = request.mode ?? 'UNDERSTAND';
  const maxDepth = finiteNonNegativeInteger(
    options.maxDepth ?? request.budget?.scope_depth,
    DEFAULT_DEPTH[mode] ?? 2
  );
  const maxItems = finitePositiveInteger(
    options.maxItems ?? request.budget?.scope_items,
    Number.POSITIVE_INFINITY
  );
  const requestedUniverseEnumerable = options.universeEnumerable !== false;
  const seeds = normalizeSeeds(request, graph);
  const deterministicSeedAvailable = seeds.length > 0;
  const universeEnumerable = requestedUniverseEnumerable && deterministicSeedAvailable;
  const index = buildIndex(graph);
  const decisions = [];
  const selected = new Map();
  const boundary = new Map();
  const seedResults = [];
  let budgetExhausted = false;
  let depthBoundaryReached = false;

  if (!deterministicSeedAvailable) {
    const itemId = 'unresolved-seed:no-deterministic-seed';
    boundary.set(itemId, {
      id: itemId,
      role: 'PRIMARY',
      status: 'UNEXPLORED',
      reason: 'no deterministic seed is available for the requested analysis mode',
      reason_code: 'SCOPE_UNRESOLVABLE',
      label: 'unresolved analysis intent',
      selected: false
    });
    decisions.push(decision({
      action: 'EXCLUDE',
      itemId,
      seedId: null,
      reason: 'no deterministic seed is available for the requested analysis mode',
      cause: 'SCOPE_UNRESOLVABLE'
    }));
  }

  for (let i = 0; i < seeds.length; i++) {
    const seed = { ...seeds[i], id: seeds[i].id ?? 'seed:' + (i + 1) };
    const resolved = resolveSeed(seed, graph, index);
    seedResults.push(resolved);

    if (!resolved.items.length) {
      const itemId = 'unresolved-seed:' + digest(seed.kind + '\0' + seed.value).slice(0, 16);
      boundary.set(itemId, {
        id: itemId,
        role: seed.kind === 'RUNTIME_REF' ? 'RUNTIME_ARTIFACT' : 'PRIMARY',
        status: 'UNEXPLORED',
        reason: 'seed could not be resolved exactly',
        reason_code: 'SEED_UNRESOLVED',
        label: String(seed.value)
      });
      decisions.push(decision({
        action: 'EXCLUDE',
        itemId,
        seedId: seed.id,
        reason: 'seed could not be resolved exactly',
        cause: 'SEED_UNRESOLVED'
      }));
      continue;
    }

    for (const item of resolved.items) {
      const scopeItem = {
        ...item,
        role: item.role ?? (seed.kind === 'RUNTIME_REF' ? 'RUNTIME_ARTIFACT' : 'PRIMARY'),
        depth: 0,
        originating_seed: seed.id,
        selected: true
      };
      mergeSelected(selected, scopeItem);
      decisions.push(decision({
        action: 'INCLUDE',
        itemId: scopeItem.id,
        seedId: seed.id,
        reason: resolved.status === 'AMBIGUOUS'
          ? 'exact seed resolved to an explicit candidate set'
          : 'exact seed match',
        cause: resolved.status === 'AMBIGUOUS' ? 'AMBIGUOUS_CANDIDATE' : 'SEED'
      }));
    }
  }

  const queue = [...selected.values()]
    .filter(item => item.node_id)
    .sort(compareScopeItems)
    .map(item => ({ item, depth: 0, seedId: item.originating_seed }));

  const expandedDepth = new Map(queue.map(q => [q.item.node_id, 0]));

  while (queue.length) {
    const current = queue.shift();
    const nodeId = current.item.node_id;
    if (!nodeId) continue;

    const neighbors = adjacent(graph, nodeId, mode)
      .filter(link => allowedEdge(mode, link.edge))
      .sort(compareLinks);

    for (const link of neighbors) {
      const nextDepth = current.depth + 1;
      const target = index.byId.get(link.otherId);
      if (!target) continue;
      const targetItem = nodeScopeItem(target, roleForDepth(nextDepth), nextDepth, current.seedId);

      if (nextDepth > maxDepth) {
        depthBoundaryReached = true;
        if (!selected.has(targetItem.id) && !boundary.has(targetItem.id)) {
          boundary.set(targetItem.id, {
            ...targetItem,
            selected: false,
            status: 'UNEXPLORED',
            reason: 'outside explicit scope depth horizon',
            reason_code: 'DEPTH_HORIZON'
          });
          decisions.push(decision({
            action: 'EXCLUDE',
            itemId: targetItem.id,
            seedId: current.seedId,
            reason: 'outside explicit scope depth horizon',
            cause: 'DEPTH_HORIZON',
            edge: link.edge,
            depth: nextDepth
          }));
        }
        continue;
      }

      if (!selected.has(targetItem.id) && selected.size >= maxItems) {
        budgetExhausted = true;
        if (!boundary.has(targetItem.id)) {
          boundary.set(targetItem.id, {
            ...targetItem,
            selected: false,
            status: 'UNEXPLORED',
            reason: 'scope item budget exhausted',
            reason_code: 'BUDGET_EXHAUSTED'
          });
          decisions.push(decision({
            action: 'EXCLUDE',
            itemId: targetItem.id,
            seedId: current.seedId,
            reason: 'scope item budget exhausted',
            cause: 'BUDGET_EXHAUSTED',
            edge: link.edge,
            depth: nextDepth
          }));
        }
        continue;
      }

      const wasNew = !selected.has(targetItem.id);
      mergeSelected(selected, {
        ...targetItem,
        selected: true
      });

      if (wasNew) {
        decisions.push(decision({
          action: 'EXPAND',
          itemId: targetItem.id,
          seedId: current.seedId,
          reason: 'deterministic semantic graph expansion',
          cause: 'GRAPH_EDGE',
          edge: link.edge,
          depth: nextDepth
        }));
      }

      const previousDepth = expandedDepth.get(target.id);
      if (previousDepth == null || nextDepth < previousDepth) {
        expandedDepth.set(target.id, nextDepth);
        queue.push({
          item: selected.get(targetItem.id),
          depth: nextDepth,
          seedId: current.seedId
        });
        queue.sort((a, b) => a.depth - b.depth || compareScopeItems(a.item, b.item));
      }
    }
  }

  const allItems = [
    ...[...selected.values()].sort(compareScopeItems).map(item => ({
      ...item,
      status: 'PENDING'
    })),
    ...[...boundary.values()].sort(compareScopeItems)
  ];

  const closureKind = Number.isFinite(maxDepth) ? 'DEPTH_HORIZON' : 'FULL';
  const coverage = createCoverageManifest(allItems, {
    universeEnumerable,
    closure: {
      kind: closureKind,
      max_depth: Number.isFinite(maxDepth) ? maxDepth : null,
      max_items: Number.isFinite(maxItems) ? maxItems : null,
      boundary_reached: depthBoundaryReached,
      budget_exhausted: budgetExhausted
    },
    snapshotId: graph.meta?.snapshot?.snapshot_id ?? null
  });

  const result = {
    planner: { id: SCOPE_PLANNER_ID, version: SCOPE_PLANNER_VERSION },
    mode,
    seeds: seedResults,
    decisions,
    items: allItems,
    selected_ids: [...selected.keys()].sort(),
    boundary_ids: [...boundary.keys()].sort(),
    universe_enumerable: universeEnumerable,
    closure: structuredClone(coverage.closure),
    coverage
  };
  result.deterministic_fingerprint = scopeFingerprint(result);
  return result;
}

export function normalizeSeeds(request, graph) {
  const seeds = [];
  for (const seed of request.seeds ?? []) {
    if (seed?.kind && seed?.value != null) seeds.push({ kind: normalizeSeedKind(seed.kind), value: seed.value });
  }
  for (const value of request.scope?.paths ?? []) seeds.push({ kind: 'PATH', value });
  for (const value of request.scope?.symbols ?? []) seeds.push({ kind: 'SYMBOL', value });
  for (const value of request.diff_files ?? []) seeds.push({ kind: 'DIFF_FILE', value });
  for (const value of request.graph_node_ids ?? []) seeds.push({ kind: 'GRAPH_NODE', value });
  for (const value of request.runtime_refs ?? []) seeds.push({ kind: 'RUNTIME_REF', value });
  for (const value of request.runtime_artifacts ?? []) {
    const ref = typeof value === 'string'
      ? value
      : value?.artifact_id ?? value?.artifact_digest ?? value?.run ?? value?.id;
    if (ref != null) seeds.push({ kind: 'RUNTIME_REF', value: ref });
  }

  if (!seeds.length && ['UNDERSTAND','AUDIT'].includes(request.mode ?? 'UNDERSTAND')) {
    const repositoryNodes = (graph.nodes ?? []).filter(node => node.kind === 'repository');
    if (repositoryNodes.length) {
      for (const node of repositoryNodes) seeds.push({ kind: 'GRAPH_NODE', value: node.id });
    } else {
      for (const node of (graph.nodes ?? []).filter(node => node.kind === 'file').sort(compareNodes)) {
        seeds.push({ kind: 'GRAPH_NODE', value: node.id });
      }
    }
  }
  return dedupeSeeds(seeds);
}

export function resolveSeed(seed, graph, index = buildIndex(graph)) {
  const kind = normalizeSeedKind(seed.kind);
  const value = String(seed.value);
  let items = [];
  let resolutionMethod = 'EXACT';

  if (kind === 'PATH' || kind === 'DIFF_FILE') {
    const normalized = normalizePath(value);
    const pathCandidates = index.byPath.get(normalized) ?? [];
    const fileNodes = pathCandidates.filter(node => node.kind === 'file');
    const nodes = fileNodes.length ? fileNodes : pathCandidates;
    items = uniqueNodes(nodes).map(node => nodeScopeItem(node, 'PRIMARY', 0, seed.id));
  } else if (kind === 'GRAPH_NODE') {
    const node = index.byId.get(value);
    if (node) items = [nodeScopeItem(node, 'PRIMARY', 0, seed.id)];
  } else if (kind === 'SYMBOL') {
    const exactKey = index.byKey.get(value) ?? [];
    const exactLabel = index.byLabel.get(value) ?? [];
    let candidates = exactKey.length ? exactKey : exactLabel;

    if (!candidates.length) {
      for (const alias of canonicalSymbolAliases(value)) {
        const aliasKey = index.byKey.get(alias) ?? [];
        const aliasLabel = index.byLabel.get(alias) ?? [];
        candidates.push(...(aliasKey.length ? aliasKey : aliasLabel));
      }
      if (candidates.length) resolutionMethod = 'CANONICAL_ALIAS';
    }

    items = uniqueNodes(candidates).map(node => nodeScopeItem(node, 'PRIMARY', 0, seed.id));
  } else if (kind === 'RUNTIME_REF') {
    const runtimeNodes = graph.nodes.filter(node =>
      isRuntimeNode(node) && exactRuntimeMatch(node, value)
    );
    items = uniqueNodes(runtimeNodes).map(node => ({
      ...nodeScopeItem(node, 'RUNTIME_ARTIFACT', 0, seed.id),
      role: 'RUNTIME_ARTIFACT'
    }));

    for (const record of graph.meta?.evidence ?? []) {
      if (record.kind !== 'RUNTIME') continue;
      const provenance = record.provenance ?? {};
      const matches = [
        record.id,
        provenance.artifact_id,
        provenance.artifact_digest,
        provenance.runtime_run_id
      ].filter(Boolean).some(candidate => String(candidate) === value);
      if (matches) {
        items.push({
          id: record.id,
          evidence_id: record.id,
          kind: 'evidence',
          label: record.id,
          role: 'RUNTIME_ARTIFACT',
          depth: 0,
          originating_seed: seed.id
        });
      }
    }
  } else {
    return {
      seed: { ...seed, kind },
      status: 'UNSUPPORTED',
      items: [],
      candidate_ids: [],
      reason: 'unsupported seed kind'
    };
  }

  items = dedupeItems(items);
  return {
    seed: { ...seed, kind },
    status: items.length > 1 ? 'AMBIGUOUS' : items.length === 1 ? 'RESOLVED' : 'UNRESOLVED',
    resolution_method: items.length ? resolutionMethod : 'NONE',
    items,
    candidate_ids: items.map(item => item.id).sort(),
    reason: items.length > 1
      ? (resolutionMethod === 'CANONICAL_ALIAS'
          ? 'multiple deterministic canonical-alias candidates retained'
          : 'multiple exact candidates retained')
      : items.length === 1
        ? (resolutionMethod === 'CANONICAL_ALIAS'
            ? 'deterministic canonical alias match'
            : 'exact match')
        : 'no exact or canonical-alias candidate'
  };
}

export function scopeFingerprint(scope) {
  const basis = {
    planner: scope.planner,
    mode: scope.mode,
    seeds: scope.seeds.map(seed => ({
      seed: seed.seed,
      status: seed.status,
      candidate_ids: seed.candidate_ids
    })),
    decisions: scope.decisions,
    items: scope.items.map(item => ({
      id: item.id,
      role: item.role,
      depth: item.depth ?? null,
      selected: item.selected !== false,
      status: item.status ?? null,
      reason_code: item.reason_code ?? null
    })),
    selected_ids: scope.selected_ids,
    boundary_ids: scope.boundary_ids,
    universe_enumerable: scope.universe_enumerable,
    closure: scope.closure
  };
  return 'sha256:' + digest(stableStringify(basis));
}

function buildIndex(graph) {
  const byId = new Map();
  const byPath = new Map();
  const byKey = new Map();
  const byLabel = new Map();
  for (const node of graph.nodes ?? []) {
    byId.set(node.id, node);
    addIndex(byKey, String(node.key ?? ''), node);
    addIndex(byLabel, String(node.label ?? ''), node);
    if (node.path) addIndex(byPath, normalizePath(node.path), node);
    if (node.kind === 'file' && node.key) addIndex(byPath, normalizePath(node.key), node);
  }
  return { byId, byPath, byKey, byLabel };
}

function adjacent(graph, nodeId, mode) {
  const links = [];
  for (const edge of graph.edges ?? []) {
    if (mode === 'IMPACT') {
      if (edge.to === nodeId) links.push({ edge, otherId: edge.from, direction: 'in' });
      continue;
    }
    if (edge.from === nodeId) links.push({ edge, otherId: edge.to, direction: 'out' });
    if (edge.to === nodeId) links.push({ edge, otherId: edge.from, direction: 'in' });
  }
  return links;
}

function allowedEdge(mode, edge) {
  return mode === 'TRACE' || mode === 'RUNTIME'
    ? isFlowSemanticEdge(edge)
    : isStrongSemanticEdge(edge);
}

function nodeScopeItem(node, role, depth, seedId) {
  return {
    id: 'node:' + node.id,
    node_id: node.id,
    kind: node.kind,
    label: node.label ?? node.key ?? node.id,
    ...(node.path ? { path: normalizePath(node.path) } : {}),
    role,
    depth,
    originating_seed: seedId
  };
}

function roleForDepth(depth) {
  return depth === 0 ? 'PRIMARY' : depth === 1 ? 'DEPENDENCY' : 'SUPPORTING_CONTEXT';
}

function mergeSelected(map, item) {
  const existing = map.get(item.id);
  if (!existing) {
    map.set(item.id, item);
    return item;
  }
  if (roleRank(item.role) < roleRank(existing.role)) existing.role = item.role;
  if ((item.depth ?? Infinity) < (existing.depth ?? Infinity)) existing.depth = item.depth;
  return existing;
}

function roleRank(role) {
  return { PRIMARY: 0, RUNTIME_ARTIFACT: 0, DEPENDENCY: 1, SUPPORTING_CONTEXT: 2 }[role] ?? 3;
}

function decision({ action, itemId, seedId, reason, cause, edge = null, depth = 0 }) {
  return {
    id: 'scope-decision:' + digest([
      action,
      itemId,
      seedId ?? '',
      cause,
      edge?.id ?? '',
      String(depth)
    ].join('\0')).slice(0, 20),
    action,
    item_id: itemId,
    originating_seed: seedId ?? null,
    planner_id: SCOPE_PLANNER_ID,
    planner_version: SCOPE_PLANNER_VERSION,
    reason,
    cause,
    depth,
    ...(edge ? {
      causal_edge_id: edge.id,
      causal_edge_type: edge.type
    } : {})
  };
}

function exactRuntimeMatch(node, value) {
  const fields = [
    node.id,
    node.key,
    node.artifact_id,
    node.artifactId,
    node.artifact_digest,
    node.artifactDigest,
    node.runtime_run_id,
    node.run,
    node.uuid,
    node.entityId,
    node.entity_id
  ].filter(v => v != null).map(String);
  return fields.includes(String(value));
}

function isRuntimeNode(node) {
  return String(node.kind ?? '').startsWith('runtime') ||
    node.runtimeObserved === true ||
    node.runtimeObservation === true;
}

function canonicalSymbolAliases(value) {
  const match = String(value).match(/^(v|q|t|c)\.([A-Za-z_][A-Za-z0-9_.]*)$/);
  if (!match) return [];
  const prefix = {
    v: 'variable',
    q: 'query',
    t: 'temp',
    c: 'context'
  }[match[1]];
  return prefix ? [prefix + '.' + match[2]] : [];
}

function normalizeSeedKind(kind) {
  const normalized = String(kind).trim().toUpperCase().replaceAll('-', '_');
  if (normalized === 'NODE' || normalized === 'GRAPH_NODE_ID') return 'GRAPH_NODE';
  if (normalized === 'RUNTIME' || normalized === 'ARTIFACT' || normalized === 'ENTITY') return 'RUNTIME_REF';
  if (normalized === 'DIFF') return 'DIFF_FILE';
  return normalized;
}

function normalizePath(value) {
  return String(value).replaceAll('\\', '/').replace(/^\.\/+/, '').replace(/^\/+/, '');
}

function addIndex(map, key, value) {
  if (!key) return;
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}

function dedupeSeeds(seeds) {
  const seen = new Set();
  return seeds.filter(seed => {
    const key = seed.kind + '\0' + String(seed.value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeItems(items) {
  const map = new Map();
  for (const item of items) if (!map.has(item.id)) map.set(item.id, item);
  return [...map.values()].sort(compareScopeItems);
}

function uniqueNodes(nodes) {
  const map = new Map();
  for (const node of nodes) map.set(node.id, node);
  return [...map.values()].sort(compareNodes);
}

function compareNodes(a, b) {
  return String(a.id).localeCompare(String(b.id));
}

function compareScopeItems(a, b) {
  return roleRank(a.role) - roleRank(b.role) ||
    (a.depth ?? 0) - (b.depth ?? 0) ||
    String(a.id).localeCompare(String(b.id));
}

function compareLinks(a, b) {
  return String(a.edge.type).localeCompare(String(b.edge.type)) ||
    String(a.otherId).localeCompare(String(b.otherId)) ||
    String(a.edge.id).localeCompare(String(b.edge.id));
}

function finiteNonNegativeInteger(value, fallback) {
  if (value == null) return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

function finitePositiveInteger(value, fallback) {
  if (value == null) return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 ? n : fallback;
}

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
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
