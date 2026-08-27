import crypto from 'node:crypto';
import { validateAnalysisResultV1 } from '../schema/v1.mjs';

export const HUMAN_DIAGRAM_SCHEMA =
  'core.human-diagram-projection/v1';

export const HUMAN_DIAGRAM_TYPES = Object.freeze([
  'AUTO',
  'ARCHITECTURE',
  'CALL_FLOW',
  'DATA_FLOW',
  'NETWORK_FLOW',
  'RESOURCE_FLOW',
  'DIAGNOSIS'
]);

const TYPE_SET = new Set(HUMAN_DIAGRAM_TYPES);
const DETAIL_LEVELS = new Set(['overview','focused','deep']);

const EDGE_FAMILIES = Object.freeze({
  ARCHITECTURE: new Set([
    'DECLARES',
    'DECLARES_METHOD',
    'EXTENDS',
    'IMPLEMENTS',
    'MOD_ENTRYPOINT',
    'MIXES_INTO',
    'INJECTS_AT',
    'UA_CONTAINS',
    'UA_LAYER_CONTAINS'
  ]),
  CALL_FLOW: new Set([
    'CALLS',
    'DECLARES_METHOD',
    'HANDLED_BY',
    'DISPATCHES_NETWORK_HANDLER',
    'ENQUEUES_NETWORK_WORK',
    'SUBSCRIBES_EVENT',
    'INJECTS_AT'
  ]),
  DATA_FLOW: new Set([
    'READS',
    'WRITES',
    'READS_MOLANG',
    'WRITES_MOLANG',
    'BOUNDARY_PRODUCES_MOLANG',
    'BOUNDARY_CONSUMES_MOLANG',
    'OBSERVED_PACKET_PAYLOAD_MOLANG',
    'OBSERVED_YSM_MOLANG_COMMAND_DISPATCH',
    'OBSERVED_YSM_MOLANG_STATE_APPLIED',
    'OBSERVED_YSM_STATE_CORRELATED'
  ]),
  NETWORK_FLOW: new Set([
    'DECLARES_NETWORK_CHANNEL',
    'DECLARES_NETWORK_SEND',
    'REGISTERS_PACKET',
    'SENDS_PACKET',
    'ENCODED_BY',
    'DECODED_BY',
    'PACKET_DIRECTION',
    'HANDLED_BY',
    'DISPATCHES_NETWORK_HANDLER',
    'ENQUEUES_NETWORK_WORK',
    'OBSERVED_PACKET_SEND',
    'OBSERVED_PACKET_RECEIVE',
    'OBSERVED_ON_NETWORK_CHANNEL',
    'OBSERVED_PACKET_DIRECTION',
    'HAS_NETWORK_DELIVERY_STAGE',
    'HAS_RUNTIME_NETWORK_OBSERVATION',
    'HAS_RUNTIME_NETWORK_SEMANTIC',
    'TRACKS_MOLANG_TRANSPORT'
  ]),
  RESOURCE_FLOW: new Set([
    'REFERENCES_RESOURCE',
    'DECLARES_MODEL',
    'DECLARES_ANIMATION',
    'DECLARES_ANIMATION_CONTROLLER',
    'DECLARES_YSM_MODEL_PACK',
    'PROVIDES_ANIMATION_NAME',
    'PROVIDES_BONE_NAME',
    'ANIMATES_BONE',
    'HAS_BONE',
    'BONE_CHILD_OF'
  ])
});

