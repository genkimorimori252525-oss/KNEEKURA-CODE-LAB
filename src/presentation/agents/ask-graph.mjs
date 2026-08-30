import {
  validateAnalysisResultV1
} from '../../core/schema/v1.mjs';
import {
  digestCanonicalAnalysisResult
} from '../../viewer/bundle.mjs';
import {
  createExplorerProjection,
  validateExplorerGraph
} from '../explorer/project.mjs';
import {
  EXPLORER_PROJECTION_SCHEMA
} from '../explorer/schema.mjs';

export const ASK_GRAPH_ADAPTER_SCHEMA =
  'kneekura.ask-graph-adapter/v1';
export const ASK_GRAPH_MANIFEST_SCHEMA =
  'kneekura.ask-graph-manifest/v1';
export const ASK_GRAPH_QUERY_SCHEMA =
  'kneekura.ask-graph-query/v1';
export const ASK_GRAPH_RESPONSE_SCHEMA =
  'kneekura.ask-graph-response/v1';

export const ASK_GRAPH_OPERATIONS = Object.freeze([
  'DESCRIBE',
  'FIND_NODES',
  'GET_NODE',
  'NEIGHBORS',
  'GET_REF',
  'NODE_CONTEXT'
]);

export const ASK_GRAPH_REF_KINDS = Object.freeze([
  'NODE',
  'EDGE',
  'CLAIM',
  'EVIDENCE',
  'COVERAGE'
]);

const FIND_FIELDS = Object.freeze([
  'id',
  'kind',
  'key',
  'label',
  'path'
]);
const DIRECTIONS = new Set(['IN', 'OUT', 'BOTH']);
const HARD_MAX_LIMIT = 200;
const HARD_MAX_TEXT_LENGTH = 256;

export function createAskGraphAdapter(
  projection,
  {
    defaultLimit = 25,
    maxLimit = 100
  } = {}
) {
  validateLimits(defaultLimit, maxLimit);

  const snapshot = structuredClone(projection);
  assertAskGraphProjection(snapshot);
  deepFreeze(snapshot);

  const index = buildIndex(snapshot);
  const limits = Object.freeze({
    default_limit: defaultLimit,
    max_limit: maxLimit,
    hard_max_limit: HARD_MAX_LIMIT,
    max_find_text_length: HARD_MAX_TEXT_LENGTH
  });
  const manifest = deepFreeze({
    schema: ASK_GRAPH_MANIFEST_SCHEMA,
    adapter_schema: ASK_GRAPH_ADAPTER_SCHEMA,
    query_schema: ASK_GRAPH_QUERY_SCHEMA,
    response_schema: ASK_GRAPH_RESPONSE_SCHEMA,
    id: 'kneekura-ask-graph',
    version: 'v1',
    source: structuredClone(snapshot.source),
    read_only: true,
    analysis_authority: false,
    target_repository_write: false,
    model_or_provider_calls: false,
    operations: [...ASK_GRAPH_OPERATIONS],
    ref_kinds: [...ASK_GRAPH_REF_KINDS],
    limits: structuredClone(limits),
    trust_boundary: trustBoundary()
  });

  return Object.freeze({
    schema: ASK_GRAPH_ADAPTER_SCHEMA,
    id: manifest.id,
    version: manifest.version,

    describe() {
      return structuredClone(manifest);
    },

    ask(query) {
      const normalized = validateQuery(
        query,
        limits
      );
      return executeQuery(
        snapshot,
        index,
        manifest,
        normalized,
        limits
      );
    }
  });
}

export function createAskGraphAdapterFromCanonical(
  { graph, result },
  options = {}
) {
  return createAskGraphAdapter(
    createExplorerProjection({ graph, result }),
    options
  );
}

