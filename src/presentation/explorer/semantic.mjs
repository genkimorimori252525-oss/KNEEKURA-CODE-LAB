import {
  assertExplorerUiModel
} from './ui-model.mjs';
import {
  EXPLORER_PROJECTION_SCHEMA
} from './schema.mjs';

export const EXPLORER_SEMANTIC_MODEL_SCHEMA =
  'kneekura.explorer-semantic-visual/v1';

export const EXPLORER_SEMANTIC_DOMAINS =
  Object.freeze([
    'source',
    'forge',
    'network',
    'runtime',
    'molang',
    'animation',
    'bone',
    'resource',
    'semantic',
    'external',
    'canonical'
  ]);

export function createExplorerSemanticModel(
  projection,
  model
) {
  assertProjectionShape(projection);
  assertExplorerUiModel(model);

  const nodeMetaById = uniqueMap(
    projection.presentation.nodes,
    item => item.node_id,
    'Presentation node'
  );
  const edgeMetaById = uniqueMap(
    projection.presentation.edges,
    item => item.edge_id,
    'Presentation edge'
  );
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

  const claimsByNode = groupByNode(
    projection.presentation.claims,
    item => item.subject_node_id
  );
  const coverageByNode = groupByNode(
    projection.presentation.coverage,
    item => item.node_id
  );

  const nodes = model.nodes
    .map(node => {
      const meta = nodeMetaById.get(node.id);
      const canonical = canonicalNodeById.get(node.id);
      if (
        !meta ||
        !canonical ||
        meta.node_id !== canonical.id ||
        meta.canonical_kind !== canonical.kind ||
        node.data?.canonical_node_id !== canonical.id ||
        node.data?.canonical_kind !== canonical.kind
      ) {
        throw new TypeError(
          'Explorer semantic node trace mismatch: ' +
          String(node.id)
        );
      }

      const claims = claimsByNode.get(node.id) ?? [];
      const coverage =
        coverageByNode.get(node.id) ?? [];
      const claimStatuses = sortedUnique(
        claims.map(item => item.status)
      );
      const coverageStatuses = sortedUnique(
        coverage.map(item => item.status)
      );

      return {
        node_id: node.id,
        domain: semanticDomainForNode(
          canonical.kind,
          meta.display_family
        ),
        canonical_kind: canonical.kind,
        display_family: meta.display_family,
        runtime_observation:
          explicitRuntimeObservation(canonical),
        claim_statuses: claimStatuses,
        coverage_statuses: coverageStatuses,
        claim_status_tokens: claimStatuses.map(
          status => ({
            status,
            tone: semanticStatusTone(status)
          })
        ),
        coverage_status_tokens:
          coverageStatuses.map(status => ({
            status,
            tone: semanticStatusTone(status)
          })),
        evidence_link_count: claims.reduce(
          (sum, item) =>
            sum + arrayLength(item.evidence_links),
          0
        ),
        counterevidence_link_count: claims.reduce(
          (sum, item) =>
            sum +
            arrayLength(item.counterevidence_links),
          0
        )
      };
    })
    .sort((a, b) =>
      compareText(a.node_id, b.node_id)
    );

  const edges = model.edges
    .map(edge => {
      const meta = edgeMetaById.get(edge.id);
      const canonical = canonicalEdgeById.get(edge.id);
      if (
        !meta ||
        !canonical ||
        meta.edge_id !== canonical.id ||
        meta.from_node_id !== canonical.from ||
        meta.to_node_id !== canonical.to ||
        meta.canonical_type !== canonical.type ||
        edge.source !== canonical.from ||
        edge.target !== canonical.to ||
        edge.data?.canonical_edge_id !== canonical.id ||
        edge.data?.canonical_type !== canonical.type
      ) {
        throw new TypeError(
          'Explorer semantic edge trace mismatch: ' +
          String(edge.id)
        );
      }

      return {
        edge_id: edge.id,
        domain: semanticDomainForEdge(
          canonical.type,
          canonical
        ),
        canonical_type: canonical.type,
        source: canonical.from,
        target: canonical.to,
        runtime_observation:
          explicitRuntimeObservation(canonical),
        transport_stage:
          typeof canonical.transport_stage === 'string'
            ? canonical.transport_stage
            : null
      };
    })
    .sort((a, b) =>
      compareText(a.edge_id, b.edge_id)
    );

  return {
    schema: EXPLORER_SEMANTIC_MODEL_SCHEMA,
    projection_schema: projection.schema,
    model_schema: model.schema,
    source: structuredClone(projection.source ?? null),
    analysis: {
      status:
        typeof projection.canonical.result.status ===
        'string'
          ? projection.canonical.result.status
          : null,
      status_tone: semanticStatusTone(
        projection.canonical.result.status
      ),
      unknown_count: Array.isArray(
        projection.canonical.result.unknowns
      )
        ? projection.canonical.result.unknowns.length
        : 0
    },
    nodes,
    edges
  };
}

