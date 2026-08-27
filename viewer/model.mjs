export function createViewerModel({
  graph,
  result = null,
  manifest = null,
  focused = Boolean(result)
}) {
  assertGraph(graph);
  if (result != null) assertAnalysisResult(result);

  const projection = projectGraph(graph, result, { focused });
  const overview = buildAnalysisOverview({
    graph,
    result,
    manifest,
    projection
  });
  const nodeCache = new Map();
  const claimNodeIds = new Set();
  const claimSearchByNode = new Map();

  for (const claim of result?.claims ?? []) {
    const nodeId = claim?.subject?.node_id;
    if (!nodeId) continue;
    const id = String(nodeId);
    claimNodeIds.add(id);
    const previous = claimSearchByNode.get(id) ?? '';
    claimSearchByNode.set(
      id,
      (
        previous + ' ' +
        String(claim.predicate ?? '') + ' ' +
        JSON.stringify(claim.object_or_value ?? null)
      ).trim()
    );
  }

  return {
    mode: result ? 'ANALYSIS_RESULT' : 'GRAPH_ONLY',
    focused: Boolean(result && focused),
    graph: projection,
    overview,
    evidence_index: buildEvidenceIndex(result, manifest),
    claim_node_ids: claimNodeIds,
    claim_search_by_node: claimSearchByNode,
    node(nodeId) {
      const id = String(nodeId);
      if (!nodeCache.has(id)) {
        nodeCache.set(
          id,
          buildNodePanel(graph, result, id)
        );
      }
      return nodeCache.get(id);
    }
  };
}

export function projectGraph(graph, result, {
  focused = Boolean(result)
} = {}) {
  assertGraph(graph);
  if (!result || !focused) {
    return {
      nodes: graph.nodes.map(item => structuredClone(item)),
      edges: graph.edges.map(item => structuredClone(item)),
      focused_node_ids: [],
      focused_edge_ids: []
    };
  }

  const nodeIds = new Set();
  const edgeIds = new Set();

  for (const symbol of result.affected_symbols ?? []) {
    if (symbol?.node_id) nodeIds.add(String(symbol.node_id));
  }
  for (const path of result.graph_paths ?? []) {
    if (path?.edge_id) edgeIds.add(String(path.edge_id));
    if (path?.from) nodeIds.add(String(path.from));
    if (path?.to) nodeIds.add(String(path.to));
  }
  for (const claim of result.claims ?? []) {
    if (claim?.subject?.node_id) {
      nodeIds.add(String(claim.subject.node_id));
    }
  }

  if (!nodeIds.size && !edgeIds.size) {
    return {
      nodes: graph.nodes.map(item => structuredClone(item)),
      edges: graph.edges.map(item => structuredClone(item)),
      focused_node_ids: [],
      focused_edge_ids: []
    };
  }

  const graphEdgeById = new Map(
    graph.edges.map(edge => [String(edge.id), edge])
  );
  for (const edgeId of edgeIds) {
    const edge = graphEdgeById.get(edgeId);
    if (!edge) continue;
    nodeIds.add(String(edge.from));
    nodeIds.add(String(edge.to));
  }

  const edges = graph.edges.filter(edge =>
    edgeIds.has(String(edge.id)) ||
    (nodeIds.has(String(edge.from)) && nodeIds.has(String(edge.to)))
  );

  if (edges.length === 0 && nodeIds.size <= 4) {
    const seedNodeIds = new Set(nodeIds);
    for (const edge of graph.edges) {
      if (
        seedNodeIds.has(String(edge.from)) ||
        seedNodeIds.has(String(edge.to))
      ) {
        edges.push(edge);
        nodeIds.add(String(edge.from));
        nodeIds.add(String(edge.to));
      }
    }
  }

  const nodes = graph.nodes.filter(node =>
    nodeIds.has(String(node.id))
  );

  return {
    nodes: nodes.map(item => structuredClone(item)),
    edges: edges.map(item => structuredClone(item)),
    focused_node_ids: [...nodeIds].sort(),
    focused_edge_ids: edges.map(edge => String(edge.id)).sort()
  };
}

