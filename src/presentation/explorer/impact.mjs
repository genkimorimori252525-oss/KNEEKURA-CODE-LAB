import {
  planScope,
  SCOPE_PLANNER_ID,
  SCOPE_PLANNER_VERSION
} from '../../core/scope/planner.mjs';
import {
  isStrongSemanticEdge
} from '../../core/scope/relationships.mjs';
import {
  assertExplorerUiModel
} from './ui-model.mjs';
import {
  EXPLORER_PROJECTION_SCHEMA
} from './schema.mjs';

export const EXPLORER_CHANGE_IMPACT_SCHEMA =
  'kneekura.explorer-change-impact/v1';

export const CHANGE_IMPACT_DEFAULT_DEPTH = 3;
export const CHANGE_IMPACT_MAX_ITEMS = 200;

export function createExplorerChangeImpact(
  projection,
  model,
  seedNodeId,
  {
    maxDepth = CHANGE_IMPACT_DEFAULT_DEPTH,
    maxItems = CHANGE_IMPACT_MAX_ITEMS
  } = {}
) {
  assertProjectionShape(projection);
  assertExplorerUiModel(model);
  const seedId = String(seedNodeId ?? '');
  if (!seedId) {
    throw new TypeError(
      'Change impact requires an exact canonical seed node ID'
    );
  }
  if (
    !Number.isInteger(maxDepth) ||
    maxDepth < 0 ||
    maxDepth > 8
  ) {
    throw new RangeError(
      'Change impact maxDepth must be an integer from 0 to 8'
    );
  }
  if (
    !Number.isInteger(maxItems) ||
    maxItems < 1 ||
    maxItems > 1000
  ) {
    throw new RangeError(
      'Change impact maxItems must be an integer from 1 to 1000'
    );
  }

  const canonicalNodeById = uniqueMap(
    projection.canonical.graph.nodes,
    item => item.id,
    'Canonical node'
  );
  const canonicalEdgeById = uniqueMap(
    projection.canonical.graph.edges,
    item => item.id,
    'Canonical edge'
  );
  const presentationNodeById = uniqueMap(
    projection.presentation.nodes,
    item => item.node_id,
    'Presentation node'
  );
  const presentationEdgeById = uniqueMap(
    projection.presentation.edges,
    item => item.edge_id,
    'Presentation edge'
  );
  const uiNodeById = uniqueMap(
    model.nodes,
    item => item.id,
    'Explorer UI node'
  );
  const uiEdgeById = uniqueMap(
    model.edges,
    item => item.id,
    'Explorer UI edge'
  );

  assertNodeTrace(
    seedId,
    canonicalNodeById,
    presentationNodeById,
    uiNodeById,
    'seed'
  );

  const scope = planScope(
    projection.canonical.graph,
    {
      mode: 'IMPACT',
      seeds: [
        {
          kind: 'GRAPH_NODE',
          value: seedId
        }
      ]
    },
    {
      maxDepth,
      maxItems
    }
  );

  if (
    scope.mode !== 'IMPACT' ||
    scope.planner?.id !== SCOPE_PLANNER_ID ||
    scope.planner?.version !== SCOPE_PLANNER_VERSION
  ) {
    throw new TypeError(
      'Change impact planner identity mismatch'
    );
  }
  if (
    scope.seeds.length !== 1 ||
    scope.seeds[0].status !== 'RESOLVED' ||
    scope.seeds[0].candidate_ids.length !== 1
  ) {
    throw new TypeError(
      'Change impact exact seed did not resolve uniquely'
    );
  }

  const itemById = uniqueMap(
    scope.items,
    item => item.id,
    'IMPACT scope item'
  );
  const selectedNodeIds = [];
  const boundaryNodeIds = [];
  const selected = [];
  const boundary = [];

  for (const item of scope.items) {
    if (typeof item.node_id !== 'string') {
      throw new TypeError(
        'Change impact scope contains a non-node item: ' +
        String(item.id)
      );
    }
    assertNodeTrace(
      item.node_id,
      canonicalNodeById,
      presentationNodeById,
      uiNodeById,
      'scope'
    );
    if (item.id !== 'node:' + item.node_id) {
      throw new TypeError(
        'Change impact scope item identity mismatch: ' +
        String(item.id)
      );
    }

    const view = {
      item_id: item.id,
      node_id: item.node_id,
      role: item.role,
      depth: item.depth ?? null,
      status: item.status ?? null,
      selected: item.selected !== false,
      reason:
        typeof item.reason === 'string'
          ? item.reason
          : null,
      reason_code:
        typeof item.reason_code === 'string'
          ? item.reason_code
          : null
    };

    if (scope.selected_ids.includes(item.id)) {
      if (view.selected !== true) {
        throw new TypeError(
          'Change impact selected item is marked unselected: ' +
          item.id
        );
      }
      selectedNodeIds.push(item.node_id);
      selected.push(view);
    } else if (scope.boundary_ids.includes(item.id)) {
      if (
        view.selected !== false ||
        view.status !== 'UNEXPLORED'
      ) {
        throw new TypeError(
          'Change impact boundary semantics mismatch: ' +
          item.id
        );
      }
      boundaryNodeIds.push(item.node_id);
      boundary.push(view);
    } else {
      throw new TypeError(
        'Change impact item is neither selected nor boundary: ' +
        item.id
      );
    }
  }

  const decisions = [];
  const causalEdgeIds = new Set();

  for (const decision of scope.decisions) {
    const item = itemById.get(decision.item_id);
    if (!item) {
      throw new TypeError(
        'Change impact decision references foreign item: ' +
        String(decision.item_id)
      );
    }

    let causal = null;
    if (decision.causal_edge_id != null) {
      const edge = canonicalEdgeById.get(
        decision.causal_edge_id
      );
      if (
        !edge ||
        edge.type !== decision.causal_edge_type ||
        edge.from !== item.node_id ||
        !isStrongSemanticEdge(edge)
      ) {
        throw new TypeError(
          'Change impact causal edge trace mismatch: ' +
          String(decision.causal_edge_id)
        );
      }
      assertEdgeTrace(
        edge,
        presentationEdgeById,
        uiEdgeById
      );
      causal = {
        edge_id: edge.id,
        canonical_type: edge.type,
        source: edge.from,
        target: edge.to
      };
      causalEdgeIds.add(edge.id);
    }

    decisions.push({
      decision_id: decision.id,
      action: decision.action,
      item_id: decision.item_id,
      node_id: item.node_id,
      originating_seed:
        decision.originating_seed ?? null,
      planner_id: decision.planner_id,
      planner_version: decision.planner_version,
      reason: decision.reason,
      cause: decision.cause,
      depth: decision.depth,
      causal_edge: causal
    });
  }

  const seedItem = selected.find(
    item => item.node_id === seedId
  );
  if (
    !seedItem ||
    seedItem.depth !== 0 ||
    seedItem.role !== 'PRIMARY'
  ) {
    throw new TypeError(
      'Change impact seed scope semantics mismatch'
    );
  }

  selected.sort(compareImpactItems);
  boundary.sort(compareImpactItems);
  decisions.sort(compareDecisions);
  selectedNodeIds.sort(compareText);
  boundaryNodeIds.sort(compareText);

  return {
    schema: EXPLORER_CHANGE_IMPACT_SCHEMA,
    projection_schema: projection.schema,
    model_schema: model.schema,
    source: structuredClone(projection.source ?? null),
    terminology:
      'CORE IMPACT investigation scope; not a verified breakage claim',
    planner: structuredClone(scope.planner),
    planner_fingerprint:
      scope.deterministic_fingerprint,
    seed_node_id: seedId,
    max_depth: maxDepth,
    max_items: maxItems,
    universe_enumerable:
      scope.universe_enumerable,
    closure: structuredClone(scope.closure),
    selected_node_ids: selectedNodeIds,
    boundary_node_ids: boundaryNodeIds,
    causal_edge_ids:
      [...causalEdgeIds].sort(compareText),
    selected,
    boundary,
    decisions
  };
}

