import {
  validateAnalysisResultV1
} from '../../core/schema/v1.mjs';
import {
  digestCanonicalAnalysisResult
} from '../../viewer/bundle.mjs';
import {
  EXPLORER_PROJECTION_SCHEMA,
  SEMANTIC_DISPLAY_KINDS
} from './schema.mjs';

const GRAPH_SCHEMA = 'kneekura.graph/v1';

export function createExplorerProjection({ graph, result }) {
  validateExplorerGraph(graph);
  validateAnalysisResultV1(result);
  const sourceIdentity =
    correlateCanonicalInputs(graph, result);

  const analysisResultDigest =
    digestCanonicalAnalysisResult(result);

  const canonicalGraph = structuredClone(graph);
  const canonicalResult = structuredClone(result);

  const nodes = graph.nodes
    .map((node, canonicalIndex) => ({
      node_id: node.id,
      canonical_index: canonicalIndex,
      canonical_kind: node.kind,
      display_family: displayFamilyForKind(node.kind),
      label: presentationLabel(node)
    }))
    .sort(compareNodeMetadata);

  const edges = graph.edges
    .map((edge, canonicalIndex) => ({
      edge_id: edge.id,
      canonical_index: canonicalIndex,
      from_node_id: edge.from,
      to_node_id: edge.to,
      canonical_type: edge.type
    }))
    .sort(compareEdgeMetadata);

  const claims = (result.claims ?? [])
    .map((claim, canonicalIndex) => ({
      claim_id: claim.id,
      canonical_index: canonicalIndex,
      subject_node_id:
        typeof claim?.subject?.node_id === 'string'
          ? claim.subject.node_id
          : null,
      type: claim.type,
      status: claim.status,
      evidence_links:
        structuredClone(claim.evidence_links ?? []),
      counterevidence_links:
        structuredClone(claim.counterevidence_links ?? []),
      coverage_ref: claim.coverage_ref
    }))
    .sort(compareClaimMetadata);

  const coverage = (result.coverage?.entries ?? [])
    .map((entry, canonicalIndex) => ({
      coverage_id: entry.id,
      canonical_index: canonicalIndex,
      node_id:
        typeof entry.node_id === 'string'
          ? entry.node_id
          : null,
      role: entry.role,
      status: entry.status
    }))
    .sort(compareCoverageMetadata);

  const projection = {
    schema: EXPLORER_PROJECTION_SCHEMA,
    source: {
      graph_schema: graph.schema,
      analysis_result_schema: result.schema,
      analysis_id: result.analysis_id,
      session_id: result.session_id,
      repository_id: result.repository?.repository_id ?? null,
      graph_repository_id:
        sourceIdentity.graph_repository_id,
      snapshot_id: result.snapshot?.snapshot_id ?? null,
      graph_snapshot_id:
        sourceIdentity.graph_snapshot_id,
      identity_correlation: {
        repository: sourceIdentity.repository,
        snapshot: sourceIdentity.snapshot
      },
      analysis_result_digest: analysisResultDigest
    },
    canonical: {
      graph: canonicalGraph,
      result: canonicalResult
    },
    presentation: {
      nodes,
      edges,
      claims,
      coverage
    },
    traceability: {
      canonical_node_count: graph.nodes.length,
      presentation_node_count: nodes.length,
      canonical_edge_count: graph.edges.length,
      presentation_edge_count: edges.length,
      canonical_claim_count: result.claims?.length ?? 0,
      presentation_claim_count: claims.length,
      canonical_coverage_count:
        result.coverage?.entries?.length ?? 0,
      presentation_coverage_count: coverage.length
    }
  };

  assertOneToOneTraceability(projection);
  return projection;
}

export function displayFamilyForKind(kind) {
  const canonicalKind = requireString(
    kind,
    'node.kind'
  );
  const lower = canonicalKind.toLowerCase();

  if (
    SEMANTIC_DISPLAY_KINDS.includes(canonicalKind) ||
    lower.includes('molang') ||
    lower.includes('animation') ||
    lower.includes('bone') ||
    lower.includes('model')
  ) {
    return 'semantic';
  }

  if (
    lower.startsWith('runtime_') ||
    lower.includes('runtime')
  ) {
    return 'runtime';
  }

  if (
    lower.includes('packet') ||
    lower.includes('network') ||
    lower.includes('channel')
  ) {
    return 'network';
  }

  if (
    lower.includes('mixin') ||
    lower.includes('registry') ||
    lower.includes('eventbus') ||
    lower.includes('event_bus') ||
    lower === 'mod' ||
    lower.startsWith('forge')
  ) {
    return 'forge';
  }

  if (
    lower === 'file' ||
    lower === 'package' ||
    lower === 'class' ||
    lower === 'interface' ||
    lower === 'method' ||
    lower === 'field' ||
    lower.startsWith('java_')
  ) {
    return 'source';
  }

  if (
    lower.startsWith('external') ||
    lower.startsWith('ua:')
  ) {
    return 'external';
  }

  return 'canonical';
}