function executeQuery(
  snapshot,
  index,
  manifest,
  query,
  limits
) {
  switch (query.operation) {
    case 'DESCRIBE':
      return response(
        snapshot,
        query.operation,
        { manifest: structuredClone(manifest) }
      );
    case 'FIND_NODES':
      return findNodes(
        snapshot,
        index,
        query,
        limits
      );
    case 'GET_NODE':
      return getNode(
        snapshot,
        index,
        query
      );
    case 'NEIGHBORS':
      return neighbors(
        snapshot,
        index,
        query,
        limits
      );
    case 'GET_REF':
      return getRef(
        snapshot,
        index,
        query
      );
    case 'NODE_CONTEXT':
      return nodeContext(
        snapshot,
        index,
        query,
        limits
      );
    default:
      throw new TypeError(
        'unsupported Ask-Graph operation: ' +
        String(query.operation)
      );
  }
}

function findNodes(
  snapshot,
  index,
  query,
  limits
) {
  const limit = query.limit ?? limits.default_limit;
  const fields = query.fields ?? [...FIND_FIELDS];
  const kindSet = query.kinds
    ? new Set(query.kinds)
    : null;
  const needle = query.text.toLowerCase();

  const matches = [];
  for (const node of snapshot.canonical.graph.nodes) {
    if (kindSet && !kindSet.has(node.kind)) continue;
    const matchedFields = [];
    for (const field of fields) {
      const value = canonicalNodeField(node, field);
      if (
        typeof value === 'string' &&
        value.toLowerCase().includes(needle)
      ) {
        matchedFields.push(field);
      }
    }
    if (!matchedFields.length) continue;
    matches.push({
      node_id: node.id,
      canonical_index:
        index.nodeCanonicalIndex.get(node.id),
      canonical_kind: node.kind,
      ...(typeof node.key === 'string'
        ? { key: node.key }
        : {}),
      ...(typeof node.label === 'string'
        ? { label: node.label }
        : {}),
      ...(typeof node.path === 'string'
        ? { path: node.path }
        : {}),
      matched_fields: matchedFields
    });
  }

  matches.sort((a, b) =>
    compareText(a.node_id, b.node_id)
  );
  const collection = bounded(matches, limit);

  return response(
    snapshot,
    query.operation,
    {
      text: query.text,
      fields,
      kinds: query.kinds ?? null,
      selected_node_id: null,
      ambiguous: collection.total_count > 1,
      candidates: collection.items
    },
    collectionMeta(collection)
  );
}

function getNode(
  snapshot,
  index,
  query
) {
  const node = index.nodeById.get(query.node_id);
  if (!node) {
    return response(
      snapshot,
      query.operation,
      {
        found: false,
        node_id: query.node_id,
        node: null,
        trace: null
      }
    );
  }
  return response(
    snapshot,
    query.operation,
    {
      found: true,
      node_id: query.node_id,
      node: structuredClone(node),
      trace: structuredClone(
        index.presentationNodeById.get(query.node_id)
      )
    }
  );
}

function neighbors(
  snapshot,
  index,
  query,
  limits
) {
  const limit = query.limit ?? limits.default_limit;
  const node = index.nodeById.get(query.node_id);
  if (!node) {
    return response(
      snapshot,
      query.operation,
      {
        found: false,
        node_id: query.node_id,
        direction: query.direction,
        edge_types: query.edge_types ?? null,
        relations: []
      },
      {
        returned_count: 0,
        total_count: 0,
        truncated: false
      }
    );
  }

  const relations = collectNeighborRelations(
    index,
    query.node_id,
    query.direction,
    query.edge_types
  );
  const collection = bounded(relations, limit);

  return response(
    snapshot,
    query.operation,
    {
      found: true,
      node_id: query.node_id,
      direction: query.direction,
      edge_types: query.edge_types ?? null,
      relations: collection.items
    },
    collectionMeta(collection)
  );
}

function getRef(
  snapshot,
  index,
  query
) {
  const map = mapForRefKind(index, query.ref_kind);
  const value = map.get(query.ref);
  if (!value) {
    return response(
      snapshot,
      query.operation,
      {
        found: false,
        ref_kind: query.ref_kind,
        ref: query.ref,
        value: null,
        trace: null
      }
    );
  }

  return response(
    snapshot,
    query.operation,
    {
      found: true,
      ref_kind: query.ref_kind,
      ref: query.ref,
      value: structuredClone(value),
      trace: traceForRef(
        index,
        query.ref_kind,
        query.ref
      )
    }
  );
}

