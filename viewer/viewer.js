const G = await fetchJson('/graph.json');

const el = {
  svg: document.querySelector('#graph'),
  q: document.querySelector('#q'),
  kind: document.querySelector('#kind'),
  edgeType: document.querySelector('#edgeType'),
  boundaryOnly: document.querySelector('#boundaryOnly'),
  runtimeOnly: document.querySelector('#runtimeOnly'),
  detail: document.querySelector('#detail'),
  summary: document.querySelector('#summary'),
  coverage: document.querySelector('#coverage'),
  claims: document.querySelector('#claims'),
  refLinks: document.querySelector('#refLinks'),
  viewMode: document.querySelector('#viewMode'),
  diagramType: document.querySelector('#diagramType'),
  detailLevel: document.querySelector('#detailLevel'),
  modeBadge: document.querySelector('#modeBadge'),
  compatControls: document.querySelector('#compatControls'),
  diagramTitle: document.querySelector('#diagramTitle')
};

let manifest = null;
let A = null;
let diagram = null;
let currentFocus = null;
let graphRender = null;

try {
  manifest = await fetchJson('/analysis.json');
  if (
    manifest?.schema === 'core.viewer-analysis-manifest/v1' &&
    manifest.analysis_result?.schema === 'core.analysis-result/v1'
  ) {
    A = manifest.analysis_result;
  }
} catch {
  manifest = null;
  A = null;
}

setupFilterOptions();
renderSummary();
renderCoverage();
renderClaims();
configureMode();

if (A) await loadFocusedDiagram();
else renderFullGraph();

function configureMode() {
  if (A) {
    el.modeBadge.textContent = 'AnalysisResult';
    el.viewMode.value = 'focused';
    el.compatControls.classList.add('hidden');
  } else {
    el.modeBadge.textContent = 'graph compatibility';
    el.viewMode.value = 'graph';
    el.viewMode.querySelector('option[value="focused"]').disabled = true;
    el.diagramType.disabled = true;
    el.detailLevel.disabled = true;
    el.compatControls.classList.remove('hidden');
  }
}

function setupFilterOptions() {
  for (const k of [...new Set(G.nodes.map(n => n.kind))].sort()) {
    el.kind.add(new Option(k, k));
  }
  for (const t of [...new Set(G.edges.map(e => e.type))].sort()) {
    el.edgeType.add(new Option(t, t));
  }
}

function renderSummary() {
  clear(el.summary);
  const rows = [];

  if (A) {
    rows.push(['run', A.status]);
    rows.push(['coverage', A.coverage.completeness]);
    rows.push(['analysis', A.analysis_id]);
    rows.push(['session', A.session_id]);
    rows.push(['snapshot', A.snapshot.snapshot_id]);
  }

  rows.push(['graph', G.nodes.length + ' nodes / ' + G.edges.length + ' edges']);
  const workspace = G.meta?.workspace;
  if (workspace) {
    rows.push([
      'workspace',
      String(workspace.boundaryEdgeCount ?? 0) +
      ' boundary / ' +
      (workspace.repositories ?? []).join(' + ')
    ]);
  }
  const runtimeEdgeCount = G.edges.filter(e => e.runtimeObservation).length;
  if (runtimeEdgeCount) rows.push(['runtime edges', runtimeEdgeCount]);

  const kv = document.createElement('div');
  kv.className = 'kv';
  for (const [key, value] of rows) {
    appendKv(kv, key, value);
  }
  el.summary.append(kv);

  const counts = document.createElement('div');
  counts.className = 'fidelity';
  for (const [kind, count] of Object.entries(G.meta?.counts ?? {})) {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = kind + ': ' + count;
    counts.append(badge);
  }
  el.summary.append(counts);

  renderPlatformSummary(el.summary);
  renderRuntimeSummary(el.summary);
}

function renderPlatformSummary(parent) {
  const platform = G.meta?.platform;
  if (!platform) return;
  const block = document.createElement('div');
  block.className = 'fidelity';
  appendTextLine(block, 'Platform', true);
  appendTextLine(
    block,
    [
      platform.detected?.loader ?? '?',
      platform.detected?.minecraftVersion ?? '?',
      platform.detected?.forgeFamily ?? '?',
      platform.compatibility ?? ''
    ].filter(Boolean).join(' / ')
  );
  parent.append(block);
}