export function createExplorerSemanticNodeDetail(
  projection,
  semanticModel,
  nodeId
) {
  assertProjectionShape(projection);
  assertSemanticModel(semanticModel);

  const id = String(nodeId);
  const decoration = semanticModel.nodes.find(
    item => item.node_id === id
  );
  const meta = projection.presentation.nodes.find(
    item => item.node_id === id
  );
  if (!decoration || !meta) return null;

  const canonical =
    projection.canonical.graph.nodes[
      meta.canonical_index
    ];
  if (
    !canonical ||
    canonical.id !== id ||
    canonical.kind !== meta.canonical_kind
  ) {
    throw new TypeError(
      'Explorer semantic node detail trace mismatch: ' +
      id
    );
  }

  const claims = projection.presentation.claims
    .filter(item => item.subject_node_id === id)
    .map(item => ({
      claim_id: item.claim_id,
      type: item.type,
      status: item.status,
      status_tone: semanticStatusTone(item.status),
      evidence_links:
        structuredClone(item.evidence_links ?? []),
      counterevidence_links:
        structuredClone(
          item.counterevidence_links ?? []
        ),
      coverage_ref: item.coverage_ref ?? null
    }))
    .sort((a, b) =>
      compareText(a.claim_id, b.claim_id)
    );

  const coverage = projection.presentation.coverage
    .filter(item => item.node_id === id)
    .map(item => ({
      coverage_id: item.coverage_id,
      role: item.role,
      status: item.status,
      status_tone: semanticStatusTone(item.status)
    }))
    .sort((a, b) =>
      compareText(a.coverage_id, b.coverage_id)
    );

  return {
    node_id: id,
    decoration: structuredClone(decoration),
    canonical_node: structuredClone(canonical),
    claims,
    coverage
  };
}

export function createExplorerSemanticEdgeDetail(
  projection,
  semanticModel,
  edgeId
) {
  assertProjectionShape(projection);
  assertSemanticModel(semanticModel);

  const id = String(edgeId);
  const decoration = semanticModel.edges.find(
    item => item.edge_id === id
  );
  const meta = projection.presentation.edges.find(
    item => item.edge_id === id
  );
  if (!decoration || !meta) return null;

  const canonical =
    projection.canonical.graph.edges[
      meta.canonical_index
    ];
  if (
    !canonical ||
    canonical.id !== id ||
    canonical.from !== meta.from_node_id ||
    canonical.to !== meta.to_node_id ||
    canonical.type !== meta.canonical_type
  ) {
    throw new TypeError(
      'Explorer semantic edge detail trace mismatch: ' +
      id
    );
  }

  return {
    edge_id: id,
    decoration: structuredClone(decoration),
    canonical_edge: structuredClone(canonical)
  };
}

export function summarizeExplorerSemanticScope(
  semanticModel,
  scope
) {
  assertSemanticModel(semanticModel);
  if (
    !scope ||
    !Array.isArray(scope.visible_node_ids) ||
    !Array.isArray(scope.visible_edge_ids)
  ) {
    throw new TypeError(
      'Explorer semantic scope summary requires a scope'
    );
  }

  const visibleNodes = new Set(
    scope.visible_node_ids
  );
  const visibleEdges = new Set(
    scope.visible_edge_ids
  );
  const nodeCounts = new Map();
  const edgeCounts = new Map();

  for (const item of semanticModel.nodes) {
    if (!visibleNodes.has(item.node_id)) continue;
    nodeCounts.set(
      item.domain,
      (nodeCounts.get(item.domain) ?? 0) + 1
    );
  }
  for (const item of semanticModel.edges) {
    if (!visibleEdges.has(item.edge_id)) continue;
    edgeCounts.set(
      item.domain,
      (edgeCounts.get(item.domain) ?? 0) + 1
    );
  }

  return {
    node_domains: EXPLORER_SEMANTIC_DOMAINS
      .filter(domain => nodeCounts.has(domain))
      .map(domain => ({
        domain,
        count: nodeCounts.get(domain)
      })),
    edge_domains: EXPLORER_SEMANTIC_DOMAINS
      .filter(domain => edgeCounts.has(domain))
      .map(domain => ({
        domain,
        count: edgeCounts.get(domain)
      }))
  };
}

