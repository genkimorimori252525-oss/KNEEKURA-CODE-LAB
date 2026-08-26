/**
 * Derive an evidence-oriented YSM/TLM fidelity matrix from facts already present in Common Graph IR.
 *
 * Important: "unobserved" is not "failed". The matrix says how far evidence reaches in this scan,
 * not whether a capability is impossible or broken.
 */
export function deriveYsmFidelityMatrix(builder) {
  const graph = builder.graph;
  const byId = new Map(graph.nodes.map(n => [n.id, n]));

  const stages = [
    stage('C0', 'Static YSM contracts', 'static', [
      'YSM model/animation/Molang/resource semantics were found by static analysis.'
    ], evidenceStatic(graph, byId),
    'If unobserved, inspect resource discovery / parser coverage before blaming runtime.'),

    stage('C1', 'Runtime YSM mod presence', 'loader', [
      'The runtime trace reports Yes Steve Model as a loaded/present mod.'
    ], evidenceRuntimeMod(graph, byId),
    'If unobserved, inspect mod discovery/loader/classpath and trace meta.mods.'),

    stage('C2', 'Runtime entity lifecycle', 'server-world', [
      'A runtime entity instance was observed in the SimLab trace.'
    ], evidenceByKinds(graph, ['runtime_entity']),
    'If unobserved, inspect world/entity spawn, scenario setup, or trace instrumentation.'),

    stage('C3', 'YSM command boundary', 'protocol', [
      'Runtime animation and/or Molang commands crossed the TLM -> YSM semantic boundary.'
    ], evidenceByEdgeTypes(graph, byId, new Set([
      'OBSERVED_RUNTIME_ANIMATION',
      'OBSERVED_RUNTIME_PENDING_ANIMATION',
      'OBSERVED_RUNTIME_MOLANG_SEND',
      'OBSERVED_RUNTIME_FACE_STATE'
    ])),
    'If unobserved, inspect the Java bridge/dispatch path before investigating client rendering.'),

    stage('C4', 'Client rendered vertices', 'client-render', [
      'A matching UUID/tick-window pose companion produced structurally valid rendered vertex evidence.'
    ], evidenceByKinds(graph, ['runtime_pose_capture'], n => n.renderEvidence === true),
    'If unobserved, inspect pose identity rejection, client capture, YSM render entry, native/backend, or binary integrity.'),

    stage('C5', 'Per-bone runtime transform', 'bone-runtime', [
      'KNEEKURA palette evidence directly observed post-geoRender per-bone local rotation/position/scale.'
    ], evidenceByEdgeTypes(graph, byId, new Set(['OBSERVED_RUNTIME_BONE_TRANSFORM'])),
    'If unobserved, inspect palette capture/identity/decoder evidence. Pose vertices alone do not prove per-bone attribution.')
  ];

  const matrix = builder.node('fidelity_matrix', 'ysm-tlm-runtime', {
    label: 'YSM/TLM fidelity matrix',
    ecosystem: 'ysm',
    evidenceSemantics: 'observed-vs-unobserved',
    absenceIsFailure: false
  });

  for (let i = 0; i < stages.length; i++) {
    const s = stages[i];
    const observed = s.evidence.length > 0;
    s.status = observed ? 'observed' : 'unobserved';

    const cap = builder.node('fidelity_capability', `ysm-tlm-runtime:${s.id}`, {
      label: `${s.id} ${s.label}`,
      stage: s.id,
      order: i,
      domain: s.domain,
      status: s.status,
      observed,
      description: s.description,
      diagnosticHint: s.diagnosticHint,
      evidenceNodeCount: s.evidence.length,
      evidenceKinds: [...new Set(s.evidence.map(n => n.kind))],
      absenceIsFailure: false
    });
    s.node = cap;

    builder.edge(matrix, cap, 'HAS_FIDELITY_STAGE', {
      source: 'fidelity-matrix',
      confidence: 1,
      order: i,
      status: s.status
    });

    for (const evidence of s.evidence.slice(0, 16)) {
      builder.edge(cap, evidence, 'SUPPORTED_BY', {
        source: 'fidelity-matrix',
        confidence: 1,
        fidelityEvidence: true
      });
    }
  }

  const observedStages = stages.filter(s => s.status === 'observed');
  let contiguous = -1;
  for (let i = 0; i < stages.length; i++) {
    if (stages[i].status !== 'observed') break;
    contiguous = i;
  }
  const firstGap = stages.find(s => s.status !== 'observed') ?? null;
  const highest = observedStages.length ? observedStages[observedStages.length - 1] : null;

  Object.assign(matrix, {
    totalStages: stages.length,
    observedStageCount: observedStages.length,
    observedThroughStage: contiguous >= 0 ? stages[contiguous].id : null,
    observedThroughLabel: contiguous >= 0 ? stages[contiguous].label : null,
    highestObservedStage: highest?.id ?? null,
    highestObservedLabel: highest?.label ?? null,
    firstUnobservedStage: firstGap?.id ?? null,
    firstUnobservedLabel: firstGap?.label ?? null,
    nextDiagnosticHint: firstGap?.diagnosticHint ?? null,
    stageSummary: stages.map(s => ({
      id: s.id,
      label: s.label,
      domain: s.domain,
      status: s.status,
      evidenceNodeCount: s.evidence.length
    })),
    interpretation: 'unobserved means evidence is absent in this graph, not that the capability failed'
  });

  builder.addAnalyzer('ysm-fidelity-matrix', 'v1');
  return matrix;
}

