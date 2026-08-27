import { loadViewerSources } from './loader.mjs';
import {
  createViewerModel,
  deterministicLayout,
  isRuntimeEdge
} from './model.mjs';

const source = await loadViewerSources();

const svg = document.querySelector('#graph');
const q = document.querySelector('#q');
const kind = document.querySelector('#kind');
const edgeType = document.querySelector('#edgeType');
const focusMode = document.querySelector('#focusMode');
const boundaryOnly = document.querySelector('#boundaryOnly');
const runtimeOnly = document.querySelector('#runtimeOnly');
const sourceMode = document.querySelector('#sourceMode');
const stageMeta = document.querySelector('#stageMeta');
const identityPanel = document.querySelector('#identityPanel');
const summary = document.querySelector('#summary');
const coveragePanel = document.querySelector('#coveragePanel');
const claimPanel = document.querySelector('#claimPanel');
const evidencePanel = document.querySelector('#evidencePanel');
const detail = document.querySelector('#detail');

let focused = Boolean(source.result);
let model = createViewerModel({
  graph: source.graph,
  result: source.result,
  manifest: source.manifest,
  focused
});
let graphState = null;
let selectedNodeId = null;

focusMode.disabled = !source.result;
focusMode.value = source.result ? 'result' : 'all';
sourceMode.textContent = source.mode;

populateFilters();
renderAll();

function populateFilters() {
  for (const k of [...new Set(
    source.graph.nodes.map(node => node.kind)
  )].sort()) {
    kind.add(new Option(k, k));
  }
  for (const t of [...new Set(
    source.graph.edges.map(edge => edge.type)
  )].sort()) {
    edgeType.add(new Option(t, t));
  }
}

function renderAll() {
  model = createViewerModel({
    graph: source.graph,
    result: source.result,
    manifest: source.manifest,
    focused
  });
  renderIdentity();
  renderSummary();
  renderCoverage();
  renderClaims();
  renderEvidenceIdle();
  renderGraph();

  if (
    selectedNodeId &&
    model.graph.nodes.some(node => node.id === selectedNodeId)
  ) {
    selectNode(selectedNodeId);
  } else {
    selectedNodeId = null;
    detail.className = 'empty';
    detail.textContent = 'ノードを選択';
  }
}

function renderIdentity() {
  if (!source.result) {
    identityPanel.innerHTML =
      '<h2>Identity</h2>' +
      '<div class="empty">graph-only compatibility mode</div>';
    return;
  }

  const id = model.overview.identity;
  identityPanel.innerHTML =
    '<h2>Session / Snapshot</h2>' +
    '<div class="kv">' +
    kv('run', source.result.status) +
    kv('analysis', id.analysis_id) +
    kv('session', id.session_id) +
    kv('repository', id.repository_id) +
    kv('snapshot', id.snapshot_id) +
    kv('snapshot kind', id.snapshot_kind) +
    '</div>';
}

function renderSummary() {
  const o = model.overview;
  const counts = source.graph.meta?.counts ?? {};
  const workspace = o.workspace;
  const platform = o.platform;
  const ysm = o.fidelity.ysm;
  const network = o.fidelity.network;
  const molang = o.molang;

  const parts = [
    '<h2>Architecture</h2>',
    '<div><b>' + o.visible_nodes + '</b> visible / ' +
      o.graph_nodes + ' total nodes · <b>' +
      o.visible_edges + '</b> visible / ' +
      o.graph_edges + ' total edges</div>',
    '<div><b>' + o.boundary_edges +
      '</b> boundary · <b>' + o.runtime_edges +
      '</b> runtime edges</div>'
  ];

  if (workspace) {
    parts.push(
      '<div class="row-meta">' +
      esc((workspace.repositories ?? []).join(' + ')) +
      ' · ' + Number(workspace.boundaryEdgeCount ?? 0) +
      ' workspace boundary edges</div>'
    );
  }

  const countBadges = Object.entries(counts)
    .map(([name, value]) =>
      badge(name + ': ' + value)
    )
    .join('');
  if (countBadges) parts.push('<div>' + countBadges + '</div>');

  if (platform) {
    parts.push(
      '<div class="fidelity"><b>Platform</b><br>' +
      esc(platform.detected?.loader ?? '?') + ' ' +
      esc(platform.detected?.minecraftVersion ?? '?') +
      ' / ' +
      esc(platform.detected?.forgeFamily ?? '?') +
      ' — <b>' + esc(platform.compatibility ?? '?') +
      '</b></div>'
    );
  }

  if (network) {
    parts.push(fidelityBlock('Forge network runtime', network));
  }
  if (molang.total) {
    parts.push(
      '<div class="fidelity"><b>Molang transport</b><br>' +
      '<b>' + molang.m5_observed + '</b>/' + molang.total +
      ' through M5 / <b>' + molang.m6_observed +
      '</b> through M6 / <b>' + molang.correlated +
      '</b> weak correlations<br>' +
      '<b>' + molang.fallback + '</b> server-fallback / <b>' +
      molang.failures + '</b> command failures</div>'
    );
  }
  if (ysm) {
    parts.push(fidelityBlock('YSM fidelity', ysm));
  }

  if (source.result) {
    const claimBadges = Object.entries(o.claims.by_status)
      .map(([status, value]) =>
        statusBadge(status, status + ': ' + value)
      )
      .join('');
    parts.push(
      '<div class="fidelity"><b>Claims</b><br>' +
      claimBadges +
      '</div>'
    );
  }

  summary.innerHTML = parts.join('');
}