function assertNodeTrace(
  nodeId,
  canonicalNodeById,
  presentationNodeById,
  uiNodeById,
  description
) {
  const canonical = canonicalNodeById.get(nodeId);
  const presentation =
    presentationNodeById.get(nodeId);
  const ui = uiNodeById.get(nodeId);
  if (
    !canonical ||
    !presentation ||
    !ui ||
    presentation.node_id !== canonical.id ||
    presentation.canonical_kind !== canonical.kind ||
    ui.data?.canonical_node_id !== canonical.id ||
    ui.data?.canonical_kind !== canonical.kind
  ) {
    throw new TypeError(
      'Change impact ' + description +
      ' node trace mismatch: ' + nodeId
    );
  }
}

function assertEdgeTrace(
  canonical,
  presentationEdgeById,
  uiEdgeById
) {
  const presentation =
    presentationEdgeById.get(canonical.id);
  const ui = uiEdgeById.get(canonical.id);
  if (
    !presentation ||
    !ui ||
    presentation.from_node_id !== canonical.from ||
    presentation.to_node_id !== canonical.to ||
    presentation.canonical_type !== canonical.type ||
    ui.source !== canonical.from ||
    ui.target !== canonical.to ||
    ui.data?.canonical_edge_id !== canonical.id ||
    ui.data?.canonical_type !== canonical.type
  ) {
    throw new TypeError(
      'Change impact causal edge UI trace mismatch: ' +
      canonical.id
    );
  }
}

function assertProjectionShape(projection) {
  if (
    !projection ||
    projection.schema !==
      EXPLORER_PROJECTION_SCHEMA ||
    !projection.canonical?.graph ||
    !Array.isArray(
      projection.canonical.graph.nodes
    ) ||
    !Array.isArray(
      projection.canonical.graph.edges
    ) ||
    !projection.presentation ||
    !Array.isArray(projection.presentation.nodes) ||
    !Array.isArray(projection.presentation.edges)
  ) {
    throw new TypeError(
      'Change impact requires ' +
      EXPLORER_PROJECTION_SCHEMA
    );
  }
}

function uniqueMap(items, keyFor, description) {
  const map = new Map();
  for (const item of items) {
    const key = String(keyFor(item));
    if (map.has(key)) {
      throw new TypeError(
        description + ' IDs must be unique: ' + key
      );
    }
    map.set(key, item);
  }
  return map;
}

function compareImpactItems(a, b) {
  return (
    (a.depth ?? Number.MAX_SAFE_INTEGER) -
      (b.depth ?? Number.MAX_SAFE_INTEGER) ||
    compareText(a.node_id, b.node_id)
  );
}

function compareDecisions(a, b) {
  return (
    (a.depth ?? 0) - (b.depth ?? 0) ||
    compareText(a.decision_id, b.decision_id)
  );
}

function compareText(a, b) {
  const left = String(a);
  const right = String(b);
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