export function buildHumanDiagramProjection(
  result,
  graph,
  {
    diagramType = 'AUTO',
    detailLevel = 'focused',
    focusRef = null
  } = {}
) {
  validateAnalysisResultV1(result);
  assertGraph(graph);

  const requestedType = normalizeDiagramType(diagramType);
  if (!DETAIL_LEVELS.has(detailLevel)) {
    throw new TypeError(
      'detailLevel must be overview, focused, or deep'
    );
  }
  const resolvedType = requestedType === 'AUTO'
    ? inferDiagramType(result)
    : requestedType;

  const nodeById = new Map(
    graph.nodes.map(node => [node.id, node])
  );
  const edgeById = new Map(
    graph.edges.map(edge => [edge.id, edge])
  );
  const affectedIds = new Set(
    (result.affected_symbols ?? [])
      .map(item => item.node_id)
      .filter(Boolean)
  );

  for (const path of result.graph_paths ?? []) {
    if (path.from) affectedIds.add(path.from);
    if (path.to) affectedIds.add(path.to);
  }

  const focusNodeId = resolveFocusRef(
    focusRef,
    result,
    nodeById
  );
  if (focusNodeId) affectedIds.add(focusNodeId);

  const canonicalEdgeIds = new Set(
    (result.graph_paths ?? [])
      .map(item => item.edge_id)
      .filter(Boolean)
  );
  for (const claim of result.claims ?? []) {
    for (const ref of claim.provenance_refs ?? []) {
      if (String(ref).startsWith('graph-edge:')) {
        canonicalEdgeIds.add(
          String(ref).slice('graph-edge:'.length)
        );
      }
    }
  }

  let candidateEdges = [...canonicalEdgeIds]
    .map(id => edgeById.get(id))
    .filter(Boolean);

  if (detailLevel === 'deep') {
    for (const edge of graph.edges) {
      if (
        affectedIds.has(edge.from) &&
        affectedIds.has(edge.to)
      ) {
        candidateEdges.push(edge);
      }
    }
  }

  candidateEdges = dedupeById(candidateEdges);
  let selectedEdges = candidateEdges.filter(edge =>
    edgeMatchesDiagram(resolvedType, edge)
  );
  if (!selectedEdges.length && candidateEdges.length) {
    selectedEdges = candidateEdges;
  }

  if (detailLevel === 'overview') {
    selectedEdges = selectedEdges.filter(edge =>
      overviewEdge(edge, resolvedType)
    );
  }

  if (focusNodeId && detailLevel !== 'deep') {
    const adjacentIds = new Set([focusNodeId]);
    for (const edge of selectedEdges) {
      if (edge.from === focusNodeId) adjacentIds.add(edge.to);
      if (edge.to === focusNodeId) adjacentIds.add(edge.from);
    }
    selectedEdges = selectedEdges.filter(edge =>
      adjacentIds.has(edge.from) &&
      adjacentIds.has(edge.to)
    );
    for (const id of adjacentIds) affectedIds.add(id);
  }

  const includedIds = new Set();
  for (const edge of selectedEdges) {
    includedIds.add(edge.from);
    includedIds.add(edge.to);
  }
  for (const id of affectedIds) {
    if (nodeById.has(id)) includedIds.add(id);
  }

  const coverageByNode = coverageByNodeId(result.coverage);
  const claimsByNode = claimsBySubjectNode(result.claims ?? []);

  const orderedIds = deterministicNodeOrder(
    [...includedIds],
    selectedEdges,
    nodeById,
    focusNodeId
  );

  const ranks = rankNodes(
    orderedIds,
    selectedEdges,
    focusNodeId
  );

  const nodes = orderedIds.map((id, order) => {
    const node = nodeById.get(id);
    const claims = claimsByNode.get(id) ?? [];
    const coverage = coverageByNode.get(id) ?? null;
    return {
      ref: 'graph-node:' + id,
      graph_node_id: id,
      kind: node.kind,
      label: node.label ?? node.key ?? id,
      key: node.key ?? null,
      path: node.path ?? null,
      repository: node.repository ?? null,
      responsibility: responsibilityFor(node),
      group: groupingFor(node),
      status: nodeStatus({ coverage, claims }),
      coverage_status: coverage?.status ?? null,
      claim_ids: claims.map(claim => claim.id).sort(),
      evidence_refs: canonicalStrings(
        claims.flatMap(claim =>
          claim.evidence_links.map(link => link.evidence_id)
        )
      ),
      counterevidence_refs: canonicalStrings(
        claims.flatMap(claim =>
          claim.counterevidence_links.map(link => link.evidence_id)
        )
      ),
      runtime_observed:
        node.runtimeObserved === true ||
        node.runtimeObservation === true,
      layout: {
        rank: ranks.get(id) ?? 0,
        order
      }
    };
  });

  const claimByEdge = claimsByGraphEdge(result.claims ?? []);
  const edges = selectedEdges
    .map(edge => {
      const claims = claimByEdge.get(edge.id) ?? [];
      return {
        ref: 'graph-edge:' + edge.id,
        graph_edge_id: edge.id,
        from: edge.from,
        to: edge.to,
        type: edge.type,
        confidence: edge.confidence ?? 1,
        status: edgeStatus(edge, claims),
        claim_ids: claims.map(claim => claim.id).sort(),
        evidence_refs: canonicalStrings(
          claims.flatMap(claim =>
            claim.evidence_links.map(link => link.evidence_id)
          )
        ),
        counterevidence_refs: canonicalStrings(
          claims.flatMap(claim =>
            claim.counterevidence_links.map(link => link.evidence_id)
          )
        ),
        runtime_observation:
          edge.runtimeObservation === true,
        boundary: edge.boundary === true,
        semantic_authority: 'GRAPH',
        inferred: false
      };
    })
    .sort(compareProjectionEdges);

  const claimAnnotations = (result.claims ?? [])
    .filter(claim => {
      const nodeId = claim.subject?.node_id;
      return nodeId && includedIds.has(nodeId);
    })
    .map(claim => ({
      claim_id: claim.id,
      subject_node_id: claim.subject.node_id,
      type: claim.type,
      status: claim.status,
      predicate: claim.predicate,
      object_or_value: structuredClone(claim.object_or_value),
      evidence_refs: claim.evidence_links
        .map(link => link.evidence_id)
        .sort(),
      counterevidence_refs: claim.counterevidence_links
        .map(link => link.evidence_id)
        .sort()
    }))
    .sort((a, b) =>
      a.subject_node_id.localeCompare(b.subject_node_id) ||
      a.claim_id.localeCompare(b.claim_id)
    );

  const projection = {
    schema: HUMAN_DIAGRAM_SCHEMA,
    analysis_id: result.analysis_id,
    session_id: result.session_id,
    snapshot_id: result.snapshot.snapshot_id,
    diagram_type: resolvedType,
    requested_diagram_type: requestedType,
    detail_level: detailLevel,
    focus_ref: focusRef ?? null,
    focus_node_id: focusNodeId,
    coverage: {
      completeness: result.coverage.completeness,
      fingerprint: result.coverage.fingerprint ?? null
    },
    nodes,
    edges,
    claims: claimAnnotations,
    unknowns: structuredClone(result.unknowns ?? []),
    failures: structuredClone(result.failures ?? []),
    recommended_validation: structuredClone(
      result.recommended_validation ?? []
    )
  };
  projection.fingerprint = digestObject({
    analysis_id: projection.analysis_id,
    snapshot_id: projection.snapshot_id,
    diagram_type: projection.diagram_type,
    detail_level: projection.detail_level,
    focus_node_id: projection.focus_node_id,
    nodes: nodes.map(node => [
      node.graph_node_id,
      node.status,
      node.layout
    ]),
    edges: edges.map(edge => [
      edge.graph_edge_id,
      edge.type,
      edge.status
    ]),
    claims: claimAnnotations.map(claim => [
      claim.claim_id,
      claim.status
    ]),
    coverage: projection.coverage
  });
  return projection;
}