function renderCoverage() {
  if (!source.result) {
    coveragePanel.innerHTML =
      '<h2>Coverage / Unknowns</h2>' +
      '<div class="empty">AnalysisResultを読み込むと表示されます</div>';
    return;
  }

  const o = model.overview;
  const c = o.coverage;
  const statusBadges = Object.entries(c.by_status)
    .map(([status, value]) =>
      statusBadge(status, status + ': ' + value)
    )
    .join('');

  const gaps = o.coverage_gaps.length
    ? o.coverage_gaps.map(entry =>
        '<div class="row ' +
        (entry.status === 'FAILED' ? 'failure' : '') +
        '">' +
        '<div class="row-title">' +
        statusBadge(entry.status, entry.status) +
        '<b>' + esc(entry.id) + '</b></div>' +
        '<div class="row-meta">' +
        esc(entry.reason ?? entry.reason_code ?? 'unresolved') +
        '</div></div>'
      ).join('')
    : '<div class="empty">failed / unexplored = none</div>';

  const unknowns = o.unknowns.length
    ? o.unknowns.map(item =>
        '<div class="row">' +
        '<div class="row-title">' +
        badge('UNKNOWN') +
        '<b>' + esc(item.ref ?? item.kind ?? 'unknown') +
        '</b></div>' +
        '<div class="row-meta">' +
        esc(item.reason ?? item.reason_code ?? 'unresolved') +
        '</div></div>'
      ).join('')
    : '<div class="empty">UNKNOWN = none</div>';

  coveragePanel.innerHTML =
    '<h2>Coverage / Unknowns</h2>' +
    '<div><b>' + esc(c.completeness) + '</b> · ' +
    c.total + ' entries</div>' +
    '<div>' + statusBadges + '</div>' +
    '<h3>Unexplored / Failed</h3><div class="list">' +
    gaps + '</div>' +
    '<h3>Unknowns</h3><div class="list">' +
    unknowns + '</div>' +
    renderValidation(o);
}

function renderClaims() {
  if (!source.result) {
    claimPanel.innerHTML =
      '<h2>Claims / Evidence</h2>' +
      '<div class="empty">AnalysisResultを読み込むと表示されます</div>';
    return;
  }

  const claims = source.result.claims ?? [];
  const rows = claims.length
    ? claims.map(claim => {
        const support = claim.evidence_links
          .filter(link => link.role === 'SUPPORT')
          .map(link => link.evidence_id);
        const counter = claim.counterevidence_links
          .filter(link => link.role === 'CONTRADICT')
          .map(link => link.evidence_id);
        return (
          '<div class="row claim-row" data-claim-id="' +
          attr(claim.id) + '">' +
          '<div class="row-title">' +
          statusBadge(claim.status, claim.status) +
          badge(claim.type) +
          '<b>' + esc(claim.predicate) + '</b></div>' +
          '<div class="row-meta">' +
          esc(JSON.stringify(claim.object_or_value)) +
          '</div>' +
          (claim.subject?.node_id
            ? '<button class="ref-button node-ref" data-node-ref="' +
              attr(claim.subject.node_id) + '">node</button>'
            : '') +
          evidenceButtonHtml(support, 'evidence') +
          evidenceButtonHtml(counter, 'counter') +
          (claim.unresolved_reason
            ? '<div class="row-meta">reason: ' +
              esc(claim.unresolved_reason) + '</div>'
            : '') +
          '</div>'
        );
      }).join('')
    : '<div class="empty">claims = none</div>';

  claimPanel.innerHTML =
    '<h2>Claims / Evidence / Counterevidence</h2>' +
    '<div class="list">' + rows + '</div>';

  wireRefButtons(claimPanel);
}