function nodeContext(
  snapshot,
  index,
  query,
  limits
) {
  const limit = query.limit ?? limits.default_limit;
  const node = index.nodeById.get(query.node_id);
  if (!node) {
    return response(
      snapshot,
      query.operation,
      {
        found: false,
        node_id: query.node_id,
        node: null,
        trace: null,
        neighbors: emptyCollection(),
        claims: emptyCollection(),
        coverage: emptyCollection(),
        evidence_links: emptyCollection()
      }
    );
  }

  const neighborCollection = bounded(
    collectNeighborRelations(
      index,
      query.node_id,
      query.direction,
      query.edge_types
    ),
    limit
  );

  const matchingClaims = [
    ...index.claimById.values()
  ]
    .filter(claim =>
      claim?.subject?.node_id === query.node_id
    )
    .sort((a, b) => compareText(a.id, b.id));
  const claimCollection = bounded(
    matchingClaims.map(item =>
      structuredClone(item)
    ),
    limit
  );

  const matchingCoverage = [
    ...index.coverageById.values()
  ]
    .filter(entry =>
      entry?.node_id === query.node_id
    )
    .sort((a, b) => compareText(a.id, b.id));
  const coverageCollection = bounded(
    matchingCoverage.map(item =>
      structuredClone(item)
    ),
    limit
  );

  const evidenceLinks = [];
  for (const claim of matchingClaims) {
    for (const link of claim.evidence_links ?? []) {
      evidenceLinks.push({
        claim_id: claim.id,
        source_field: 'evidence_links',
        link: structuredClone(link)
      });
    }
    for (
      const link of claim.counterevidence_links ?? []
    ) {
      evidenceLinks.push({
        claim_id: claim.id,
        source_field: 'counterevidence_links',
        link: structuredClone(link)
      });
    }
  }
  evidenceLinks.sort(
    (a, b) =>
      compareText(a.claim_id, b.claim_id) ||
      compareText(
        a.link?.evidence_id,
        b.link?.evidence_id
      ) ||
      compareText(
        a.source_field,
        b.source_field
      )
  );
  const evidenceCollection = bounded(
    evidenceLinks,
    limit
  );

  const anyTruncated =
    neighborCollection.truncated ||
    claimCollection.truncated ||
    coverageCollection.truncated ||
    evidenceCollection.truncated;

  return response(
    snapshot,
    query.operation,
    {
      found: true,
      node_id: query.node_id,
      node: structuredClone(node),
      trace: structuredClone(
        index.presentationNodeById.get(query.node_id)
      ),
      direction: query.direction,
      edge_types: query.edge_types ?? null,
      neighbors: neighborCollection,
      claims: claimCollection,
      coverage: coverageCollection,
      evidence_links: evidenceCollection
    },
    {
      truncated: anyTruncated
    }
  );
}

function collectNeighborRelations(
  index,
  nodeId,
  direction,
  edgeTypes
) {
  const filter = edgeTypes
    ? new Set(edgeTypes)
    : null;
  const byEdgeId = new Map();

  const include = (edge, relationDirection) => {
    if (filter && !filter.has(edge.type)) return;
    const adjacentId =
      edge.from === nodeId && edge.to === nodeId
        ? nodeId
        : relationDirection === 'OUT'
          ? edge.to
          : edge.from;
    byEdgeId.set(edge.id, {
      edge: structuredClone(edge),
      trace: structuredClone(
        index.presentationEdgeById.get(edge.id)
      ),
      direction:
        edge.from === nodeId && edge.to === nodeId
          ? 'SELF'
          : relationDirection,
      adjacent_node_id: adjacentId,
      adjacent_node: structuredClone(
        index.nodeById.get(adjacentId)
      )
    });
  };

  if (direction === 'OUT' || direction === 'BOTH') {
    for (const edge of index.outgoing.get(nodeId) ?? []) {
      include(edge, 'OUT');
    }
  }
  if (direction === 'IN' || direction === 'BOTH') {
    for (const edge of index.incoming.get(nodeId) ?? []) {
      include(edge, 'IN');
    }
  }

  return [...byEdgeId.values()].sort((a, b) =>
    index.edgeCanonicalIndex.get(a.edge.id) -
      index.edgeCanonicalIndex.get(b.edge.id) ||
    compareText(a.edge.id, b.edge.id)
  );
}