export function validateExplorerGraph(graph) {
  if (!graph || typeof graph !== 'object' || Array.isArray(graph)) {
    throw new TypeError('Explorer graph must be an object');
  }
  if (graph.schema !== GRAPH_SCHEMA) {
    throw new TypeError(
      'Explorer graph schema must equal ' + GRAPH_SCHEMA
    );
  }
  if (!Array.isArray(graph.nodes)) {
    throw new TypeError('Explorer graph nodes must be an array');
  }
  if (!Array.isArray(graph.edges)) {
    throw new TypeError('Explorer graph edges must be an array');
  }

  const nodeIds = new Set();
  for (const node of graph.nodes) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
      throw new TypeError('Explorer graph node must be an object');
    }
    const id = requireString(node.id, 'node.id');
    requireString(node.kind, 'node.kind');
    if (nodeIds.has(id)) {
      throw new TypeError(
        'Explorer graph node IDs must be unique: ' + id
      );
    }
    nodeIds.add(id);
  }

  const edgeIds = new Set();
  for (const edge of graph.edges) {
    if (!edge || typeof edge !== 'object' || Array.isArray(edge)) {
      throw new TypeError('Explorer graph edge must be an object');
    }
    const id = requireString(edge.id, 'edge.id');
    const from = requireString(edge.from, 'edge.from');
    const to = requireString(edge.to, 'edge.to');
    requireString(edge.type, 'edge.type');

    if (edgeIds.has(id)) {
      throw new TypeError(
        'Explorer graph edge IDs must be unique: ' + id
      );
    }
    edgeIds.add(id);

    if (!nodeIds.has(from) || !nodeIds.has(to)) {
      throw new TypeError(
        'Explorer graph edge endpoint is missing: ' +
        id + ' (' + from + ' -> ' + to + ')'
      );
    }
  }

  return graph;
}

function correlateCanonicalInputs(graph, result) {
  const graphRepositoryId = optionalIdentityString(
    graph.meta?.repository?.repository_id,
    'graph.meta.repository.repository_id'
  );
  const resultRepositoryId =
    result.repository?.repository_id ?? null;
  const graphSnapshotId = optionalIdentityString(
    graph.meta?.snapshot?.snapshot_id,
    'graph.meta.snapshot.snapshot_id'
  );
  const resultSnapshotId =
    result.snapshot?.snapshot_id ?? null;

  if (
    graphRepositoryId != null &&
    graphRepositoryId !== resultRepositoryId
  ) {
    throw new TypeError(
      'Explorer Projection repository identity mismatch: ' +
      graphRepositoryId + ' != ' + resultRepositoryId
    );
  }

  if (
    graphSnapshotId != null &&
    graphSnapshotId !== resultSnapshotId
  ) {
    throw new TypeError(
      'Explorer Projection snapshot identity mismatch: ' +
      graphSnapshotId + ' != ' + resultSnapshotId
    );
  }

  return {
    graph_repository_id: graphRepositoryId,
    graph_snapshot_id: graphSnapshotId,
    repository:
      graphRepositoryId == null ? 'UNAVAILABLE' : 'MATCH',
    snapshot:
      graphSnapshotId == null ? 'UNAVAILABLE' : 'MATCH'
  };
}

function optionalIdentityString(value, label) {
  if (value == null) return null;
  return requireString(value, label);
}

function assertOneToOneTraceability(projection) {
  const canonicalNodeIds = new Set(
    projection.canonical.graph.nodes.map(node => node.id)
  );
  const presentationNodeIds = new Set(
    projection.presentation.nodes.map(node => node.node_id)
  );
  if (
    canonicalNodeIds.size !==
      projection.canonical.graph.nodes.length ||
    presentationNodeIds.size !==
      projection.presentation.nodes.length ||
    !sameSet(canonicalNodeIds, presentationNodeIds)
  ) {
    throw new TypeError(
      'Explorer Projection node traceability is not one-to-one'
    );
  }

  const canonicalEdgeIds = new Set(
    projection.canonical.graph.edges.map(edge => edge.id)
  );
  const presentationEdgeIds = new Set(
    projection.presentation.edges.map(edge => edge.edge_id)
  );
  if (
    canonicalEdgeIds.size !==
      projection.canonical.graph.edges.length ||
    presentationEdgeIds.size !==
      projection.presentation.edges.length ||
    !sameSet(canonicalEdgeIds, presentationEdgeIds)
  ) {
    throw new TypeError(
      'Explorer Projection edge traceability is not one-to-one'
    );
  }

  for (const item of projection.presentation.nodes) {
    const source =
      projection.canonical.graph.nodes[item.canonical_index];
    if (
      !source ||
      source.id !== item.node_id ||
      source.kind !== item.canonical_kind
    ) {
      throw new TypeError(
        'Explorer Projection node source reference mismatch: ' +
        item.node_id
      );
    }
  }

  for (const item of projection.presentation.edges) {
    const source =
      projection.canonical.graph.edges[item.canonical_index];
    if (
      !source ||
      source.id !== item.edge_id ||
      source.from !== item.from_node_id ||
      source.to !== item.to_node_id ||
      source.type !== item.canonical_type
    ) {
      throw new TypeError(
        'Explorer Projection edge source reference mismatch: ' +
        item.edge_id
      );
    }
  }
}

function presentationLabel(node) {
  if (
    typeof node.label === 'string' &&
    node.label.length > 0
  ) {
    return node.label;
  }
  if (
    typeof node.key === 'string' &&
    node.key.length > 0
  ) {
    return node.key;
  }
  return node.id;
}

function compareNodeMetadata(a, b) {
  return compareText(a.node_id, b.node_id);
}

function compareEdgeMetadata(a, b) {
  return compareText(a.edge_id, b.edge_id);
}

function compareClaimMetadata(a, b) {
  return (
    compareText(a.claim_id, b.claim_id) ||
    a.canonical_index - b.canonical_index
  );
}

function compareCoverageMetadata(a, b) {
  return (
    compareText(a.coverage_id, b.coverage_id) ||
    a.canonical_index - b.canonical_index
  );
}

function compareText(a, b) {
  const left = String(a);
  const right = String(b);
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function sameSet(a, b) {
  if (a.size !== b.size) return false;
  for (const value of a) {
    if (!b.has(value)) return false;
  }
  return true;
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(label + ' must be a non-empty string');
  }
  return value;
}