function renderRuntimeSummary(parent) {
  const network = G.nodes.find(n => n.kind === 'network_delivery_matrix');
  const molang = G.nodes.filter(n => n.kind === 'molang_transport_matrix');
  const fidelity = G.nodes.find(n => n.kind === 'fidelity_matrix');

  if (network) {
    const block = document.createElement('div');
    block.className = 'fidelity';
    appendTextLine(block, 'Forge network runtime', true);
    appendTextLine(
      block,
      'observed through ' +
      (network.observedThroughStage ?? 'none') +
      (network.firstUnobservedStage
        ? ' / next ' + network.firstUnobservedStage
        : '')
    );
    appendStageBadges(block, network.stageSummary ?? []);
    parent.append(block);
  }

  if (molang.length) {
    const m5 = molang.filter(m =>
      (m.stageSummary ?? []).some(s => s.id === 'M5' && s.status === 'observed')
    ).length;
    const m6 = molang.filter(m =>
      m.m6StateAppliedObserved ||
      (m.stageSummary ?? []).some(s => s.id === 'M6' && s.status === 'observed')
    ).length;
    const correlated = molang.filter(m => m.stateCorrelationObserved).length;
    const fallback = molang.filter(m => m.clientCommandFallbackObserved).length;
    const failures = molang.filter(m => m.commandFailureObserved).length;
    const block = document.createElement('div');
    block.className = 'fidelity';
    appendTextLine(block, 'Molang transport', true);
    appendTextLine(
      block,
      m5 + '/' + molang.length + ' through M5 / ' +
      m6 + ' through M6 / ' +
      correlated + ' weak correlations'
    );
    appendTextLine(block, fallback + ' fallback / ' + failures + ' command failures');
    parent.append(block);
  }

  if (fidelity) {
    const block = document.createElement('div');
    block.className = 'fidelity';
    appendTextLine(block, 'YSM fidelity', true);
    appendTextLine(
      block,
      'observed through ' +
      (fidelity.observedThroughStage ?? 'none') +
      (fidelity.firstUnobservedStage
        ? ' / next ' + fidelity.firstUnobservedStage
        : '')
    );
    appendStageBadges(block, fidelity.stageSummary ?? []);
    parent.append(block);
  }
}

function renderCoverage() {
  clear(el.coverage);
  if (!A) {
    el.coverage.textContent = 'AnalysisResultを指定するとCoverage/Unknownを表示します。';
    return;
  }

  const entries = A.coverage.entries ?? [];
  const counts = {};
  for (const entry of entries) {
    counts[entry.status] = (counts[entry.status] ?? 0) + 1;
  }

  const status = document.createElement('span');
  status.className = 'status ' + A.coverage.completeness;
  status.textContent = A.coverage.completeness;
  el.coverage.append(status);

  const meter = document.createElement('div');
  meter.className = 'coverage-meter';
  const filled = entries.filter(entry =>
    ['ANALYZED','REUSED','SKIPPED'].includes(entry.status)
  ).length;
  const fill = document.createElement('span');
  fill.style.width = entries.length
    ? Math.round((filled / entries.length) * 100) + '%'
    : '0%';
  meter.append(fill);
  el.coverage.append(meter);

  const countText = document.createElement('div');
  countText.className = 'kv';
  appendKv(countText, 'accounted', filled + '/' + entries.length);
  for (const [key, value] of Object.entries(counts).sort()) {
    appendKv(countText, key, value);
  }
  el.coverage.append(countText);

  for (const unknown of A.unknowns ?? []) {
    const row = document.createElement('button');
    row.className = 'unknown-row';
    row.type = 'button';
    row.textContent =
      'UNKNOWN ' +
      String(unknown.ref ?? unknown.kind ?? '') +
      ' — ' +
      String(unknown.reason ?? unknown.reason_code ?? 'unresolved');
    row.onclick = () => {
      const ref = String(unknown.ref ?? '');
      if (ref.startsWith('claim:') || ref.startsWith('evidence:')) {
        showRef(ref);
      } else {
        showDetail(unknown);
      }
    };
    el.coverage.append(row);
  }

  for (const failure of A.failures ?? []) {
    const row = document.createElement('div');
    row.className = 'unknown-row';
    row.textContent =
      'FAILED ' +
      String(failure.code ?? '') +
      ' — ' +
      String(failure.message ?? '');
    el.coverage.append(row);
  }
}