function renderEvidenceIdle() {
  evidencePanel.innerHTML =
    '<h2>Evidence / Provenance</h2>' +
    '<div class="empty">Evidence refを選択すると本文を遅延ロードします</div>';
}

function renderGraph() {
  svg.replaceChildren();

  const nodes = model.graph.nodes.map(node => structuredClone(node));
  const edges = model.graph.edges.map(edge => structuredClone(edge));
  const W = 1400;
  const H = 900;
  const positions = deterministicLayout(nodes, edges, {
    width: W,
    height: H
  });

  const byId = new Map(
    nodes.map(node => [String(node.id), node])
  );
  const visibleEdges = edges
    .map(edge => ({
      ...edge,
      a: byId.get(String(edge.from)),
      b: byId.get(String(edge.to))
    }))
    .filter(edge => edge.a && edge.b);

  for (const node of nodes) {
    const pos = positions[String(node.id)] ?? {
      x: W / 2,
      y: H / 2
    };
    node.x = pos.x;
    node.y = pos.y;
  }

  svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
  const NS = 'http://www.w3.org/2000/svg';

  for (const edge of visibleEdges) {
    const line = document.createElementNS(NS, 'line');
    line.classList.add('edge');
    if (edge.boundary) line.classList.add('boundary');
    if (isRuntimeEdge(edge)) {
      line.classList.add('runtime-observation');
    }
    line.setAttribute('x1', edge.a.x);
    line.setAttribute('y1', edge.a.y);
    line.setAttribute('x2', edge.b.x);
    line.setAttribute('y2', edge.b.y);
    line.dataset.id = edge.id;
    line.dataset.from = edge.from;
    line.dataset.to = edge.to;
    line.dataset.type = edge.type;
    line.dataset.boundary = edge.boundary ? '1' : '0';
    line.dataset.runtime = isRuntimeEdge(edge) ? '1' : '0';
    svg.append(line);
  }

  const groups = [];
  for (const node of nodes) {
    const group = document.createElementNS(NS, 'g');
    group.classList.add('node');
    if (node.crossRepository) group.classList.add('cross-repository');
    if (node.runtimeObserved) group.classList.add('runtime-observed');

    if (
      source.result &&
      model.claim_node_ids.has(String(node.id))
    ) {
      group.classList.add('has-claim');
    }

    group.setAttribute(
      'transform',
      'translate(' + node.x + ' ' + node.y + ')'
    );
    group.dataset.id = node.id;

    const circle = document.createElementNS(NS, 'circle');
    circle.setAttribute('r', radius(node.kind));
    circle.setAttribute('fill', color(node.kind));

    const text = document.createElementNS(NS, 'text');
    text.setAttribute('x', radius(node.kind) + 4);
    text.setAttribute('y', '3');
    text.textContent = String(node.label ?? node.key ?? node.id).slice(0, 38);

    group.append(circle, text);
    group.onclick = () => selectNode(node.id);
    svg.append(group);
    groups.push(group);
  }

  graphState = {
    nodes,
    edges: visibleEdges,
    groups,
    byId
  };

  stageMeta.textContent =
    (model.focused ? 'result focus' : 'full graph') +
    ' · ' + nodes.length + ' nodes / ' +
    visibleEdges.length + ' edges';

  applyFilter();
}