export function inferDiagramType(result) {
  validateAnalysisResultV1(result);
  const question = String(
    result.question ??
    result.normalized_question ??
    ''
  ).toLowerCase();
  const edgeTypes = new Set(
    (result.graph_paths ?? [])
      .map(item => String(item.edge_type ?? '').toUpperCase())
  );

  if (
    hasAny(question, [
      'network','packet','forge channel','ネットワーク','パケット','通信'
    ]) ||
    intersects(edgeTypes, EDGE_FAMILIES.NETWORK_FLOW)
  ) {
    return 'NETWORK_FLOW';
  }
  if (
    hasAny(question, [
      'molang','variable','data flow','値','変数','データ'
    ]) ||
    intersects(edgeTypes, EDGE_FAMILIES.DATA_FLOW)
  ) {
    return 'DATA_FLOW';
  }
  if (
    hasAny(question, [
      'resource','animation','bone','model','リソース','アニメ','ボーン','モデル'
    ]) ||
    intersects(edgeTypes, EDGE_FAMILIES.RESOURCE_FLOW)
  ) {
    return 'RESOURCE_FLOW';
  }
  if (
    result.status === 'PARTIAL' ||
    hasAny(question, [
      'diagnose','cause','failure','why','原因','診断','失敗','なぜ'
    ]) ||
    (result.failures ?? []).length > 0
  ) {
    return 'DIAGNOSIS';
  }
  if (
    result.claims?.some(claim =>
      String(claim.predicate).includes('call')
    ) ||
    intersects(edgeTypes, EDGE_FAMILIES.CALL_FLOW)
  ) {
    return 'CALL_FLOW';
  }
  return 'ARCHITECTURE';
}

function assertGraph(graph) {
  if (
    !graph ||
    graph.schema !== 'kneekura.graph/v1' ||
    !Array.isArray(graph.nodes) ||
    !Array.isArray(graph.edges)
  ) {
    throw new TypeError('kneekura.graph/v1 is required');
  }
}

