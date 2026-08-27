import crypto from 'node:crypto';
import { ruleMatchesNode } from '../rules/resolver.mjs';
import { isStrongSemanticEdge } from './relationships.mjs';

export { isStrongSemanticEdge } from './relationships.mjs';

export function buildSemanticAnalysisUnits(graph, scope, ruleResolution, {
  maxUnitItems = 50
} = {}) {
  if (!Number.isInteger(maxUnitItems) || maxUnitItems < 1) throw new TypeError('maxUnitItems must be >= 1');

  const selectedItems = (scope.items ?? [])
    .filter(item => item.selected !== false && item.status !== 'UNEXPLORED');
  const itemByNode = new Map(
    selectedItems.filter(item => item.node_id).map(item => [item.node_id, item])
  );
  const selectedNodeIds = new Set(itemByNode.keys());
  const byId = new Map(graph.nodes.map(node => [node.id, node]));
  const strongEdges = graph.edges
    .filter(edge =>
      selectedNodeIds.has(edge.from) &&
      selectedNodeIds.has(edge.to) &&
      isStrongSemanticEdge(edge)
    )
    .sort(compareEdges);

  const adjacency = new Map([...selectedNodeIds].map(id => [id, []]));
  for (const edge of strongEdges) {
    adjacency.get(edge.from)?.push({ edge, other: edge.to });
    adjacency.get(edge.to)?.push({ edge, other: edge.from });
  }
  for (const links of adjacency.values()) links.sort(compareLinks);

  const components = [];
  const unseen = new Set([...selectedNodeIds].sort());
  while (unseen.size) {
    const start = [...unseen][0];
    const component = [];
    const queue = [start];
    unseen.delete(start);
    while (queue.length) {
      const id = queue.shift();
      component.push(id);
      for (const link of adjacency.get(id) ?? []) {
        if (!unseen.has(link.other)) continue;
        unseen.delete(link.other);
        queue.push(link.other);
        queue.sort();
      }
    }
    components.push(component.sort());
  }

  const chunks = [];
  for (const component of components) {
    chunks.push(...splitComponent(component, adjacency, itemByNode, maxUnitItems));
  }

  for (const item of selectedItems.filter(item => !item.node_id)) {
    chunks.push([item.id]);
  }

  const nodeToUnit = new Map();
  const units = chunks.map((chunk, index) => {
    const graphNodeIds = chunk.filter(id => byId.has(id));
    const pseudoIds = chunk.filter(id => !byId.has(id));
    const members = [
      ...graphNodeIds.map(nodeId => itemByNode.get(nodeId)).filter(Boolean),
      ...pseudoIds.map(id => selectedItems.find(item => item.id === id)).filter(Boolean)
    ].sort(compareItems);

    const memberNodeSet = new Set(graphNodeIds);
    const primary = members.filter(item => ['PRIMARY','RUNTIME_ARTIFACT'].includes(item.role));
    const dependencies = members.filter(item => item.role === 'DEPENDENCY');
    const supporting = members.filter(item => item.role === 'SUPPORTING_CONTEXT');

    const matchedRules = (ruleResolution?.applied ?? []).filter(rule =>
      graphNodeIds.some(nodeId => {
        const node = byId.get(nodeId);
        return node && ruleMatchesNode(rule, node);
      })
    ).map(rule => rule.rule_id).sort();

    const internalEdges = strongEdges.filter(edge =>
      memberNodeSet.has(edge.from) && memberNodeSet.has(edge.to)
    );
    const boundaryEdges = graph.edges.filter(edge =>
      memberNodeSet.has(edge.from) !== memberNodeSet.has(edge.to)
    ).filter(edge =>
      memberNodeSet.has(edge.from) || memberNodeSet.has(edge.to)
    ).map(edge => ({
      edge_id: edge.id,
      edge_type: edge.type,
      from: edge.from,
      to: edge.to,
      ...(edge.boundary ? { workspace_boundary: true } : {})
    })).sort((a, b) => a.edge_id.localeCompare(b.edge_id));

    const purpose = unitPurpose(primary, members, byId, index);
    const fingerprint = digestObject({
      purpose,
      members: members.map(item => [item.id, item.role]),
      internal_edges: internalEdges.map(edge => [edge.id, edge.type, edge.from, edge.to]),
      boundary_edges: boundaryEdges.map(edge => [
        edge.edge_id,
        edge.edge_type,
        edge.from,
        edge.to,
        edge.workspace_boundary ?? false
      ]),
      matched_rule_ids: matchedRules,
      budget: { max_items: maxUnitItems, item_count: members.length },
      snapshot_id: graph.meta?.snapshot?.snapshot_id ?? null
    });

    const unit = {
      id: 'sau:sha256:' + fingerprint.slice('sha256:'.length),
      purpose,
      primary_targets: primary.map(item => item.id),
      dependency_items: dependencies.map(item => item.id),
      supporting_items: supporting.map(item => item.id),
      boundary_edges: boundaryEdges,
      matched_rule_ids: matchedRules,
      budget: {
        max_items: maxUnitItems,
        item_count: members.length
      },
      deterministic_fingerprint: fingerprint
    };

    for (const nodeId of graphNodeIds) nodeToUnit.set(nodeId, unit.id);
    return unit;
  }).sort((a, b) => a.id.localeCompare(b.id));

  const allSelectedIds = new Set(selectedItems.map(item => item.id));
  const assignedIds = new Set();
  for (const unit of units) {
    for (const id of [...unit.primary_targets, ...unit.dependency_items, ...unit.supporting_items]) {
      if (assignedIds.has(id)) throw new Error('scope item assigned to multiple SAUs: ' + id);
      assignedIds.add(id);
    }
  }
  for (const id of allSelectedIds) {
    if (!assignedIds.has(id)) throw new Error('selected scope item missing from SAUs: ' + id);
  }

  return {
    planner: { id: 'core-semantic-unit-builder', version: 'v1' },
    units,
    selected_item_count: allSelectedIds.size,
    deterministic_fingerprint: digestObject(units.map(unit => ({
      id: unit.id,
      fingerprint: unit.deterministic_fingerprint
    })))
  };
}