export function buildAnalysisOverview({
  graph,
  result = null,
  manifest = null,
  projection = null
}) {
  assertGraph(graph);
  const visibleGraph = projection ?? {
    nodes: graph.nodes,
    edges: graph.edges
  };
  const runtimeEdges = visibleGraph.edges.filter(isRuntimeEdge);
  const boundaryEdges = visibleGraph.edges.filter(edge =>
    Boolean(edge.boundary)
  );

  const base = {
    graph_nodes: graph.nodes.length,
    graph_edges: graph.edges.length,
    visible_nodes: visibleGraph.nodes.length,
    visible_edges: visibleGraph.edges.length,
    runtime_edges: runtimeEdges.length,
    boundary_edges: boundaryEdges.length,
    workspace: structuredClone(graph.meta?.workspace ?? null),
    platform: structuredClone(graph.meta?.platform ?? null),
    fidelity: fidelitySummary(graph),
    molang: molangSummary(graph)
  };

  if (!result) {
    return {
      ...base,
      source_mode: 'GRAPH_ONLY',
      identity: null,
      run_status: null,
      claims: {
        total: 0,
        by_status: {}
      },
      coverage: null,
      coverage_gaps: [],
      unknowns: [],
      warnings: [],
      failures: []
    };
  }

  const claimStatuses = {};
  for (const claim of result.claims ?? []) {
    const status = String(claim.status ?? 'UNKNOWN');
    claimStatuses[status] = Number(claimStatuses[status] ?? 0) + 1;
  }

  const coverageStatuses = {};
  const gaps = [];
  for (const entry of result.coverage?.entries ?? []) {
    const status = String(entry.status ?? 'UNKNOWN');
    coverageStatuses[status] =
      Number(coverageStatuses[status] ?? 0) + 1;
    if (['FAILED','UNEXPLORED'].includes(status)) {
      gaps.push(structuredClone(entry));
    }
  }

  return {
    ...base,
    source_mode:
      manifest?.schema === 'core.human-viewer-manifest/v1'
        ? 'VIEWER_BUNDLE'
        : 'ANALYSIS_RESULT',
    identity: {
      analysis_id: result.analysis_id,
      session_id: result.session_id,
      repository_id: result.repository?.repository_id ?? null,
      repository_identity:
        result.repository?.canonical_identity ?? null,
      snapshot_id: result.snapshot?.snapshot_id ?? null,
      snapshot_kind: result.snapshot?.kind ?? null
    },
    run_status: result.status,
    claims: {
      total: result.claims?.length ?? 0,
      by_status: claimStatuses
    },
    coverage: {
      completeness: result.coverage?.completeness ?? null,
      fingerprint: result.coverage?.fingerprint ?? null,
      total: result.coverage?.entries?.length ?? 0,
      by_status: coverageStatuses
    },
    coverage_gaps: gaps.sort(compareById),
    unknowns: structuredClone(result.unknowns ?? []),
    warnings: structuredClone(result.warnings ?? []),
    failures: structuredClone(result.failures ?? []),
    recommended_validation: structuredClone(
      result.recommended_validation ?? []
    )
  };
}