function normalizeDiagramType(value) {
  const type = String(value ?? 'AUTO')
    .trim()
    .toUpperCase()
    .replaceAll('-', '_');
  if (!TYPE_SET.has(type)) {
    throw new TypeError(
      'unsupported human diagram type: ' + type
    );
  }
  return type;
}

function resolveFocusRef(focusRef, result, nodeById) {
  if (!focusRef) return null;
  const value = String(focusRef);
  if (nodeById.has(value)) return value;
  if (value.startsWith('graph-node:')) {
    const id = value.slice('graph-node:'.length);
    if (!nodeById.has(id)) {
      throw new Error('focus GraphNode not found: ' + id);
    }
    return id;
  }

  const claim = (result.claims ?? [])
    .find(item => item.id === value);
  if (claim?.subject?.node_id) return claim.subject.node_id;

  const affected = (result.affected_symbols ?? [])
    .filter(item =>
      item.key === value ||
      item.label === value
    );
  if (affected.length > 1) {
    throw new Error('human diagram focus is ambiguous: ' + value);
  }
  if (affected.length === 1) return affected[0].node_id;
  throw new Error('human diagram focus not found: ' + value);
}

function edgeMatchesDiagram(type, edge) {
  if (type === 'DIAGNOSIS') return true;
  const family = EDGE_FAMILIES[type];
  if (!family) return true;
  const edgeType = String(edge.type ?? '').toUpperCase();
  if (family.has(edgeType)) return true;
  if (type === 'ARCHITECTURE' && edgeType.startsWith('UA_')) {
    return [
      'UA_CONTAINS',
      'UA_LAYER_CONTAINS'
    ].includes(edgeType);
  }
  if (
    type === 'NETWORK_FLOW' &&
    (
      edgeType.includes('NETWORK') ||
      edgeType.includes('PACKET')
    )
  ) {
    return true;
  }
  if (
    type === 'DATA_FLOW' &&
    (
      edgeType.includes('MOLANG') ||
      edgeType === 'READS' ||
      edgeType === 'WRITES'
    )
  ) {
    return true;
  }
  return false;
}

function overviewEdge(edge, diagramType) {
  const type = String(edge.type ?? '').toUpperCase();
  if (edge.runtimeObservation === true) return true;
  if (edge.boundary === true) return true;
  if (diagramType === 'ARCHITECTURE') {
    return [
      'EXTENDS','IMPLEMENTS','MOD_ENTRYPOINT',
      'UA_CONTAINS','UA_LAYER_CONTAINS'
    ].includes(type);
  }
  return Number(edge.confidence ?? 1) >= 0.9;
}

function coverageByNodeId(coverage) {
  const map = new Map();
  for (const entry of coverage.entries ?? []) {
    if (!String(entry.id).startsWith('node:')) continue;
    map.set(String(entry.id).slice('node:'.length), entry);
  }
  return map;
}

function claimsBySubjectNode(claims) {
  const map = new Map();
  for (const claim of claims) {
    const nodeId = claim.subject?.node_id;
    if (!nodeId) continue;
    if (!map.has(nodeId)) map.set(nodeId, []);
    map.get(nodeId).push(claim);
  }
  for (const rows of map.values()) {
    rows.sort((a, b) => a.id.localeCompare(b.id));
  }
  return map;
}

function claimsByGraphEdge(claims) {
  const map = new Map();
  for (const claim of claims) {
    for (const ref of claim.provenance_refs ?? []) {
      const value = String(ref);
      if (!value.startsWith('graph-edge:')) continue;
      const edgeId = value.slice('graph-edge:'.length);
      if (!map.has(edgeId)) map.set(edgeId, []);
      map.get(edgeId).push(claim);
    }
  }
  for (const rows of map.values()) {
    rows.sort((a, b) => a.id.localeCompare(b.id));
  }
  return map;
}

function nodeStatus({ coverage, claims }) {
  if (coverage?.status === 'FAILED') return 'FAILED';
  if (coverage?.status === 'UNEXPLORED') return 'UNEXPLORED';
  if (claims.some(claim => claim.status === 'REJECTED')) {
    return 'CONTRADICTED';
  }
  if (claims.some(claim => claim.status === 'VERIFIED')) {
    return 'VERIFIED';
  }
  if (claims.some(claim =>
    claim.status === 'VERIFIED_WITH_LIMITS'
  )) {
    return 'VERIFIED_WITH_LIMITS';
  }
  if (claims.some(claim => claim.status === 'UNRESOLVED')) {
    return 'UNKNOWN';
  }
  if (coverage?.status === 'REUSED') return 'REUSED';
  if (coverage?.status === 'ANALYZED') return 'ANALYZED';
  return 'CONTEXT';
}