export function semanticDomainForNode(
  canonicalKind,
  displayFamily
) {
  const kind = String(canonicalKind ?? '')
    .toLowerCase();
  const family = String(displayFamily ?? '')
    .toLowerCase();

  if (kind.includes('molang')) return 'molang';
  if (kind.includes('bone')) return 'bone';
  if (kind.includes('animation')) return 'animation';
  if (
    kind.includes('geometry') ||
    kind.includes('texture') ||
    kind.includes('sound') ||
    kind.includes('resource') ||
    kind.includes('model')
  ) {
    return 'resource';
  }

  if (
    EXPLORER_SEMANTIC_DOMAINS.includes(family)
  ) {
    return family;
  }
  return 'canonical';
}

export function semanticDomainForEdge(
  canonicalType,
  canonicalEdge = null
) {
  const type = String(canonicalType ?? '')
    .toUpperCase();

  if (
    type.includes('PACKET') ||
    type.includes('NETWORK') ||
    type.includes('CHANNEL')
  ) {
    return 'network';
  }
  if (type.includes('MOLANG')) return 'molang';
  if (type.includes('BONE')) return 'bone';
  if (type.includes('ANIMATION')) return 'animation';
  if (
    type.includes('GEOMETRY') ||
    type.includes('TEXTURE') ||
    type.includes('SOUND') ||
    type.includes('RESOURCE') ||
    type.includes('MODEL')
  ) {
    return 'resource';
  }
  if (
    type.includes('MIXIN') ||
    type.includes('REGISTRY') ||
    type.includes('EVENTBUS') ||
    type.includes('EVENT_BUS') ||
    type.includes('FORGE')
  ) {
    return 'forge';
  }
  if (
    type.startsWith('OBSERVED_') ||
    explicitRuntimeObservation(canonicalEdge) ===
      'observed'
  ) {
    return 'runtime';
  }
  return 'canonical';
}

export function semanticStatusTone(status) {
  const value = String(status ?? '')
    .toUpperCase();

  if (value === 'FAILED') return 'failed';
  if (
    value === 'UNRESOLVED' ||
    value === 'UNKNOWN' ||
    value === 'UNEXPLORED'
  ) {
    return 'unknown';
  }
  if (
    value === 'VERIFIED_WITH_LIMITS' ||
    value === 'PARTIAL' ||
    value === 'WARNING' ||
    value === 'WARN'
  ) {
    return 'limited';
  }
  if (
    value === 'VERIFIED' ||
    value === 'PASS'
  ) {
    return 'verified';
  }
  if (value === 'ANALYZED') return 'analyzed';
  return 'neutral';
}

function explicitRuntimeObservation(record) {
  if (!record || typeof record !== 'object') {
    return null;
  }
  if (record.runtimeObservation === true) {
    return 'observed';
  }
  if (record.runtimeObservation === false) {
    return 'unobserved';
  }
  if (record.runtime_observed === true) {
    return 'observed';
  }
  if (record.runtime_observed === false) {
    return 'unobserved';
  }
  return null;
}

function assertProjectionShape(projection) {
  if (
    !projection ||
    projection.schema !== EXPLORER_PROJECTION_SCHEMA ||
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
      'Explorer semantic visualization requires ' +
      EXPLORER_PROJECTION_SCHEMA
    );
  }
}

function assertSemanticModel(model) {
  if (
    !model ||
    model.schema !== EXPLORER_SEMANTIC_MODEL_SCHEMA ||
    !Array.isArray(model.nodes) ||
    !Array.isArray(model.edges)
  ) {
    throw new TypeError(
      'Explorer semantic model must use ' +
      EXPLORER_SEMANTIC_MODEL_SCHEMA
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

function groupByNode(items, keyFor) {
  const map = new Map();
  for (const item of items) {
    const key = keyFor(item);
    if (typeof key !== 'string') continue;
    const bucket = map.get(key) ?? [];
    bucket.push(item);
    map.set(key, bucket);
  }
  return map;
}

function sortedUnique(values) {
  return [...new Set(
    values
      .filter(value => typeof value === 'string')
      .map(value => value)
  )].sort(compareText);
}

function arrayLength(value) {
  return Array.isArray(value) ? value.length : 0;
}

function compareText(a, b) {
  const left = String(a);
  const right = String(b);
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