function renderClaims() {
  clear(el.claims);
  if (!A) {
    el.claims.textContent = 'AnalysisResultを指定するとClaimを表示します。';
    return;
  }
  if (!(A.claims ?? []).length) {
    el.claims.textContent = 'Claimなし';
    return;
  }

  for (const claim of A.claims) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'claim-row';
    row.dataset.claimId = claim.id;

    const first = document.createElement('div');
    first.className = 'claim-status';
    first.textContent = '[' + claim.status + '] ' + claim.type;
    const second = document.createElement('div');
    second.textContent =
      claim.predicate + ' = ' + JSON.stringify(claim.object_or_value);
    row.append(first, second);
    row.onclick = () => showRef(claim.id);
    el.claims.append(row);
  }
}

async function loadFocusedDiagram() {
  if (!A) return;
  const query = new URLSearchParams({
    type: el.diagramType.value,
    detail: el.detailLevel.value
  });
  if (currentFocus) query.set('focus', currentFocus);

  diagram = await fetchJson('/api/diagram?' + query.toString());
  el.diagramTitle.textContent =
    diagram.diagram_type +
    ' / ' + diagram.detail_level +
    ' / ' + diagram.nodes.length + ' nodes / ' +
    diagram.edges.length + ' edges';
  renderFocusedDiagram(diagram);
  applySearchFilter();
}

function renderFocusedDiagram(D) {
  clearSvg();
  const positions = layoutProjection(D);
  const W = Math.max(1000, positions.width);
  const H = Math.max(700, positions.height);
  el.svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
  appendArrowMarker();

  const nodeById = new Map(D.nodes.map(node => [node.graph_node_id, node]));

  for (const edge of D.edges) {
    const a = positions.byId.get(edge.from);
    const b = positions.byId.get(edge.to);
    if (!a || !b) continue;
    const line = svgElement('line');
    line.classList.add('edge', 'status-' + edge.status);
    if (edge.boundary) line.classList.add('boundary');
    if (edge.runtime_observation) line.classList.add('runtime-observation');
    line.setAttribute('x1', a.x);
    line.setAttribute('y1', a.y);
    line.setAttribute('x2', b.x);
    line.setAttribute('y2', b.y);
    line.setAttribute('marker-end', 'url(#arrow)');
    line.dataset.id = edge.graph_edge_id;
    line.dataset.from = edge.from;
    line.dataset.to = edge.to;
    line.dataset.type = edge.type;
    line.onclick = () => showRef(edge.ref);
    el.svg.append(line);
  }

  graphRender = { groups: [], lines: [...el.svg.querySelectorAll('.edge')], nodeById };

  for (const node of D.nodes) {
    const p = positions.byId.get(node.graph_node_id);
    if (!p) continue;
    const group = svgElement('g');
    group.classList.add('node', 'status-' + node.status);
    if (node.runtime_observed) group.classList.add('runtime-observed');
    group.setAttribute('transform', 'translate(' + p.x + ' ' + p.y + ')');
    group.dataset.id = node.graph_node_id;
    group.dataset.search = [
      node.label,
      node.key,
      node.path,
      node.kind,
      node.responsibility,
      node.status
    ].filter(Boolean).join(' ').toLowerCase();

    const rect = svgElement('rect');
    rect.setAttribute('x', '-82');
    rect.setAttribute('y', '-23');
    rect.setAttribute('width', '164');
    rect.setAttribute('height', '46');
    rect.setAttribute('rx', '9');
    rect.setAttribute('fill', color(node.kind));

    const title = svgElement('text');
    title.setAttribute('text-anchor', 'middle');
    title.setAttribute('y', '-2');
    title.textContent = shorten(node.label, 27);

    const sub = svgElement('text');
    sub.classList.add('subtext');
    sub.setAttribute('text-anchor', 'middle');
    sub.setAttribute('y', '13');
    sub.textContent = shorten(node.kind + ' · ' + node.status, 34);

    group.append(rect, title, sub);
    group.onclick = () => selectFocusedNode(node, group);
    group.ondblclick = async event => {
      event.preventDefault();
      currentFocus = node.graph_node_id;
      await loadFocusedDiagram();
    };
    el.svg.append(group);
    graphRender.groups.push(group);
  }
}

