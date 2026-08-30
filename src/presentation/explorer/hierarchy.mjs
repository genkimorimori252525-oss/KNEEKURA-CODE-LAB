import {
  assertExplorerUiModel
} from './ui-model.mjs';

export const EXPLORER_HIERARCHY_SCHEMA =
  'kneekura.explorer-hierarchy/v1';
export const EXPLORER_SCOPE_SCHEMA =
  'kneekura.explorer-scope/v1';
export const EXPLORER_ROOT_CONTAINER_ID =
  'container:root';

export function createExplorerHierarchy(model) {
  assertExplorerUiModel(model);

  const familyMap = new Map();
  const memberships = [];

  for (const node of [...model.nodes].sort(compareNode)) {
    const family = presentationKey(
      node.data?.display_family,
      'canonical'
    );
    const canonicalKind = presentationKey(
      node.data?.canonical_kind,
      'unknown'
    );

    let familyEntry = familyMap.get(family);
    if (!familyEntry) {
      familyEntry = {
        family,
        node_ids: [],
        kinds: new Map()
      };
      familyMap.set(family, familyEntry);
    }

    familyEntry.node_ids.push(node.id);

    let kindEntry = familyEntry.kinds.get(canonicalKind);
    if (!kindEntry) {
      kindEntry = {
        canonical_kind: canonicalKind,
        node_ids: []
      };
      familyEntry.kinds.set(canonicalKind, kindEntry);
    }
    kindEntry.node_ids.push(node.id);
  }

  const layers = [];
  const containers = [];
  const rootChildren = [];
  const allNodeIds = [...model.nodes]
    .map(node => node.id)
    .sort(compareText);

  containers.push({
    id: EXPLORER_ROOT_CONTAINER_ID,
    kind: 'root',
    key: 'root',
    label: 'All architecture',
    parent_id: null,
    layer_id: null,
    node_ids: allNodeIds,
    child_container_ids: rootChildren
  });

  for (
    const family of [...familyMap.keys()].sort(compareText)
  ) {
    const familyEntry = familyMap.get(family);
    const layerId = layerIdForFamily(family);
    const familyContainerId =
      familyContainerIdForFamily(family);
    const kindContainerIds = [];

    rootChildren.push(familyContainerId);

    const layer = {
      id: layerId,
      key: family,
      label: family,
      container_id: familyContainerId,
      node_ids: [...familyEntry.node_ids].sort(compareText)
    };
    layers.push(layer);

    for (
      const canonicalKind of
      [...familyEntry.kinds.keys()].sort(compareText)
    ) {
      const kindEntry =
        familyEntry.kinds.get(canonicalKind);
      const kindContainerId =
        kindContainerIdForKind(family, canonicalKind);
      kindContainerIds.push(kindContainerId);

      containers.push({
        id: kindContainerId,
        kind: 'kind',
        key: canonicalKind,
        label: canonicalKind,
        parent_id: familyContainerId,
        layer_id: layerId,
        node_ids: [...kindEntry.node_ids].sort(compareText),
        child_container_ids: []
      });

      for (const nodeId of kindEntry.node_ids) {
        memberships.push({
          node_id: nodeId,
          layer_id: layerId,
          family_container_id: familyContainerId,
          kind_container_id: kindContainerId
        });
      }
    }

    containers.push({
      id: familyContainerId,
      kind: 'layer',
      key: family,
      label: family,
      parent_id: EXPLORER_ROOT_CONTAINER_ID,
      layer_id: layerId,
      node_ids: [...familyEntry.node_ids].sort(compareText),
      child_container_ids:
        kindContainerIds.sort(compareText)
    });
  }

  const orderedContainers = [
    containers[0],
    ...containers.slice(1).sort((a, b) =>
      compareText(a.id, b.id)
    )
  ];
  memberships.sort((a, b) =>
    compareText(a.node_id, b.node_id)
  );
  layers.sort((a, b) => compareText(a.id, b.id));

  const hierarchy = {
    schema: EXPLORER_HIERARCHY_SCHEMA,
    model_schema: model.schema,
    source: structuredClone(model.source ?? null),
    layers,
    containers: orderedContainers,
    node_membership: memberships
  };

  assertExplorerHierarchy(model, hierarchy);
  return hierarchy;
}