function stage(id, label, domain, description, evidence, diagnosticHint) {
  return { id, label, domain, description, evidence: dedupe(evidence), diagnosticHint, status: 'unobserved', node: null };
}

function evidenceStatic(graph, byId) {
  const edgeTypes = new Set([
    'READS_MOLANG',
    'WRITES_MOLANG',
    'PROVIDES_ANIMATION_NAME',
    'DECLARES_MODEL',
    'ANIMATES_BONE',
    'LOADS_MODEL_RESOURCE',
    'LOADS_ANIMATION_RESOURCE'
  ]);
  const nodes = [];
  for (const e of graph.edges) {
    if (!edgeTypes.has(e.type) || e.runtimeObservation) continue;
    if (byId.get(e.from)) nodes.push(byId.get(e.from));
    if (byId.get(e.to)) nodes.push(byId.get(e.to));
  }
  for (const n of graph.nodes) {
    if (['ysm_model_pack', 'model_definition', 'animation_definition', 'model_bone', 'bone_name'].includes(n.kind)) {
      nodes.push(n);
    }
  }
  return dedupe(nodes);
}

function evidenceRuntimeMod(graph, byId) {
  const nodes = [];
  for (const e of graph.edges) {
    if (e.type !== 'OBSERVED_RUNTIME_MOD') continue;
    const mod = byId.get(e.to);
    if (!mod || mod.kind !== 'mod') continue;
    if (isYsmMod(mod)) {
      nodes.push(mod);
      const runtime = byId.get(e.from);
      if (runtime) nodes.push(runtime);
    }
  }
  return dedupe(nodes);
}

function isYsmMod(node) {
  const text = `${node.key ?? ''} ${node.label ?? ''}`.toLowerCase();
  return text.includes('yes_steve_model') || text.includes('yes-steve-model') || /\bysm\b/.test(text);
}

function evidenceByKinds(graph, kinds, predicate = () => true) {
  const set = new Set(kinds);
  return graph.nodes.filter(n => set.has(n.kind) && predicate(n));
}

function evidenceByEdgeTypes(graph, byId, types) {
  const nodes = [];
  for (const e of graph.edges) {
    if (!types.has(e.type)) continue;
    const from = byId.get(e.from);
    const to = byId.get(e.to);
    if (from) nodes.push(from);
    if (to) nodes.push(to);
  }
  return dedupe(nodes);
}

function dedupe(nodes) {
  const seen = new Set();
  const out = [];
  for (const n of nodes) {
    if (!n?.id || seen.has(n.id)) continue;
    seen.add(n.id);
    out.push(n);
  }
  return out;
}