function selectFocusedNode(node, group) {
  markSelected(group);
  showDetail({
    graph_node_id: node.graph_node_id,
    kind: node.kind,
    label: node.label,
    key: node.key,
    path: node.path,
    responsibility: node.responsibility,
    status: node.status,
    coverage_status: node.coverage_status,
    runtime_observed: node.runtime_observed,
    group: node.group,
    claim_ids: node.claim_ids,
    evidence_refs: node.evidence_refs,
    counterevidence_refs: node.counterevidence_refs
  });

  const refs = [
    ['GraphNode', 'graph-node:' + node.graph_node_id],
    ...node.claim_ids.map(ref => ['Claim', ref]),
    ...node.evidence_refs.map(ref => ['Evidence', ref]),
    ...node.counterevidence_refs.map(ref => ['Counter', ref])
  ];
  renderRefButtons(refs);
}

function renderFullGraph() {
  clearSvg();
  el.diagramTitle.textContent =
    'full graph compatibility / ' +
    G.nodes.length + ' nodes / ' + G.edges.length + ' edges';

  const W = 1400;
  const H = 900;
  const nodes = G.nodes.map((node, index) => {
    const angle = index * 2.399963229728653;
    const radius = 80 + Math.sqrt(index + 1) * 24;
    return {
      ...node,
      x: W / 2 + Math.cos(angle) * radius,
      y: H / 2 + Math.sin(angle) * radius,
      vx: 0,
      vy: 0
    };
  });
  const byId = new Map(nodes.map(node => [node.id, node]));
  const edges = G.edges
    .map(edge => ({
      ...edge,
      a: byId.get(edge.from),
      b: byId.get(edge.to)
    }))
    .filter(edge => edge.a && edge.b);

  for (let iteration = 0; iteration < 160; iteration++) {
    for (const edge of edges) {
      let dx = edge.b.x - edge.a.x;
      let dy = edge.b.y - edge.a.y;
      let distance = Math.hypot(dx, dy) || 1;
      const force = (distance - 90) * .002;
      dx /= distance;
      dy /= distance;
      edge.a.vx += dx * force;
      edge.a.vy += dy * force;
      edge.b.vx -= dx * force;
      edge.b.vy -= dy * force;
    }
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < Math.min(nodes.length, i + 80); j++) {
        const b = nodes[j];
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
    for (const node of nodes) {
      node.vx += (W / 2 - node.x) * .00006;
      node.vy += (H / 2 - node.y) * .00006;
      node.vx *= .86;
      node.vy *= .86;
      node.x += node.vx;
      node.y += node.vy;
    }
  }

  el.svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
  appendArrowMarker();

  for (const edge of edges) {
    const line = svgElement('line');
    line.classList.add('edge');
    if (edge.boundary) line.classList.add('boundary');
    if (edge.runtimeObservation) line.classList.add('runtime-observation');
    line.setAttribute('x1', edge.a.x);
    line.setAttribute('y1', edge.a.y);
    line.setAttribute('x2', edge.b.x);
    line.setAttribute('y2', edge.b.y);
    line.dataset.id = edge.id;
    line.dataset.from = edge.from;
    line.dataset.to = edge.to;
    line.dataset.type = edge.type;
    line.dataset.boundary = edge.boundary ? '1' : '0';
    line.dataset.runtime = edge.runtimeObservation ? '1' : '0';
    line.onclick = () => {
      if (A) showRef('graph-edge:' + edge.id);
      else showDetail(edge);
    };
    el.svg.append(line);
  }

  const groups = [];
  for (const node of nodes) {
    const group = svgElement('g');
    group.classList.add('node');
    if (node.crossRepository) group.classList.add('cross-repository');
    if (node.runtimeObserved) group.classList.add('runtime-observed');
    group.setAttribute('transform', 'translate(' + node.x + ' ' + node.y + ')');
    group.dataset.id = node.id;
    group.dataset.search = [
      node.label,
      node.key,
      node.repository,
      ...(node.repositories ?? [])
    ].filter(Boolean).join(' ').toLowerCase();

    const circle = svgElement('circle');
    circle.setAttribute('r', nodeRadius(node.kind));
    circle.setAttribute('fill', color(node.kind));
    const text = svgElement('text');
    text.setAttribute('x', nodeRadius(node.kind) + 4);
    text.setAttribute('y', '3');
    text.textContent = shorten(node.label ?? node.key ?? node.id, 38);
    group.append(circle, text);
    group.onclick = () => selectGraphNode(node, group, byId);
    el.svg.append(group);
    groups.push(group);
  }

  graphRender = {
    groups,
    lines: [...el.svg.querySelectorAll('.edge')],
    nodes,
    edges,
    byId
  };
  applyGraphFilter();
}