export function createExplorerScope(
  model,
  hierarchy,
  {
    container_id = EXPLORER_ROOT_CONTAINER_ID,
    enabled_layer_ids = null
  } = {}
) {
  assertExplorerUiModel(model);
  assertExplorerHierarchy(model, hierarchy);

  const container = explorerContainer(
    hierarchy,
    String(container_id)
  );
  if (!container) {
    throw new TypeError(
      'Explorer hierarchy container is unknown: ' +
      String(container_id)
    );
  }

  const allLayerIds = hierarchy.layers
    .map(layer => layer.id)
    .sort(compareText);
  const enabledLayerIds = enabled_layer_ids == null
    ? allLayerIds
    : [...new Set(
        [...enabled_layer_ids].map(value => String(value))
      )].sort(compareText);

  const allLayerSet = new Set(allLayerIds);
  for (const layerId of enabledLayerIds) {
    if (!allLayerSet.has(layerId)) {
      throw new TypeError(
        'Explorer hierarchy layer is unknown: ' + layerId
      );
    }
  }

  const enabledLayerSet = new Set(enabledLayerIds);
  const containerNodeSet = new Set(container.node_ids);
  const membershipByNode = new Map(
    hierarchy.node_membership.map(item => [
      item.node_id,
      item
    ])
  );

  const nodes = model.nodes
    .filter(node => {
      if (!containerNodeSet.has(node.id)) return false;
      const membership = membershipByNode.get(node.id);
      return Boolean(
        membership &&
        enabledLayerSet.has(membership.layer_id)
      );
    })
    .sort(compareNode)
    .map(node => structuredClone(node));

  const visibleNodeSet = new Set(
    nodes.map(node => node.id)
  );
  const edges = model.edges
    .filter(edge =>
      visibleNodeSet.has(edge.source) &&
      visibleNodeSet.has(edge.target)
    )
    .sort(compareEdge)
    .map(edge => structuredClone(edge));

  const hiddenBoundaryEdgeIds = model.edges
    .filter(edge => {
      const sourceVisible =
        visibleNodeSet.has(edge.source);
      const targetVisible =
        visibleNodeSet.has(edge.target);
      return sourceVisible !== targetVisible;
    })
    .map(edge => edge.id)
    .sort(compareText);

  const childContainers = container.child_container_ids
    .map(id => explorerContainer(hierarchy, id))
    .filter(Boolean)
    .map(child => {
      const visibleCount = child.node_ids
        .filter(nodeId => {
          const membership =
            membershipByNode.get(nodeId);
          return Boolean(
            membership &&
            enabledLayerSet.has(membership.layer_id)
          );
        })
        .length;
      return {
        id: child.id,
        kind: child.kind,
        key: child.key,
        label: child.label,
        node_count: visibleCount
      };
    })
    .filter(child => child.node_count > 0)
    .sort((a, b) => compareText(a.id, b.id));

  const scope = {
    schema: EXPLORER_SCOPE_SCHEMA,
    hierarchy_schema: hierarchy.schema,
    model_schema: model.schema,
    container_id: container.id,
    enabled_layer_ids: enabledLayerIds,
    breadcrumbs:
      explorerBreadcrumbs(hierarchy, container.id),
    child_containers: childContainers,
    visible_node_ids:
      nodes.map(node => node.id),
    visible_edge_ids:
      edges.map(edge => edge.id),
    hidden_boundary_edge_ids: hiddenBoundaryEdgeIds,
    nodes,
    edges
  };

  assertExplorerScope(model, hierarchy, scope);
  return scope;
}

export function searchExplorerScopeNodes(scope, query) {
  assertScopeShape(scope);
  const needle = normalizeSearch(query);
  if (!needle) return [];

  return scope.nodes
    .filter(node => {
      const haystack = normalizeSearch([
        node.id,
        node.data?.label,
        node.data?.canonical_kind,
        node.data?.display_family
      ].join(' '));
      return haystack.includes(needle);
    })
    .map(node => node.id);
}

export function explorerContainer(hierarchy, id) {
  if (
    !hierarchy ||
    hierarchy.schema !== EXPLORER_HIERARCHY_SCHEMA ||
    !Array.isArray(hierarchy.containers)
  ) {
    throw new TypeError(
      'Explorer hierarchy must use ' +
      EXPLORER_HIERARCHY_SCHEMA
    );
  }
  return hierarchy.containers.find(
    item => item.id === String(id)
  ) ?? null;
}

export function explorerBreadcrumbs(hierarchy, id) {
  const result = [];
  let current = explorerContainer(hierarchy, id);
  const seen = new Set();

  while (current) {
    if (seen.has(current.id)) {
      throw new TypeError(
        'Explorer hierarchy contains a parent cycle'
      );
    }
    seen.add(current.id);
    result.push({
      id: current.id,
      kind: current.kind,
      label: current.label
    });
    current = current.parent_id
      ? explorerContainer(hierarchy, current.parent_id)
      : null;
  }

  return result.reverse();
}

