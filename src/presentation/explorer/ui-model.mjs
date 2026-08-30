export const EXPLORER_UI_MODEL_SCHEMA =
  'kneekura.explorer-ui-model/v1';

const PROJECTION_SCHEMA = 'kneekura.explorer-projection/v1';

export function createExplorerUiModel(projection) {
  assertProjection(projection);

  const canonicalNodes = projection.canonical.graph.nodes;
  const canonicalEdges = projection.canonical.graph.edges;

  const nodes = projection.presentation.nodes
    .map(meta => {
      const canonical = canonicalNodes[meta.canonical_index];
      assertNodeTrace(meta, canonical);

      return {
        id: meta.node_id,
        canonical_index: meta.canonical_index,
        position: { x: 0, y: 0 },
        width: 240,
        height: 72,
        data: {
          label: String(meta.label ?? meta.node_id),
          canonical_kind: meta.canonical_kind,
          display_family: meta.display_family,
          canonical_node_id: meta.node_id
        }
      };
    })
    .sort((a, b) => compareText(a.id, b.id));

  const edges = projection.presentation.edges
    .map(meta => {
      const canonical = canonicalEdges[meta.canonical_index];
      assertEdgeTrace(meta, canonical);

      return {
        id: meta.edge_id,
        canonical_index: meta.canonical_index,
        source: meta.from_node_id,
        target: meta.to_node_id,
        data: {
          canonical_edge_id: meta.edge_id,
          canonical_type: meta.canonical_type
        }
      };
    })
    .sort((a, b) => compareText(a.id, b.id));

  assertUiTraceability(nodes, edges);

  return {
    schema: EXPLORER_UI_MODEL_SCHEMA,
    projection_schema: projection.schema,
    source: structuredClone(projection.source),
    nodes,
    edges
  };
}