function selectGraphNode(node, group, byId) {
  markSelected(group);
  const relations = G.edges
    .filter(edge => edge.from === node.id || edge.to === node.id)
    .map(edge => ({
      edge_id: edge.id,
      type: edge.type,
      direction: edge.from === node.id ? 'out' : 'in',
      other:
        byId.get(edge.from === node.id ? edge.to : edge.from)?.label ?? null,
      boundary: Boolean(edge.boundary),
      runtimeObservation: Boolean(edge.runtimeObservation),
      confidence: edge.confidence,
      stage: edge.stage,
      semanticKind: edge.semanticKind
    }));
  showDetail({ ...node, relations });
  renderRefButtons(
    A ? [['GraphNode', 'graph-node:' + node.id]] : []
  );
}

function layoutProjection(D) {
  const rankGroups = new Map();
  for (const node of D.nodes) {
    const rank = Number(node.layout?.rank ?? 0);
    if (!rankGroups.has(rank)) rankGroups.set(rank, []);
    rankGroups.get(rank).push(node);
  }
  for (const rows of rankGroups.values()) {
    rows.sort((a, b) =>
      Number(a.layout?.order ?? 0) - Number(b.layout?.order ?? 0) ||
      a.graph_node_id.localeCompare(b.graph_node_id)
    );
  }

  const ranks = [...rankGroups.keys()].sort((a, b) => a - b);
  const maxRows = Math.max(1, ...[...rankGroups.values()].map(rows => rows.length));
  const width = Math.max(1000, 240 + ranks.length * 250);
  const height = Math.max(700, 140 + maxRows * 100);
  const byId = new Map();

  ranks.forEach((rank, rankIndex) => {
    const rows = rankGroups.get(rank);
    const x = ranks.length === 1
      ? width / 2
      : 130 + rankIndex * ((width - 260) / (ranks.length - 1));
    rows.forEach((node, rowIndex) => {
      const y = rows.length === 1
        ? height / 2
        : 80 + rowIndex * ((height - 160) / (rows.length - 1));
      byId.set(node.graph_node_id, { x, y });
    });
  });

  return { width, height, byId };
}

async function showRef(ref) {
  try {
    const payload = await fetchJson(
      '/api/ref?ref=' + encodeURIComponent(ref)
    );
    showDetail(payload);
    renderNestedRefs(payload);
  } catch (error) {
    showDetail({
      error: 'REF_LOOKUP_FAILED',
      ref,
      message: error.message
    });
  }
}