function selectNode(nodeId) {
  if (!graphState) return;
  const id = String(nodeId);
  const node = graphState.byId.get(id);
  if (!node) {
    if (source.result && focused) {
      focusMode.value = 'all';
      focused = false;
      renderAll();
      return selectNode(id);
    }
    return;
  }

  selectedNodeId = id;
  for (const group of graphState.groups) {
    group.classList.toggle(
      'selected',
      group.dataset.id === id
    );
  }

  const panel = model.node(id);
  renderNodeDetail(panel);
}

function renderNodeDetail(panel) {
  if (!panel) {
    detail.className = 'empty';
    detail.textContent = 'ノードが見つかりません';
    return;
  }
  detail.className = '';

  const node = panel.node;
  const responsibility = panel.responsibility
    ? '<div class="row"><b>Responsibility</b><div class="row-meta">' +
      esc(panel.responsibility.text) +
      ' <span class="badge">' +
      esc(panel.responsibility.source) +
      '</span></div></div>'
    : '<div class="empty">responsibility summary = unavailable</div>';

  const anchor = panel.source_anchor
    ? '<div class="source-anchor"><b>Source</b><br>' +
      esc(panel.source_anchor.path ?? '?') +
      (panel.source_anchor.range
        ? '<br>' + esc(JSON.stringify(panel.source_anchor.range))
        : '') +
      '</div>'
    : '';

  const claimRows = panel.claims.length
    ? panel.claims.map(claim =>
        '<div class="row">' +
        '<div class="row-title">' +
        statusBadge(claim.status, claim.status) +
        '<b>' + esc(claim.predicate) + '</b></div>' +
        '<div class="row-meta">' +
        esc(JSON.stringify(claim.object_or_value)) +
        '</div>' +
        evidenceButtonHtml(
          claim.support_evidence_ids,
          'evidence'
        ) +
        evidenceButtonHtml(
          claim.counterevidence_ids,
          'counter'
        ) +
        '</div>'
      ).join('')
    : '<div class="empty">node claims = none</div>';

  const coverageRows = panel.coverage.length
    ? panel.coverage.map(entry =>
        '<div class="row">' +
        '<div class="row-title">' +
        statusBadge(entry.status, entry.status) +
        '<b>' + esc(entry.id) + '</b></div>' +
        (entry.reason
          ? '<div class="row-meta">' + esc(entry.reason) + '</div>'
          : '') +
        '</div>'
      ).join('')
    : '<div class="empty">direct coverage entry = none</div>';

  detail.innerHTML =
    '<div class="kv">' +
    kv('label', node.label ?? node.key ?? node.id) +
    kv('kind', node.kind) +
    kv('id', node.id) +
    kv('repository', node.repository ?? '') +
    '</div>' +
    anchor +
    '<h3>Responsibility</h3>' + responsibility +
    '<div class="relation-grid">' +
    relationSection('Callers', panel.callers) +
    relationSection('Callees', panel.callees) +
    '</div>' +
    '<h3>Domain semantic edges</h3>' +
    relationRows(panel.domain_semantic_edges) +
    '<h3>Runtime overlay</h3>' +
    relationRows(panel.runtime_overlay) +
    '<h3>Claims / evidence</h3><div class="list">' +
    claimRows + '</div>' +
    '<h3>Coverage</h3><div class="list">' +
    coverageRows + '</div>' +
    jsonDetails('Raw node data', node);

  wireRefButtons(detail);
}

async function openEvidence(evidenceId) {
  const id = String(evidenceId);
  evidencePanel.innerHTML =
    '<h2>Evidence / Provenance</h2>' +
    '<div class="empty">loading ' + esc(id) + '…</div>';

  try {
    const record = await source.loadEvidence(id);
    if (!record) {
      evidencePanel.innerHTML =
        '<h2>Evidence / Provenance</h2>' +
        '<div class="failure">Evidence ref not available: ' +
        esc(id) + '</div>';
      return;
    }

    const provenance = record.provenance ?? {};
    evidencePanel.replaceChildren();

    const heading = document.createElement('h2');
    heading.textContent = 'Evidence / Provenance';

    const meta = document.createElement('div');
    meta.className = 'kv';
    meta.innerHTML =
      kv('id', record.id) +
      kv('kind', record.kind) +
      kv('trust', record.trust_class) +
      kv(
        'provider',
        String(record.provider_id) + '@' +
        String(record.provider_version)
      ) +
      kv('path', provenance.path ?? '') +
      kv('symbol', provenance.symbol_id ?? '') +
      kv('artifact', provenance.artifact_id ?? '') +
      kv('runtime run', provenance.runtime_run_id ?? '') +
      kv('snapshot', provenance.snapshot_id ?? '');

    const observation = document.createElement('pre');
    observation.textContent = JSON.stringify(
      record.observation,
      null,
      2
    );

    evidencePanel.append(heading, meta, observation);
  } catch (error) {
    evidencePanel.innerHTML =
      '<h2>Evidence / Provenance</h2>' +
      '<div class="failure">' +
      esc(String(error?.message ?? error)) +
      '</div>';
  }
}