function validateQuery(query, limits) {
  requireObject(query, 'Ask-Graph query');
  if (query.schema !== ASK_GRAPH_QUERY_SCHEMA) {
    throw new TypeError(
      'Ask-Graph query schema must equal ' +
      ASK_GRAPH_QUERY_SCHEMA
    );
  }
  if (!ASK_GRAPH_OPERATIONS.includes(query.operation)) {
    throw new TypeError(
      'unsupported Ask-Graph operation: ' +
      String(query.operation)
    );
  }

  const common = ['schema', 'operation'];
  const allowed = {
    DESCRIBE: common,
    FIND_NODES: [
      ...common,
      'text',
      'fields',
      'kinds',
      'limit'
    ],
    GET_NODE: [...common, 'node_id'],
    NEIGHBORS: [
      ...common,
      'node_id',
      'direction',
      'edge_types',
      'limit'
    ],
    GET_REF: [
      ...common,
      'ref_kind',
      'ref'
    ],
    NODE_CONTEXT: [
      ...common,
      'node_id',
      'direction',
      'edge_types',
      'limit'
    ]
  }[query.operation];
  rejectUnknownKeys(query, allowed);

  const out = structuredClone(query);

  if (query.operation === 'FIND_NODES') {
    requireString(query.text, 'text');
    if (query.text.length > HARD_MAX_TEXT_LENGTH) {
      throw new RangeError(
        'Ask-Graph find text exceeds ' +
        HARD_MAX_TEXT_LENGTH + ' characters'
      );
    }
    out.fields = normalizeEnumArray(
      query.fields,
      FIND_FIELDS,
      'fields',
      FIND_FIELDS.length
    );
    if (query.fields == null) delete out.fields;
    out.kinds = normalizeStringArray(
      query.kinds,
      'kinds',
      100
    );
    if (query.kinds == null) delete out.kinds;
    out.limit = normalizeLimit(query.limit, limits);
    if (query.limit == null) delete out.limit;
  }

  if (
    query.operation === 'GET_NODE' ||
    query.operation === 'NEIGHBORS' ||
    query.operation === 'NODE_CONTEXT'
  ) {
    requireString(query.node_id, 'node_id');
  }

  if (
    query.operation === 'NEIGHBORS' ||
    query.operation === 'NODE_CONTEXT'
  ) {
    out.direction = query.direction ?? 'BOTH';
    if (!DIRECTIONS.has(out.direction)) {
      throw new TypeError(
        'direction must be IN, OUT, or BOTH'
      );
    }
    out.edge_types = normalizeStringArray(
      query.edge_types,
      'edge_types',
      100
    );
    if (query.edge_types == null) {
      delete out.edge_types;
    }
    out.limit = normalizeLimit(query.limit, limits);
    if (query.limit == null) delete out.limit;
  }

  if (query.operation === 'GET_REF') {
    if (!ASK_GRAPH_REF_KINDS.includes(query.ref_kind)) {
      throw new TypeError(
        'unsupported Ask-Graph ref_kind: ' +
        String(query.ref_kind)
      );
    }
    requireString(query.ref, 'ref');
  }

  return out;
}