function renderNestedRefs(payload) {
  const value = payload?.value ?? {};
  const refs = [];

  if (payload?.kind === 'CLAIM') {
    for (const link of value.evidence_links ?? []) {
      refs.push(['Evidence', link.evidence_id]);
    }
    for (const link of value.counterevidence_links ?? []) {
      refs.push(['Counter', link.evidence_id]);
    }
    for (const record of value.verifier_results ?? []) {
      if (record?.id) refs.push(['Verifier', record.id]);
    }
    if (value.subject?.node_id) {
      refs.push(['Subject', 'graph-node:' + value.subject.node_id]);
    }
  } else if (payload?.kind === 'EVIDENCE') {
    const p = value.provenance ?? {};
    if (p.artifact_id) refs.push(['Artifact', p.artifact_id]);
    if (p.runtime_run_id) refs.push(['Run', p.runtime_run_id]);
  } else if (payload?.kind === 'GRAPH_EDGE') {
    refs.push(['From', 'graph-node:' + value.from]);
    refs.push(['To', 'graph-node:' + value.to]);
  }

  renderRefButtons(refs);
}

function renderRefButtons(refs) {
  clear(el.refLinks);
  if (!refs.length) return;
  const wrap = document.createElement('div');
  wrap.className = 'ref-buttons';
  const seen = new Set();
  for (const [label, ref] of refs) {
    const key = label + '\0' + ref;
    if (seen.has(key)) continue;
    seen.add(key);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ref-button';
    button.textContent = label + ': ' + shorten(ref, 32);
    button.onclick = () => showRef(ref);
    wrap.append(button);
  }
  el.refLinks.append(wrap);
}

function showDetail(value) {
  el.detail.textContent = JSON.stringify(value, null, 2);
}

function applySearchFilter() {
  if (el.viewMode.value === 'graph') {
    applyGraphFilter();
    return;
  }
  if (!graphRender) return;
  const search = el.q.value.trim().toLowerCase();
  const visible = new Set();

  for (const group of graphRender.groups ?? []) {
    const match = !search || group.dataset.search.includes(search);
    group.classList.toggle('muted', !match);
    if (match) visible.add(group.dataset.id);
  }
  for (const line of graphRender.lines ?? []) {
    const visibleEdge =
      visible.has(line.dataset.from) &&
      visible.has(line.dataset.to);
    line.classList.toggle('muted', !visibleEdge);
  }
}

function applyGraphFilter() {
  if (!graphRender?.nodes) return;
  const search = el.q.value.toLowerCase();
  const kind = el.kind.value;
  const edgeType = el.edgeType.value;
  const boundary = el.boundaryOnly.checked;
  const runtime = el.runtimeOnly.checked;

  let visible = new Set(
    graphRender.nodes
      .filter(node =>
        (!search ||
          [
            node.label,
            node.key,
            node.repository,
            ...(node.repositories ?? [])
          ].filter(Boolean).join(' ').toLowerCase().includes(search)) &&
        (!kind || node.kind === kind)
      )
      .map(node => node.id)
  );

  if (boundary) {
    const boundaryNodes = new Set(
      graphRender.edges
        .filter(edge => edge.boundary)
        .flatMap(edge => [edge.from, edge.to])
    );
    visible = new Set(
      [...visible].filter(id => boundaryNodes.has(id))
    );
  }

  if (runtime) {
    const runtimeNodes = new Set(
      graphRender.edges
        .filter(edge => edge.runtimeObservation)
        .flatMap(edge => [edge.from, edge.to])
    );
    visible = new Set(
      [...visible].filter(id => runtimeNodes.has(id))
    );
  }

  for (const group of graphRender.groups) {
    group.classList.toggle(
      'muted',
      !visible.has(group.dataset.id)
    );
  }
  for (const line of graphRender.lines) {
    const endpoints =
      visible.has(line.dataset.from) &&
      visible.has(line.dataset.to);
    const typeOk =
      !edgeType || line.dataset.type === edgeType;
    const boundaryOk =
      !boundary || line.dataset.boundary === '1';
    const runtimeOk =
      !runtime || line.dataset.runtime === '1';
    line.classList.toggle(
      'muted',
      !(endpoints && typeOk && boundaryOk && runtimeOk)
    );
  }
}