function splitComponent(component, adjacency, itemByNode, maxUnitItems) {
  if (component.length <= maxUnitItems) return [component];

  const remaining = new Set(component);
  const chunks = [];

  while (remaining.size) {
    const seed = [...remaining].sort((a, b) => {
      const ia = itemByNode.get(a);
      const ib = itemByNode.get(b);
      return roleRank(ia?.role) - roleRank(ib?.role) || a.localeCompare(b);
    })[0];

    const chunk = [];
    const queued = new Set([seed]);
    const queue = [seed];

    while (queue.length && chunk.length < maxUnitItems) {
      const id = queue.shift();
      queued.delete(id);
      if (!remaining.has(id)) continue;
      remaining.delete(id);
      chunk.push(id);

      for (const link of adjacency.get(id) ?? []) {
        if (!remaining.has(link.other) || queued.has(link.other)) continue;
        queued.add(link.other);
        queue.push(link.other);
      }
      queue.sort((a, b) => {
        const ia = itemByNode.get(a);
        const ib = itemByNode.get(b);
        return roleRank(ia?.role) - roleRank(ib?.role) || a.localeCompare(b);
      });
    }
    chunks.push(chunk.sort());
  }
  return chunks;
}

function unitPurpose(primary, members, byId, index) {
  const labels = primary.map(item =>
    item.node_id ? byId.get(item.node_id)?.label ?? item.label : item.label
  ).filter(Boolean);
  const chosen = labels.length ? labels : members.map(item => item.label).filter(Boolean);
  return 'Semantic unit ' + (index + 1) + ': ' + chosen.slice(0, 3).join(' / ');
}

function compareEdges(a, b) {
  return String(a.type).localeCompare(String(b.type)) ||
    String(a.from).localeCompare(String(b.from)) ||
    String(a.to).localeCompare(String(b.to)) ||
    String(a.id).localeCompare(String(b.id));
}

function compareLinks(a, b) {
  return String(a.edge.type).localeCompare(String(b.edge.type)) ||
    String(a.other).localeCompare(String(b.other));
}

function compareItems(a, b) {
  return roleRank(a.role) - roleRank(b.role) || String(a.id).localeCompare(String(b.id));
}

function roleRank(role) {
  return { PRIMARY: 0, RUNTIME_ARTIFACT: 0, DEPENDENCY: 1, SUPPORTING_CONTEXT: 2 }[role] ?? 3;
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