function assertAskGraphProjection(projection) {
  requireObject(projection, 'Ask-Graph projection');
  if (
    projection.schema !==
      EXPLORER_PROJECTION_SCHEMA
  ) {
    throw new TypeError(
      'Ask-Graph requires ' +
      EXPLORER_PROJECTION_SCHEMA
    );
  }
  requireObject(
    projection.canonical,
    'projection.canonical'
  );
  validateExplorerGraph(
    projection.canonical.graph
  );
  validateAnalysisResultV1(
    projection.canonical.result
  );

  const result = projection.canonical.result;
  const digest = digestCanonicalAnalysisResult(
    result
  );
  if (
    projection.source?.graph_schema !==
      projection.canonical.graph.schema ||
    projection.source?.analysis_result_schema !==
      result.schema ||
    projection.source?.analysis_result_digest !==
      digest ||
    projection.source?.analysis_id !==
      result.analysis_id ||
    projection.source?.session_id !==
      result.session_id ||
    projection.source?.snapshot_id !==
      result.snapshot?.snapshot_id
  ) {
    throw new TypeError(
      'Ask-Graph projection source identity/digest mismatch'
    );
  }

  requireObject(
    projection.presentation,
    'projection.presentation'
  );
  for (const key of [
    'nodes',
    'edges',
    'claims',
    'coverage'
  ]) {
    if (!Array.isArray(projection.presentation[key])) {
      throw new TypeError(
        'Ask-Graph presentation.' + key +
        ' must be an array'
      );
    }
  }

  const graph = projection.canonical.graph;
  const nodeMeta = uniqueMap(
    projection.presentation.nodes,
    item => item.node_id,
    'Presentation node'
  );
  const edgeMeta = uniqueMap(
    projection.presentation.edges,
    item => item.edge_id,
    'Presentation edge'
  );
  const claimMeta = uniqueMap(
    projection.presentation.claims,
    item => item.claim_id,
    'Presentation claim'
  );
  const coverageMeta = uniqueMap(
    projection.presentation.coverage,
    item => item.coverage_id,
    'Presentation coverage'
  );

  if (nodeMeta.size !== graph.nodes.length) {
    throw new TypeError(
      'Ask-Graph node traceability count mismatch'
    );
  }
  if (edgeMeta.size !== graph.edges.length) {
    throw new TypeError(
      'Ask-Graph edge traceability count mismatch'
    );
  }
  if (
    claimMeta.size !== (result.claims ?? []).length
  ) {
    throw new TypeError(
      'Ask-Graph claim traceability count mismatch'
    );
  }
  if (
    coverageMeta.size !==
      (result.coverage?.entries ?? []).length
  ) {
    throw new TypeError(
      'Ask-Graph coverage traceability count mismatch'
    );
  }

  for (
    let i = 0;
    i < graph.nodes.length;
    i++
  ) {
    const node = graph.nodes[i];
    const meta = nodeMeta.get(node.id);
    if (
      !meta ||
      meta.canonical_index !== i ||
      meta.canonical_kind !== node.kind
    ) {
      throw new TypeError(
        'Ask-Graph node trace mismatch: ' +
        node.id
      );
    }
  }
  for (
    let i = 0;
    i < graph.edges.length;
    i++
  ) {
    const edge = graph.edges[i];
    const meta = edgeMeta.get(edge.id);
    if (
      !meta ||
      meta.canonical_index !== i ||
      meta.from_node_id !== edge.from ||
      meta.to_node_id !== edge.to ||
      meta.canonical_type !== edge.type
    ) {
      throw new TypeError(
        'Ask-Graph edge trace mismatch: ' +
        edge.id
      );
    }
  }
  for (
    let i = 0;
    i < (result.claims ?? []).length;
    i++
  ) {
    const claim = result.claims[i];
    const meta = claimMeta.get(claim.id);
    if (
      !meta ||
      meta.canonical_index !== i ||
      meta.type !== claim.type ||
      meta.status !== claim.status ||
      meta.subject_node_id !==
        (
          typeof claim?.subject?.node_id === 'string'
            ? claim.subject.node_id
            : null
        ) ||
      meta.coverage_ref !== claim.coverage_ref ||
      JSON.stringify(meta.evidence_links) !==
        JSON.stringify(claim.evidence_links ?? []) ||
      JSON.stringify(meta.counterevidence_links) !==
        JSON.stringify(
          claim.counterevidence_links ?? []
        )
    ) {
      throw new TypeError(
        'Ask-Graph claim trace mismatch: ' +
        claim.id
      );
    }
  }
  for (
    let i = 0;
    i < (result.coverage?.entries ?? []).length;
    i++
  ) {
    const entry = result.coverage.entries[i];
    const meta = coverageMeta.get(entry.id);
    if (
      !meta ||
      meta.canonical_index !== i ||
      meta.node_id !==
        (
          typeof entry?.node_id === 'string'
            ? entry.node_id
            : null
        ) ||
      meta.role !== entry.role ||
      meta.status !== entry.status
    ) {
      throw new TypeError(
        'Ask-Graph coverage trace mismatch: ' +
        entry.id
      );
    }
  }
}