export function buildNodePanel(graph, result, nodeId) {
  assertGraph(graph);
  const id = String(nodeId);
  const node = graph.nodes.find(item => String(item.id) === id);
  if (!node) return null;

  const byId = new Map(
    graph.nodes.map(item => [String(item.id), item])
  );
  const relations = graph.edges
    .filter(edge =>
      String(edge.from) === id ||
      String(edge.to) === id
    )
    .map(edge => relationRow(edge, id, byId))
    .sort(compareRelation);

  const callers = relations.filter(row =>
    row.direction === 'in' && isCallLike(row.type)
  );
  const callees = relations.filter(row =>
    row.direction === 'out' && isCallLike(row.type)
  );
  const runtime = relations.filter(row => row.runtime_observed);
  const semantic = relations.filter(row =>
    isSemanticEdge(row.type) || row.semantic_kind
  );

  const claims = (result?.claims ?? [])
    .filter(claim => claimMatchesNode(claim, node))
    .map(claim => ({
      id: claim.id,
      type: claim.type,
      status: claim.status,
      predicate: claim.predicate,
      object_or_value: structuredClone(claim.object_or_value),
      confidence: structuredClone(claim.confidence),
      support_evidence_ids: claim.evidence_links
        .filter(link => link.role === 'SUPPORT')
        .map(link => link.evidence_id)
        .sort(),
      counterevidence_ids: claim.counterevidence_links
        .filter(link => link.role === 'CONTRADICT')
        .map(link => link.evidence_id)
        .sort(),
      dependency_claim_ids: [
        ...(claim.dependency_claim_ids ?? [])
      ].sort(),
      unresolved_reason: claim.unresolved_reason ?? null
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const evidenceRefs = [...new Set(
    claims.flatMap(claim => [
      ...claim.support_evidence_ids,
      ...claim.counterevidence_ids
    ])
  )].sort();

  const coverage = (result?.coverage?.entries ?? [])
    .filter(entry => coverageMatchesNode(entry, node))
    .map(entry => structuredClone(entry))
    .sort(compareById);

  return {
    node: structuredClone(node),
    responsibility: nodeResponsibility(node),
    source_anchor: nodeSourceAnchor(node),
    callers,
    callees,
    domain_semantic_edges: semantic,
    runtime_overlay: runtime,
    relations,
    claims,
    evidence_refs: evidenceRefs,
    coverage
  };
}

export function buildEvidenceIndex(result, manifest = null) {
  const index = {};
  if (manifest?.evidence_index) {
    for (const [id, value] of Object.entries(manifest.evidence_index)) {
      index[id] = structuredClone(value);
    }
  }

  for (const record of result?.evidence ?? []) {
    if (index[record.id]) continue;
    index[record.id] = {
      id: record.id,
      kind: record.kind,
      trust_class: record.trust_class,
      provider_id: record.provider_id,
      provider_version: record.provider_version,
      provenance: compactProvenance(record.provenance),
      inline: true
    };
  }
  return index;
}

export function deterministicLayout(nodes, edges, {
  width = 1400,
  height = 900,
  iterations = 180
} = {}) {
  const placed = nodes.map(node => {
    const h = hashString(String(node.id));
    const angle = ((h % 3600) / 3600) * Math.PI * 2;
    const radial = 120 + ((h >>> 8) % 320);
    const skew = (((h >>> 16) % 1000) / 1000) - 0.5;
    return {
      id: String(node.id),
      x:
        width / 2 +
        Math.cos(angle) * radial +
        skew * width * 0.22,
      y:
        height / 2 +
        Math.sin(angle) * radial +
        skew * height * 0.14,
      vx: 0,
      vy: 0
    };
  });

  const byId = new Map(
    placed.map(item => [item.id, item])
  );
  const linked = edges
    .map(edge => ({
      a: byId.get(String(edge.from)),
      b: byId.get(String(edge.to))
    }))
    .filter(edge => edge.a && edge.b);

  for (let it = 0; it < iterations; it++) {
    for (const edge of linked) {
      let dx = edge.b.x - edge.a.x;
      let dy = edge.b.y - edge.a.y;
      const distance = Math.hypot(dx, dy) || 1;
      const force = (distance - 90) * 0.002;
      dx /= distance;
      dy /= distance;
      edge.a.vx += dx * force;
      edge.a.vy += dy * force;
      edge.b.vx -= dx * force;
      edge.b.vy -= dy * force;
    }

    for (let i = 0; i < placed.length; i++) {
      const a = placed[i];
      for (
        let j = i + 1;
        j < Math.min(placed.length, i + 80);
        j++
      ) {
        const b = placed[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d2 = dx * dx + dy * dy + 10;
        if (d2 < 9000) {
          const force = 18 / d2;
          a.vx -= dx * force;
          a.vy -= dy * force;
          b.vx += dx * force;
          b.vy += dy * force;
        }
      }
    }

    for (const node of placed) {
      node.vx += (width / 2 - node.x) * 0.00006;
      node.vy += (height / 2 - node.y) * 0.00006;
      node.vx *= 0.86;
      node.vy *= 0.86;
      node.x += node.vx;
      node.y += node.vy;
    }
  }

  return Object.fromEntries(
    placed.map(item => [
      item.id,
      {
        x: Number(item.x.toFixed(4)),
        y: Number(item.y.toFixed(4))
      }
    ])
  );
}

export function isRuntimeEdge(edge) {
  return Boolean(
    edge?.runtimeObservation ||
    edge?.runtime_observed ||
    String(edge?.type ?? '').startsWith('OBSERVED_')
  );
}

function relationRow(edge, nodeId, byId) {
  const outbound = String(edge.from) === nodeId;
  const otherId = String(outbound ? edge.to : edge.from);
  const other = byId.get(otherId);
  return {
    edge_id: edge.id,
    type: edge.type,
    direction: outbound ? 'out' : 'in',
    other_id: otherId,
    other_label: other?.label ?? other?.key ?? otherId,
    other_kind: other?.kind ?? null,
    boundary: Boolean(edge.boundary),
    runtime_observed: isRuntimeEdge(edge),
    confidence: edge.confidence ?? null,
    repository: edge.repository ?? null,
    semantic_kind: edge.semanticKind ?? edge.semantic_kind ?? null,
    stage: edge.stage ?? null,
    evidence: structuredClone(edge.evidence ?? null),
    fields: structuredClone(edge.fields ?? null),
    samples: structuredClone(edge.samples ?? null)
  };
}

function claimMatchesNode(claim, node) {
  const subject = claim?.subject;
  if (!subject || typeof subject !== 'object') return false;
  if (subject.node_id && String(subject.node_id) === String(node.id)) {
    return true;
  }
  if (
    subject.key != null &&
    node.key != null &&
    String(subject.key) === String(node.key)
  ) {
    return true;
  }
  return Boolean(
    subject.label != null &&
    node.label != null &&
    String(subject.label) === String(node.label)
  );
}

function coverageMatchesNode(entry, node) {
  if (entry?.node_id && String(entry.node_id) === String(node.id)) {
    return true;
  }
  const id = String(entry?.id ?? '');
  if (
    id === String(node.id) ||
    id === 'node:' + String(node.id)
  ) {
    return true;
  }
  const entryPath = normalizePath(entry?.path);
  const nodePath = normalizePath(node?.path);
  return Boolean(entryPath && nodePath && entryPath === nodePath);
}

function nodeResponsibility(node) {
  const candidates = [
    ['responsibility', node.responsibility],
    ['summary', node.summary],
    ['description', node.description],
    ['ua-summary', node.raw?.summary],
    ['semantic-description', node.semantic?.description]
  ];
  for (const [source, value] of candidates) {
    if (typeof value === 'string' && value.trim()) {
      return {
        source,
        text: value.trim()
      };
    }
  }
  return null;
}

function nodeSourceAnchor(node) {
  if (!node.path && !node.lineRange && !node.range) return null;
  return {
    path: normalizePath(node.path),
    range: structuredClone(node.lineRange ?? node.range ?? null)
  };
}

function compactProvenance(provenance = {}) {
  return {
    repository_id: provenance.repository_id ?? null,
    snapshot_id: provenance.snapshot_id ?? null,
    ...(provenance.path ? {
      path: normalizePath(provenance.path)
    } : {}),
    ...(provenance.range ? {
      range: structuredClone(provenance.range)
    } : {}),
    ...(provenance.symbol_id ? {
      symbol_id: provenance.symbol_id
    } : {}),
    ...(provenance.artifact_id ? {
      artifact_id: provenance.artifact_id
    } : {}),
    ...(provenance.runtime_run_id ? {
      runtime_run_id: provenance.runtime_run_id
    } : {})
  };
}

function fidelitySummary(graph) {
  const fidelity = graph.nodes.find(node =>
    node.kind === 'fidelity_matrix'
  );
  const network = graph.nodes.find(node =>
    node.kind === 'network_delivery_matrix'
  );
  return {
    ysm: fidelity
      ? {
          observed_through: fidelity.observedThroughStage ?? null,
          first_unobserved: fidelity.firstUnobservedStage ?? null,
          stages: structuredClone(fidelity.stageSummary ?? [])
        }
      : null,
    network: network
      ? {
          observed_through: network.observedThroughStage ?? null,
          first_unobserved: network.firstUnobservedStage ?? null,
          stages: structuredClone(network.stageSummary ?? [])
        }
      : null
  };
}

function molangSummary(graph) {
  const matrices = graph.nodes.filter(node =>
    node.kind === 'molang_transport_matrix'
  );
  return {
    total: matrices.length,
    m5_observed: matrices.filter(node =>
      (node.stageSummary ?? []).some(stage =>
        stage.id === 'M5' && stage.status === 'observed'
      )
    ).length,
    m6_observed: matrices.filter(node =>
      node.m6StateAppliedObserved ||
      (node.stageSummary ?? []).some(stage =>
        stage.id === 'M6' && stage.status === 'observed'
      )
    ).length,
    correlated: matrices.filter(node =>
      node.stateCorrelationObserved
    ).length,
    fallback: matrices.filter(node =>
      node.clientCommandFallbackObserved
    ).length,
    failures: matrices.filter(node =>
      node.commandFailureObserved
    ).length
  };
}

function isCallLike(type) {
  return /CALL|INVOKE|DISPATCH/.test(String(type ?? '').toUpperCase());
}

function isSemanticEdge(type) {
  const value = String(type ?? '').toUpperCase();
  return ![
    'CONTAINS',
    'DECLARES',
    'HAS_FILE',
    'IMPORTS',
    'UA_CONTAINS',
    'UA_LAYER_CONTAINS'
  ].includes(value);
}

function compareRelation(a, b) {
  return String(a.type).localeCompare(String(b.type)) ||
    String(a.direction).localeCompare(String(b.direction)) ||
    String(a.other_id).localeCompare(String(b.other_id));
}

function compareById(a, b) {
  return String(a?.id ?? '').localeCompare(String(b?.id ?? ''));
}

function normalizePath(value) {
  if (value == null) return null;
  return String(value)
    .replaceAll('\\', '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '');
}

function hashString(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function assertGraph(graph) {
  if (
    !graph ||
    !Array.isArray(graph.nodes) ||
    !Array.isArray(graph.edges)
  ) {
    throw new TypeError('viewer graph requires nodes/edges arrays');
  }
}

function assertAnalysisResult(result) {
  if (
    !result ||
    result.schema !== 'core.analysis-result/v1' ||
    !result.coverage
  ) {
    throw new TypeError('viewer requires core.analysis-result/v1');
  }
}