el.q.oninput = applySearchFilter;
el.kind.onchange = applyGraphFilter;
el.edgeType.onchange = applyGraphFilter;
el.boundaryOnly.onchange = applyGraphFilter;
el.runtimeOnly.onchange = applyGraphFilter;

el.viewMode.onchange = async () => {
  currentFocus = null;
  if (el.viewMode.value === 'focused' && A) {
    el.compatControls.classList.add('hidden');
    el.diagramType.disabled = false;
    el.detailLevel.disabled = false;
    await loadFocusedDiagram();
  } else {
    el.compatControls.classList.remove('hidden');
    renderFullGraph();
  }
};

el.diagramType.onchange = async () => {
  currentFocus = null;
  if (A && el.viewMode.value === 'focused') {
    await loadFocusedDiagram();
  }
};

el.detailLevel.onchange = async () => {
  if (A && el.viewMode.value === 'focused') {
    await loadFocusedDiagram();
  }
};

function appendStageBadges(parent, stages) {
  const row = document.createElement('div');
  for (const stage of stages) {
    const badge = document.createElement('span');
    badge.className =
      'badge fidelity-' + String(stage.status ?? 'unknown');
    badge.textContent =
      String(stage.id ?? '?') + ' ' + String(stage.status ?? '?');
    row.append(badge);
  }
  parent.append(row);
}

function appendKv(parent, key, value) {
  const k = document.createElement('div');
  k.className = 'k';
  k.textContent = String(key);
  const v = document.createElement('div');
  v.className = 'v';
  v.textContent = String(value ?? '');
  parent.append(k, v);
}

function appendTextLine(parent, text, bold = false) {
  const line = document.createElement('div');
  if (bold) {
    const b = document.createElement('b');
    b.textContent = String(text);
    line.append(b);
  } else {
    line.textContent = String(text);
  }
  parent.append(line);
}

function markSelected(group) {
  for (const item of el.svg.querySelectorAll('.selected')) {
    item.classList.remove('selected');
  }
  group.classList.add('selected');
}

function clearSvg() {
  while (el.svg.firstChild) el.svg.firstChild.remove();
  graphRender = null;
}

function appendArrowMarker() {
  const defs = svgElement('defs');
  const marker = svgElement('marker');
  marker.setAttribute('id', 'arrow');
  marker.setAttribute('viewBox', '0 0 10 10');
  marker.setAttribute('refX', '9');
  marker.setAttribute('refY', '5');
  marker.setAttribute('markerWidth', '5');
  marker.setAttribute('markerHeight', '5');
  marker.setAttribute('orient', 'auto-start-reverse');
  const path = svgElement('path');
  path.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z');
  path.setAttribute('fill', 'context-stroke');
  marker.append(path);
  defs.append(marker);
  el.svg.append(defs);
}

function svgElement(name) {
  return document.createElementNS(
    'http://www.w3.org/2000/svg',
    name
  );
}

function nodeRadius(kind) {
  if (
    ['repository','runtime','fidelity_matrix','platform_profile','platform_target']
      .includes(kind)
  ) return 12;
  if (kind === 'mod') return 10;
  if (
    ['runtime_pose_capture','runtime_palette_capture','runtime_network_capture','molang_transport_matrix']
      .includes(kind)
  ) return 9;
  if (
    ['fidelity_capability','network_delivery_stage','molang_transport_stage','class','runtime_entity','runtime_bone_series','runtime_network_observation','runtime_network_semantic_observation']
      .includes(kind)
  ) return 8;
  if (kind === 'method') return 5;
  return 6;
}

function color(kind) {
  let hash = 0;
  for (const char of String(kind)) {
    hash = (hash * 31 + char.charCodeAt(0)) % 360;
  }
  return 'hsl(' + hash + ' 58% 52%)';
}

function shorten(value, max) {
  const text = String(value ?? '');
  return text.length > max
    ? text.slice(0, Math.max(1, max - 1)) + '…'
    : text;
}

function clear(node) {
  while (node.firstChild) node.firstChild.remove();
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      response.status + ' ' + response.statusText + ' for ' + url
    );
  }
  return response.json();
}