export function assertExplorerHierarchy(model, hierarchy) {
  assertExplorerUiModel(model);

  if (
    !hierarchy ||
    hierarchy.schema !== EXPLORER_HIERARCHY_SCHEMA ||
    !Array.isArray(hierarchy.layers) ||
    !Array.isArray(hierarchy.containers) ||
    !Array.isArray(hierarchy.node_membership)
  ) {
    throw new TypeError(
      'Explorer hierarchy must use ' +
      EXPLORER_HIERARCHY_SCHEMA
    );
  }

  const modelNodeIds = model.nodes
    .map(node => node.id)
    .sort(compareText);
  const root = explorerContainer(
    hierarchy,
    EXPLORER_ROOT_CONTAINER_ID
  );
  if (!root) {
    throw new TypeError(
      'Explorer hierarchy root container is missing'
    );
  }
  if (
    JSON.stringify(root.node_ids) !==
    JSON.stringify(modelNodeIds)
  ) {
    throw new TypeError(
      'Explorer hierarchy root must trace every UI node'
    );
  }

  const membershipIds = hierarchy.node_membership
    .map(item => item.node_id)
    .sort(compareText);
  if (
    JSON.stringify(membershipIds) !==
    JSON.stringify(modelNodeIds)
  ) {
    throw new TypeError(
      'Explorer hierarchy membership must be one-to-one'
    );
  }

  const modelNodeSet = new Set(modelNodeIds);
  const containerIds = new Set();
  for (const container of hierarchy.containers) {
    if (containerIds.has(container.id)) {
      throw new TypeError(
        'Explorer hierarchy container IDs must be unique'
      );
    }
    containerIds.add(container.id);
    for (const nodeId of container.node_ids) {
      if (!modelNodeSet.has(nodeId)) {
        throw new TypeError(
          'Explorer hierarchy container references foreign node: ' +
          nodeId
        );
      }
    }
  }

  for (const item of hierarchy.node_membership) {
    const layer = hierarchy.layers.find(
      entry => entry.id === item.layer_id
    );
    if (!layer) {
      throw new TypeError(
        'Explorer hierarchy membership references foreign layer'
      );
    }
    if (
      !containerIds.has(item.family_container_id) ||
      !containerIds.has(item.kind_container_id)
    ) {
      throw new TypeError(
        'Explorer hierarchy membership references foreign container'
      );
    }
  }

  return hierarchy;
}

function assertExplorerScope(model, hierarchy, scope) {
  assertScopeShape(scope);

  const modelNodeIds = new Set(
    model.nodes.map(node => node.id)
  );
  const modelEdgeById = new Map(
    model.edges.map(edge => [edge.id, edge])
  );
  const visibleNodeSet =
    new Set(scope.visible_node_ids);

  for (const node of scope.nodes) {
    if (
      !modelNodeIds.has(node.id) ||
      !visibleNodeSet.has(node.id)
    ) {
      throw new TypeError(
        'Explorer scope contains a foreign node'
      );
    }
  }

  for (const edge of scope.edges) {
    const canonicalUiEdge = modelEdgeById.get(edge.id);
    if (
      !canonicalUiEdge ||
      canonicalUiEdge.source !== edge.source ||
      canonicalUiEdge.target !== edge.target ||
      canonicalUiEdge.data?.canonical_type !==
        edge.data?.canonical_type
    ) {
      throw new TypeError(
        'Explorer scope edge trace mismatch: ' + edge.id
      );
    }
    if (
      !visibleNodeSet.has(edge.source) ||
      !visibleNodeSet.has(edge.target)
    ) {
      throw new TypeError(
        'Explorer scope edge endpoint is hidden'
      );
    }
  }

  for (const edgeId of scope.hidden_boundary_edge_ids) {
    if (!modelEdgeById.has(edgeId)) {
      throw new TypeError(
        'Explorer scope boundary references foreign edge'
      );
    }
  }

  if (!explorerContainer(hierarchy, scope.container_id)) {
    throw new TypeError(
      'Explorer scope container is foreign'
    );
  }
  return scope;
}

function assertScopeShape(scope) {
  if (
    !scope ||
    scope.schema !== EXPLORER_SCOPE_SCHEMA ||
    !Array.isArray(scope.nodes) ||
    !Array.isArray(scope.edges) ||
    !Array.isArray(scope.breadcrumbs) ||
    !Array.isArray(scope.child_containers)
  ) {
    throw new TypeError(
      'Explorer scope must use ' +
      EXPLORER_SCOPE_SCHEMA
    );
  }
}

function layerIdForFamily(family) {
  return 'layer:' + encodeURIComponent(family);
}

function familyContainerIdForFamily(family) {
  return 'container:family:' +
    encodeURIComponent(family);
}

function kindContainerIdForKind(family, canonicalKind) {
  return 'container:kind:' +
    encodeURIComponent(family) + ':' +
    encodeURIComponent(canonicalKind);
}

function presentationKey(value, fallback) {
  const text = String(value ?? '');
  return text.length > 0 ? text : fallback;
}

function normalizeSearch(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase();
}

function compareNode(a, b) {
  return compareText(a.id, b.id);
}

function compareEdge(a, b) {
  return compareText(a.id, b.id);
}

function compareText(a, b) {
  const left = String(a);
  const right = String(b);
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