function buildIndex(snapshot) {
  const graph = snapshot.canonical.graph;
  const result = snapshot.canonical.result;

  const nodeById = uniqueMap(
    graph.nodes,
    item => item.id,
    'Canonical node'
  );
  const edgeById = uniqueMap(
    graph.edges,
    item => item.id,
    'Canonical edge'
  );
  const claimById = uniqueMap(
    result.claims ?? [],
    item => item.id,
    'Canonical Claim'
  );
  const evidenceById = uniqueMap(
    result.evidence ?? [],
    item => item.id,
    'Canonical Evidence'
  );
  const coverageById = uniqueMap(
    result.coverage?.entries ?? [],
    item => item.id,
    'Canonical Coverage'
  );

  const presentationNodeById = uniqueMap(
    snapshot.presentation.nodes,
    item => item.node_id,
    'Presentation node'
  );
  const presentationEdgeById = uniqueMap(
    snapshot.presentation.edges,
    item => item.edge_id,
    'Presentation edge'
  );
  const presentationClaimById = uniqueMap(
    snapshot.presentation.claims,
    item => item.claim_id,
    'Presentation Claim'
  );
  const presentationCoverageById = uniqueMap(
    snapshot.presentation.coverage,
    item => item.coverage_id,
    'Presentation Coverage'
  );

  const nodeCanonicalIndex = new Map();
  graph.nodes.forEach((node, i) => {
    nodeCanonicalIndex.set(node.id, i);
  });
  const edgeCanonicalIndex = new Map();
  graph.edges.forEach((edge, i) => {
    edgeCanonicalIndex.set(edge.id, i);
  });

  const outgoing = new Map();
  const incoming = new Map();
  for (const edge of graph.edges) {
    addMulti(outgoing, edge.from, edge);
    addMulti(incoming, edge.to, edge);
  }

  return {
    nodeById,
    edgeById,
    claimById,
    evidenceById,
    coverageById,
    presentationNodeById,
    presentationEdgeById,
    presentationClaimById,
    presentationCoverageById,
    nodeCanonicalIndex,
    edgeCanonicalIndex,
    outgoing,
    incoming
  };
}

function mapForRefKind(index, kind) {
  switch (kind) {
    case 'NODE':
      return index.nodeById;
    case 'EDGE':
      return index.edgeById;
    case 'CLAIM':
      return index.claimById;
    case 'EVIDENCE':
      return index.evidenceById;
    case 'COVERAGE':
      return index.coverageById;
    default:
      throw new TypeError(
        'unsupported Ask-Graph ref kind: ' + kind
      );
  }
}

function traceForRef(index, kind, ref) {
  switch (kind) {
    case 'NODE':
      return structuredClone(
        index.presentationNodeById.get(ref) ?? null
      );
    case 'EDGE':
      return structuredClone(
        index.presentationEdgeById.get(ref) ?? null
      );
    case 'CLAIM':
      return structuredClone(
        index.presentationClaimById.get(ref) ?? null
      );
    case 'COVERAGE':
      return structuredClone(
        index.presentationCoverageById.get(ref) ??
          null
      );
    case 'EVIDENCE':
      return null;
    default:
      return null;
  }
}