function edgeStatus(edge, claims) {
  if (claims.some(claim => claim.status === 'REJECTED')) {
    return 'CONTRADICTED';
  }
  if (claims.some(claim => claim.status === 'VERIFIED')) {
    return 'VERIFIED';
  }
  if (claims.some(claim =>
    claim.status === 'VERIFIED_WITH_LIMITS'
  )) {
    return 'VERIFIED_WITH_LIMITS';
  }
  if (claims.some(claim => claim.status === 'UNRESOLVED')) {
    return 'UNKNOWN';
  }
  if (edge.runtimeObservation === true) return 'OBSERVED';
  return 'CONTEXT';
}

function responsibilityFor(node) {
  return (
    node.summary ??
    node.responsibility ??
    node.description ??
    node.languageLesson ??
    null
  );
}

function groupingFor(node) {
  if (node.kind === 'ua:layer') {
    return node.label ?? node.key ?? 'Understand Anything';
  }
  return (
    node.layer ??
    node.repository ??
    node.module ??
    node.package ??
    null
  );
}

function deterministicNodeOrder(
  nodeIds,
  edges,
  nodeById,
  focusNodeId
) {
  const degree = new Map(nodeIds.map(id => [id, 0]));
  for (const edge of edges) {
    degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
    degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
  }
  return nodeIds
    .filter(id => nodeById.has(id))
    .sort((a, b) => {
      if (a === focusNodeId) return -1;
      if (b === focusNodeId) return 1;
      const da = degree.get(a) ?? 0;
      const db = degree.get(b) ?? 0;
      if (da !== db) return db - da;
      const na = nodeById.get(a);
      const nb = nodeById.get(b);
      return String(na.kind).localeCompare(String(nb.kind)) ||
        String(na.label ?? na.key ?? a)
          .localeCompare(String(nb.label ?? nb.key ?? b)) ||
        a.localeCompare(b);
    });
}

function rankNodes(nodeIds, edges, focusNodeId) {
  const ranks = new Map();
  if (!nodeIds.length) return ranks;
  const incoming = new Map(nodeIds.map(id => [id, 0]));
  const outgoing = new Map(nodeIds.map(id => [id, []]));
  for (const edge of edges) {
    if (!incoming.has(edge.from) || !incoming.has(edge.to)) continue;
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
    outgoing.get(edge.from).push(edge.to);
  }

  const roots = focusNodeId
    ? [focusNodeId]
    : nodeIds.filter(id => (incoming.get(id) ?? 0) === 0);
  const queue = (roots.length ? roots : [nodeIds[0]])
    .filter(id => incoming.has(id))
    .sort()
    .map(id => [id, 0]);
  const seen = new Set();

  while (queue.length) {
    const [id, rank] = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    ranks.set(id, rank);
    for (const next of (outgoing.get(id) ?? []).slice().sort()) {
      if (!seen.has(next)) queue.push([next, rank + 1]);
    }
  }

  let fallbackRank = ranks.size
    ? Math.max(...ranks.values()) + 1
    : 0;
  for (const id of nodeIds) {
    if (!ranks.has(id)) ranks.set(id, fallbackRank++);
  }
  return ranks;
}

function compareProjectionEdges(a, b) {
  return a.from.localeCompare(b.from) ||
    a.to.localeCompare(b.to) ||
    a.type.localeCompare(b.type) ||
    a.graph_edge_id.localeCompare(b.graph_edge_id);
}

function dedupeById(values) {
  const map = new Map();
  for (const value of values) {
    if (!map.has(value.id)) map.set(value.id, value);
  }
  return [...map.values()];
}

function canonicalStrings(values) {
  return [...new Set(values.map(String))].sort();
}

function hasAny(text, fragments) {
  return fragments.some(fragment =>
    text.includes(String(fragment).toLowerCase())
  );
}

function intersects(set, other) {
  for (const value of set) {
    if (other.has(value)) return true;
  }
  return false;
}

function digestObject(value) {
  return 'sha256:' + crypto.createHash('sha256')
    .update(stableStringify(value))
    .digest('hex');
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key =>
      JSON.stringify(key) + ':' + stableStringify(value[key])
    ).join(',') + '}';
  }
  return JSON.stringify(value);
}