function applyFilter() {
  if (!graphState) return;
  const search = q.value.toLowerCase();
  const selectedKind = kind.value;
  const selectedEdge = edgeType.value;
  const boundary = boundaryOnly.checked;
  const runtime = runtimeOnly.checked;

  let visible = new Set(
    graphState.nodes
      .filter(node => {
        const claimText =
          model.claim_search_by_node.get(String(node.id)) ?? '';
        const haystack = (
          String(node.label ?? '') + ' ' +
          String(node.key ?? '') + ' ' +
          String(node.repository ?? '') + ' ' +
          (node.repositories ?? []).join(' ') + ' ' +
          claimText
        ).toLowerCase();
        return (
          (!search || haystack.includes(search)) &&
          (!selectedKind || node.kind === selectedKind)
        );
      })
      .map(node => node.id)
  );

  if (boundary) {
    const boundaryNodes = new Set(
      graphState.edges
        .filter(edge => edge.boundary)
        .flatMap(edge => [edge.from, edge.to])
    );
    visible = new Set(
      [...visible].filter(id => boundaryNodes.has(id))
    );
  }

  if (runtime) {
    const runtimeNodes = new Set(
      graphState.edges
        .filter(isRuntimeEdge)
        .flatMap(edge => [edge.from, edge.to])
    );
    visible = new Set(
      [...visible].filter(id => runtimeNodes.has(id))
    );
  }

  for (const group of graphState.groups) {
    group.classList.toggle(
      'muted',
      !visible.has(group.dataset.id)
    );
  }

  for (const line of svg.querySelectorAll('.edge')) {
    const endpoints =
      visible.has(line.dataset.from) &&
      visible.has(line.dataset.to);
    const typeOk =
      !selectedEdge ||
      line.dataset.type === selectedEdge;
    const boundaryOk =
      !boundary ||
      line.dataset.boundary === '1';
    const runtimeOk =
      !runtime ||
      line.dataset.runtime === '1';
    line.classList.toggle(
      'muted',
      !(endpoints && typeOk && boundaryOk && runtimeOk)
    );
  }
}

function relationSection(title, rows) {
  return '<div><h3>' + esc(title) + '</h3>' +
    relationRows(rows) + '</div>';
}

function relationRows(rows) {
  if (!rows.length) {
    return '<div class="empty">none</div>';
  }
  return '<div class="list">' +
    rows.map(row =>
      '<div class="row">' +
      '<div class="row-title">' +
      badge(row.type) +
      (row.runtime_observed ? badge('runtime') : '') +
      (row.boundary ? badge('boundary') : '') +
      '</div>' +
      '<button class="ref-button node-ref" data-node-ref="' +
      attr(row.other_id) + '">' +
      esc(row.direction + ' → ' + row.other_label) +
      '</button>' +
      (row.stage
        ? '<div class="row-meta">stage: ' +
          esc(row.stage) + '</div>'
        : '') +
      ((row.evidence || row.fields || row.samples)
        ? jsonDetails('edge evidence', {
            evidence: row.evidence,
            fields: row.fields,
            samples: row.samples
          })
        : '') +
      '</div>'
    ).join('') +
    '</div>';
}

function evidenceButtonHtml(ids, label) {
  return ids.map(id =>
    '<button class="ref-button evidence-ref" data-evidence-ref="' +
    attr(id) + '">' +
    esc(label) + ': ' + esc(shortRef(id)) +
    '</button>'
  ).join('');
}

function wireRefButtons(root) {
  for (const button of root.querySelectorAll('.evidence-ref')) {
    button.onclick = () =>
      openEvidence(button.dataset.evidenceRef);
  }
  wireNodeButtons(root);
}