export function searchExplorerNodes(model, query) {
  assertUiModel(model);
  const needle = normalizeSearch(query);
  if (!needle) return [];

  return model.nodes
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

export function createExplorerNodeDetail(projection, nodeId) {
  assertProjection(projection);
  const id = String(nodeId);
  const meta = projection.presentation.nodes.find(
    item => item.node_id === id
  );
  if (!meta) return null;

  const canonicalNode =
    projection.canonical.graph.nodes[meta.canonical_index];
  assertNodeTrace(meta, canonicalNode);

  const relations = projection.presentation.edges
    .filter(edge =>
      edge.from_node_id === id ||
      edge.to_node_id === id
    )
    .map(edge => ({
      edge_id: edge.edge_id,
      direction:
        edge.from_node_id === id ? 'out' : 'in',
      other_node_id:
        edge.from_node_id === id
          ? edge.to_node_id
          : edge.from_node_id,
      canonical_type: edge.canonical_type
    }))
    .sort(compareRelation);

  const claims = projection.presentation.claims
    .filter(claim => claim.subject_node_id === id)
    .map(claim => ({
      claim_id: claim.claim_id,
      type: claim.type,
      status: claim.status,
      coverage_ref: claim.coverage_ref ?? null
    }))
    .sort((a, b) => compareText(a.claim_id, b.claim_id));

  const coverage = projection.presentation.coverage
    .filter(entry => entry.node_id === id)
    .map(entry => ({
      coverage_id: entry.coverage_id,
      role: entry.role,
      status: entry.status
    }))
    .sort((a, b) =>
      compareText(a.coverage_id, b.coverage_id)
    );

  return {
    node_id: id,
    canonical_index: meta.canonical_index,
    canonical_kind: meta.canonical_kind,
    display_family: meta.display_family,
    label: String(meta.label ?? id),
    canonical_node: structuredClone(canonicalNode),
    relations,
    claims,
    coverage
  };
}

export function assertExplorerUiModel(model) {
  assertUiModel(model);
  assertUiTraceability(model.nodes, model.edges);
  return model;
}

function assertProjection(projection) {
  if (
    !projection ||
    typeof projection !== 'object' ||
    projection.schema !== PROJECTION_SCHEMA
  ) {
    throw new TypeError(
      'Explorer UI requires ' + PROJECTION_SCHEMA
    );
  }

  if (
    !projection.canonical?.graph ||
    !Array.isArray(projection.canonical.graph.nodes) ||
    !Array.isArray(projection.canonical.graph.edges) ||
    !projection.canonical?.result ||
    !projection.presentation ||
    !Array.isArray(projection.presentation.nodes) ||
    !Array.isArray(projection.presentation.edges) ||
    !Array.isArray(projection.presentation.claims) ||
    !Array.isArray(projection.presentation.coverage)
  ) {
    throw new TypeError(
      'Explorer Projection is missing canonical/presentation arrays'
    );
  }

  const canonicalNodes =
    projection.canonical.graph.nodes;
  const canonicalEdges =
    projection.canonical.graph.edges;
  const canonicalClaims =
    projection.canonical.result.claims ?? [];
  const canonicalCoverage =
    projection.canonical.result.coverage?.entries ?? [];

  if (
    projection.presentation.nodes.length !==
      canonicalNodes.length ||
    projection.presentation.edges.length !==
      canonicalEdges.length ||
    projection.presentation.claims.length !==
      canonicalClaims.length ||
    projection.presentation.coverage.length !==
      canonicalCoverage.length
  ) {
    throw new TypeError(
      'Explorer Projection canonical/presentation counts must remain one-to-one'
    );
  }

  for (const meta of projection.presentation.nodes) {
    assertNodeTrace(
      meta,
      canonicalNodes[meta.canonical_index]
    );
  }
  for (const meta of projection.presentation.edges) {
    assertEdgeTrace(
      meta,
      canonicalEdges[meta.canonical_index]
    );
  }
  for (const meta of projection.presentation.claims) {
    const canonical =
      canonicalClaims[meta.canonical_index];
    if (
      !canonical ||
      canonical.id !== meta.claim_id ||
      canonical.type !== meta.type ||
      canonical.status !== meta.status
    ) {
      throw new TypeError(
        'Explorer UI claim trace mismatch: ' +
        String(meta?.claim_id)
      );
    }
  }
  for (const meta of projection.presentation.coverage) {
    const canonical =
      canonicalCoverage[meta.canonical_index];
    if (
      !canonical ||
      canonical.id !== meta.coverage_id ||
      canonical.role !== meta.role ||
      canonical.status !== meta.status
    ) {
      throw new TypeError(
        'Explorer UI coverage trace mismatch: ' +
        String(meta?.coverage_id)
      );
    }
  }
}

function assertUiModel(model) {
  if (
    !model ||
    typeof model !== 'object' ||
    model.schema !== EXPLORER_UI_MODEL_SCHEMA ||
    !Array.isArray(model.nodes) ||
    !Array.isArray(model.edges)
  ) {
    throw new TypeError(
      'Explorer UI model must use ' +
      EXPLORER_UI_MODEL_SCHEMA
    );
  }
}

function assertNodeTrace(meta, canonical) {
  if (
    !canonical ||
    canonical.id !== meta.node_id ||
    canonical.kind !== meta.canonical_kind
  ) {
    throw new TypeError(
      'Explorer UI node trace mismatch: ' +
      String(meta?.node_id)
    );
  }
}

function assertEdgeTrace(meta, canonical) {
  if (
    !canonical ||
    canonical.id !== meta.edge_id ||
    canonical.from !== meta.from_node_id ||
    canonical.to !== meta.to_node_id ||
    canonical.type !== meta.canonical_type
  ) {
    throw new TypeError(
      'Explorer UI edge trace mismatch: ' +
      String(meta?.edge_id)
    );
  }
}

function assertUiTraceability(nodes, edges) {
  const nodeIds = new Set(nodes.map(node => node.id));
  if (nodeIds.size !== nodes.length) {
    throw new TypeError(
      'Explorer UI node IDs must remain unique'
    );
  }

  const edgeIds = new Set(edges.map(edge => edge.id));
  if (edgeIds.size !== edges.length) {
    throw new TypeError(
      'Explorer UI edge IDs must remain unique'
    );
  }

  for (const edge of edges) {
    if (
      !nodeIds.has(edge.source) ||
      !nodeIds.has(edge.target)
    ) {
      throw new TypeError(
        'Explorer UI edge endpoint is missing: ' +
        edge.id
      );
    }
  }
}

function normalizeSearch(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase();
}

function compareRelation(a, b) {
  return (
    compareText(a.edge_id, b.edge_id) ||
    compareText(a.direction, b.direction) ||
    compareText(a.other_node_id, b.other_node_id)
  );
}

function compareText(a, b) {
  const left = String(a);
  const right = String(b);
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