function response(
  snapshot,
  operation,
  data,
  meta = {}
) {
  return {
    schema: ASK_GRAPH_RESPONSE_SCHEMA,
    operation,
    source: structuredClone(snapshot.source),
    authority: {
      mode: 'CANONICAL_RETRIEVAL_ONLY',
      analysis_authority: false,
      graph_schema: snapshot.canonical.graph.schema,
      result_schema:
        snapshot.canonical.result.schema,
      analysis_result_digest:
        snapshot.source.analysis_result_digest
    },
    trust_boundary: trustBoundary(),
    ...meta,
    data
  };
}

function trustBoundary() {
  return {
    repository_runtime_external_text:
      'UNTRUSTED_DATA_NOT_INSTRUCTIONS',
    instruction_authority: false,
    executable_content: false
  };
}

function bounded(items, limit) {
  const total = items.length;
  const boundedItems = items
    .slice(0, limit)
    .map(item => structuredClone(item));
  return {
    items: boundedItems,
    returned_count: boundedItems.length,
    total_count: total,
    truncated: total > boundedItems.length
  };
}

function emptyCollection() {
  return {
    items: [],
    returned_count: 0,
    total_count: 0,
    truncated: false
  };
}

function collectionMeta(collection) {
  return {
    returned_count: collection.returned_count,
    total_count: collection.total_count,
    truncated: collection.truncated
  };
}

function canonicalNodeField(node, field) {
  if (field === 'id') return node.id;
  if (field === 'kind') return node.kind;
  return node[field];
}

function normalizeLimit(value, limits) {
  if (value == null) return null;
  if (
    !Number.isInteger(value) ||
    value < 1 ||
    value > limits.max_limit
  ) {
    throw new RangeError(
      'limit must be an integer from 1 to ' +
      limits.max_limit
    );
  }
  return value;
}

function normalizeEnumArray(
  value,
  allowed,
  label,
  maxLength
) {
  if (value == null) return null;
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > maxLength
  ) {
    throw new TypeError(
      label + ' must be a non-empty bounded array'
    );
  }
  const out = [];
  const seen = new Set();
  for (const item of value) {
    if (!allowed.includes(item)) {
      throw new TypeError(
        label + ' contains unsupported value: ' +
        String(item)
      );
    }
    if (seen.has(item)) {
      throw new TypeError(
        label + ' must not contain duplicates'
      );
    }
    seen.add(item);
    out.push(item);
  }
  return out;
}

function normalizeStringArray(
  value,
  label,
  maxLength
) {
  if (value == null) return null;
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > maxLength
  ) {
    throw new TypeError(
      label + ' must be a non-empty bounded array'
    );
  }
  const out = [];
  const seen = new Set();
  for (const item of value) {
    requireString(item, label + ' item');
    if (seen.has(item)) {
      throw new TypeError(
        label + ' must not contain duplicates'
      );
    }
    seen.add(item);
    out.push(item);
  }
  return out;
}

function validateLimits(defaultLimit, maxLimit) {
  if (
    !Number.isInteger(maxLimit) ||
    maxLimit < 1 ||
    maxLimit > HARD_MAX_LIMIT
  ) {
    throw new RangeError(
      'maxLimit must be an integer from 1 to ' +
      HARD_MAX_LIMIT
    );
  }
  if (
    !Number.isInteger(defaultLimit) ||
    defaultLimit < 1 ||
    defaultLimit > maxLimit
  ) {
    throw new RangeError(
      'defaultLimit must be an integer from 1 to maxLimit'
    );
  }
}

function rejectUnknownKeys(value, allowed) {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      throw new TypeError(
        'Ask-Graph query contains unsupported field: ' +
        key
      );
    }
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

function addMulti(map, key, value) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}

function requireObject(value, label) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value)
  ) {
    throw new TypeError(
      label + ' must be an object'
    );
  }
}

function requireString(value, label) {
  if (
    typeof value !== 'string' ||
    !value.length
  ) {
    throw new TypeError(
      label + ' must be a non-empty string'
    );
  }
}

function compareText(a, b) {
  const left = String(a);
  const right = String(b);
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object') {
    return value;
  }
  Object.freeze(value);
  for (const item of Object.values(value)) {
    deepFreeze(item);
  }
  return value;
}