function wireNodeButtons(root) {
  for (const button of root.querySelectorAll('.node-ref')) {
    button.onclick = () =>
      selectNode(button.dataset.nodeRef);
  }
}

function renderValidation(overview) {
  const sections = [];
  if (overview.recommended_validation?.length) {
    sections.push(
      '<h3>Recommended validation</h3>' +
      '<div class="list">' +
      overview.recommended_validation.map(item =>
        '<div class="row warning"><b>' +
        esc(item.code ?? 'VALIDATE') +
        '</b><div class="row-meta">' +
        esc(item.message ?? item) +
        '</div></div>'
      ).join('') +
      '</div>'
    );
  }
  if (overview.warnings?.length) {
    sections.push(
      '<h3>Warnings</h3><div class="list">' +
      overview.warnings.map(item =>
        '<div class="row warning"><b>' +
        esc(item.code ?? 'WARNING') +
        '</b><div class="row-meta">' +
        esc(item.message ?? item.reason ?? item) +
        '</div></div>'
      ).join('') + '</div>'
    );
  }
  if (overview.failures?.length) {
    sections.push(
      '<h3>Failures</h3><div class="list">' +
      overview.failures.map(item =>
        '<div class="row failure"><b>' +
        esc(item.code ?? 'FAILURE') +
        '</b><div class="row-meta">' +
        esc(item.message ?? item.reason ?? item) +
        '</div></div>'
      ).join('') + '</div>'
    );
  }
  return sections.join('');
}

function jsonDetails(title, value) {
  return '<details><summary>' + esc(title) + '</summary>' +
    '<pre>' + esc(JSON.stringify(value, null, 2)) + '</pre>' +
    '</details>';
}

function fidelityBlock(title, value) {
  return (
    '<div class="fidelity"><b>' + esc(title) + '</b><br>' +
    'observed through <b>' +
    esc(value.observed_through ?? 'none') +
    '</b>' +
    (value.first_unobserved
      ? ' / next <b>' + esc(value.first_unobserved) + '</b>'
      : '') +
    '<br>' +
    (value.stages ?? []).map(stage =>
      '<span class="badge fidelity-' +
      attr(stage.status) + '">' +
      esc(stage.id + ' ' + stage.status) +
      '</span>'
    ).join('') +
    '</div>'
  );
}

function statusBadge(status, label) {
  const value = String(status ?? 'UNKNOWN');
  return '<span class="badge badge-' +
    attr(value.toLowerCase()) + '">' +
    esc(label ?? value) + '</span>';
}

function badge(value) {
  return '<span class="badge">' + esc(value) + '</span>';
}

function kv(label, value) {
  return '<b>' + esc(label) + '</b><span>' +
    esc(value ?? '') + '</span>';
}

function shortRef(value) {
  const text = String(value);
  return text.length > 30
    ? text.slice(0, 14) + '…' + text.slice(-10)
    : text;
}

function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function attr(value) {
  return esc(value);
}

function radius(k) {
  return [
    'repository',
    'runtime',
    'fidelity_matrix',
    'platform_profile',
    'platform_target'
  ].includes(k)
    ? 12
    : k === 'mod'
      ? 10
      : [
          'runtime_pose_capture',
          'runtime_palette_capture',
          'runtime_network_capture',
          'molang_transport_matrix'
        ].includes(k)
        ? 9
        : [
            'fidelity_capability',
            'network_delivery_stage',
            'molang_transport_stage',
            'class',
            'runtime_entity',
            'runtime_bone_series',
            'runtime_network_observation',
            'runtime_network_semantic_observation'
          ].includes(k)
          ? 8
          : k === 'method'
            ? 5
            : 6;
}

function color(k) {
  let h = 0;
  for (const c of String(k)) {
    h = (h * 31 + c.charCodeAt(0)) % 360;
  }
  return 'hsl(' + h + ' 58% 52%)';
}

q.oninput = applyFilter;
kind.onchange = applyFilter;
edgeType.onchange = applyFilter;
boundaryOnly.onchange = applyFilter;
runtimeOnly.onchange = applyFilter;
focusMode.onchange = () => {
  focused = focusMode.value === 'result';
  renderAll();
};
