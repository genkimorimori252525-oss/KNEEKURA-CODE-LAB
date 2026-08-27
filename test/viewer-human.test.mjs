import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

import { analyzeInternal } from '../src/core/api/analyze.mjs';
import { renderAnalysisForAI } from '../src/core/render/ai.mjs';
import { validateAnalysisResultV1 } from '../src/core/schema/v1.mjs';
import {
  createHumanViewerManifest,
  encodeRef,
  writeHumanViewerBundle
} from '../src/viewer/bundle.mjs';
import { loadViewerSources } from '../viewer/loader.mjs';
import {
  buildNodePanel,
  createViewerModel,
  deterministicLayout,
  projectGraph
} from '../viewer/model.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FORGE_FIXTURE = path.join(ROOT, 'fixtures/forge-mini');
const TRACE = path.join(ROOT, 'fixtures/runtime/kneekura-trace.jsonl');
const SERVER_NET = path.join(ROOT, 'fixtures/runtime/kneekura-server.net.jsonl');
const CLIENT_NET = path.join(ROOT, 'fixtures/runtime/kneekura-client.net.jsonl');
const execFile = promisify(execFileCallback);

let executionPromise = null;

function execution() {
  executionPromise ??= analyzeInternal({
    schema: 'core.analysis-request/v1',
    repository: FORGE_FIXTURE,
    mode: 'RUNTIME',
    question: 'Show ReimuPacket runtime path for the human viewer.',
    scope: {
      paths: ['ReimuPacket.java']
    },
    policy: 'precision',
    output_profile: 'compact',
    runtime_artifacts: [
      { kind: 'trace', path: TRACE },
      { kind: 'network', path: SERVER_NET },
      { kind: 'network', path: CLIENT_NET }
    ]
  });
  return executionPromise;
}

test('same canonical AnalysisResult feeds both AI and Human render models', async () => {
  const run = await execution();
  const result = run.result;
  const ai = renderAnalysisForAI(result, { profile: 'compact' });
  const human = createViewerModel({
    graph: run.state.graph,
    result
  });

  assert.equal(human.mode, 'ANALYSIS_RESULT');
  assert.equal(
    human.overview.identity.analysis_id,
    result.analysis_id
  );
  assert.equal(
    human.overview.coverage.completeness,
    result.coverage.completeness
  );
  assert.equal(
    human.overview.claims.total,
    result.claims.length
  );
  assert.deepEqual(
    human.overview.unknowns,
    result.unknowns
  );
  assert.equal(ai.includes(result.analysis_id), true);
  assert.equal(
    ai.includes(result.coverage.completeness),
    true
  );
});

test('focused Viewer projection is derived only from canonical result refs', async () => {
  const run = await execution();
  const projection = projectGraph(
    run.state.graph,
    run.result,
    { focused: true }
  );

  const nodeIds = new Set(
    projection.nodes.map(node => String(node.id))
  );
  const edgeIds = new Set(
    projection.edges.map(edge => String(edge.id))
  );

  for (const symbol of run.result.affected_symbols) {
    assert.equal(nodeIds.has(String(symbol.node_id)), true);
  }
  for (const edge of run.result.graph_paths) {
    assert.equal(nodeIds.has(String(edge.from)), true);
    assert.equal(nodeIds.has(String(edge.to)), true);
    if (
      run.state.graph.edges.some(item =>
        String(item.id) === String(edge.edge_id)
      )
    ) {
      assert.equal(edgeIds.has(String(edge.edge_id)), true);
    }
  }

  assert.ok(projection.nodes.length <= run.state.graph.nodes.length);
  assert.ok(projection.edges.length <= run.state.graph.edges.length);
});

test('graph-only Viewer compatibility keeps the full existing graph', async () => {
  const run = await execution();
  const model = createViewerModel({
    graph: run.state.graph
  });

  assert.equal(model.mode, 'GRAPH_ONLY');
  assert.equal(model.focused, false);
  assert.equal(
    model.graph.nodes.length,
    run.state.graph.nodes.length
  );
  assert.equal(
    model.graph.edges.length,
    run.state.graph.edges.length
  );
  assert.equal(model.overview.coverage, null);
});

test('Understand Anything summary is exposed as human responsibility text', () => {
  const graph = {
    meta: {},
    nodes: [{
      id: 'ua:service',
      kind: 'ua:service',
      key: 'service',
      label: 'Service',
      summary: 'Coordinates packet handling and state updates.',
      path: 'src/Service.java',
      lineRange: { start: 10, end: 40 }
    }],
    edges: []
  };

  const panel = buildNodePanel(graph, null, 'ua:service');
  assert.equal(panel.responsibility.source, 'summary');
  assert.equal(
    panel.responsibility.text,
    'Coordinates packet handling and state updates.'
  );
  assert.equal(panel.source_anchor.path, 'src/Service.java');
});

test('human node panel groups callers callees semantic runtime claims and coverage', () => {
  const graph = {
    meta: {},
    nodes: [
      { id: 'caller', kind: 'method', key: 'caller', label: 'caller' },
      { id: 'target', kind: 'method', key: 'target', label: 'target', path: 'src/T.java' },
      { id: 'callee', kind: 'method', key: 'callee', label: 'callee' },
      { id: 'runtime', kind: 'runtime_entity', key: 'runtime', label: 'runtime' }
    ],
    edges: [
      { id: 'e1', from: 'caller', to: 'target', type: 'CALLS' },
      { id: 'e2', from: 'target', to: 'callee', type: 'CALLS' },
      {
        id: 'e3',
        from: 'target',
        to: 'runtime',
        type: 'OBSERVED_PACKET_SEND',
        runtimeObservation: true,
        semanticKind: 'network'
      }
    ]
  };
  const result = {
    schema: 'core.analysis-result/v1',
    claims: [{
      id: 'claim:1',
      type: 'INFERRED',
      status: 'UNRESOLVED',
      subject: { node_id: 'target', key: 'target' },
      predicate: 'fixture.path',
      object_or_value: true,
      confidence: { level: 'LOW', rationale: 'fixture' },
      evidence_links: [{
        evidence_id: 'evidence:1',
        role: 'SUPPORT',
        strength: 'INDIRECT'
      }],
      counterevidence_links: [{
        evidence_id: 'evidence:2',
        role: 'CONTRADICT',
        strength: 'INDIRECT'
      }],
      dependency_claim_ids: [],
      coverage_ref: 'coverage:fixture',
      provenance_refs: [],
      verifier_results: []
    }],
    coverage: {
      entries: [{
        id: 'node:target',
        node_id: 'target',
        role: 'PRIMARY',
        status: 'ANALYZED'
      }]
    }
  };

  const panel = buildNodePanel(graph, result, 'target');
  assert.equal(panel.callers.length, 1);
  assert.equal(panel.callees.length, 1);
  assert.equal(panel.runtime_overlay.length, 1);
  assert.equal(panel.domain_semantic_edges.length >= 1, true);
  assert.deepEqual(panel.evidence_refs, [
    'evidence:1',
    'evidence:2'
  ]);
  assert.equal(panel.coverage.length, 1);
});

test('Viewer graph layout is deterministic for the same graph', async () => {
  const run = await execution();
  const nodes = run.state.graph.nodes.slice(0, 24);
  const ids = new Set(nodes.map(node => node.id));
  const edges = run.state.graph.edges.filter(edge =>
    ids.has(edge.from) && ids.has(edge.to)
  );

  const a = deterministicLayout(nodes, edges, {
    iterations: 20
  });
  const b = deterministicLayout(nodes, edges, {
    iterations: 20
  });
  assert.deepEqual(a, b);

  for (const point of Object.values(a)) {
    assert.equal(Number.isFinite(point.x), true);
    assert.equal(Number.isFinite(point.y), true);
  }
});

test('human Viewer manifest externalizes Evidence while keeping canonical result valid', async () => {
  const run = await execution();
  assert.ok(run.result.evidence.length > 0);

  const bundle = createHumanViewerManifest(run.result);
  validateAnalysisResultV1(bundle.result);

  assert.equal(
    Object.hasOwn(bundle.result, 'evidence'),
    false
  );
  assert.equal(
    Object.keys(bundle.manifest.evidence_index).length,
    run.result.evidence.length
  );

  for (const entry of Object.values(bundle.manifest.evidence_index)) {
    assert.equal(Object.hasOwn(entry, 'observation'), false);
    assert.equal(
      entry.ref.startsWith('refs/evidence/'),
      true
    );
  }

  assert.ok(run.result.evidence.length > 0);
});

test('written Viewer bundle keeps each EvidenceRecord behind its own ref', async () => {
  const run = await execution();
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'kneekura-viewer-bundle-')
  );
  try {
    const written = await writeHumanViewerBundle({
      result: run.result,
      graph: run.state.graph,
      outDir: root
    });

    const result = JSON.parse(
      await fs.readFile(written.result_path, 'utf8')
    );
    const manifest = JSON.parse(
      await fs.readFile(written.manifest_path, 'utf8')
    );

    assert.equal(Object.hasOwn(result, 'evidence'), false);
    validateAnalysisResultV1(result);
    assert.equal(
      manifest.counts.evidence,
      run.result.evidence.length
    );

    const evidence = run.result.evidence[0];
    const evidenceFile = path.join(
      root,
      'refs',
      'evidence',
      encodeRef(evidence.id) + '.json'
    );
    const restored = JSON.parse(
      await fs.readFile(evidenceFile, 'utf8')
    );
    assert.deepEqual(restored, evidence);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Viewer loader does not fetch Evidence body until drill-down', async () => {
  const run = await execution();
  const bundle = createHumanViewerManifest(run.result);
  const evidence = run.result.evidence[0];
  assert.ok(evidence);

  const ref = '/' + bundle.manifest.evidence_index[evidence.id].ref;
  const resources = new Map([
    ['/viewer-manifest.json', bundle.manifest],
    ['/analysis-result.json', bundle.result],
    ['/graph.json', run.state.graph],
    [ref, evidence]
  ]);
  const calls = [];

  const fetchImpl = async url => {
    calls.push(String(url));
    const value = resources.get(String(url));
    if (value == null) {
      return {
        status: 404,
        ok: false,
        async json() { return null; }
      };
    }
    return {
      status: 200,
      ok: true,
      async json() { return structuredClone(value); }
    };
  };

  const loaded = await loadViewerSources({ fetchImpl });
  assert.equal(loaded.mode, 'VIEWER_BUNDLE');
  assert.equal(
    calls.some(url => url.startsWith('/refs/evidence/')),
    false
  );

  const first = await loaded.loadEvidence(evidence.id);
  assert.deepEqual(first, evidence);
  assert.equal(calls.includes(ref), true);

  const countAfterFirst = calls.filter(url => url === ref).length;
  const second = await loaded.loadEvidence(evidence.id);
  assert.deepEqual(second, evidence);
  assert.equal(
    calls.filter(url => url === ref).length,
    countAfterFirst
  );
});

test('Viewer loader falls back to graph-only mode when canonical result is absent', async () => {
  const run = await execution();
  const calls = [];
  const fetchImpl = async url => {
    calls.push(String(url));
    if (String(url) === '/graph.json') {
      return {
        status: 200,
        ok: true,
        async json() {
          return structuredClone(run.state.graph);
        }
      };
    }
    return {
      status: 404,
      ok: false,
      async json() { return null; }
    };
  };

  const loaded = await loadViewerSources({ fetchImpl });
  assert.equal(loaded.mode, 'GRAPH_ONLY');
  assert.equal(loaded.result, null);
  assert.equal(
    loaded.graph.nodes.length,
    run.state.graph.nodes.length
  );
});

test('human overview keeps runtime Molang fidelity and coverage unknown states visible', async () => {
  const run = await execution();
  const model = createViewerModel({
    graph: run.state.graph,
    result: run.result
  });

  assert.equal(
    model.overview.coverage.completeness,
    run.result.coverage.completeness
  );
  assert.deepEqual(
    model.overview.unknowns,
    run.result.unknowns
  );
  assert.equal(model.overview.runtime_edges >= 0, true);
  assert.equal(model.overview.molang.total >= 0, true);

  if (run.result.unknowns.length) {
    assert.ok(model.overview.unknowns.length > 0);
  }
});


test('Viewer bundle writer rejects paths that escape the output root', async () => {
  const run = await execution();
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'kneekura-viewer-containment-')
  );
  try {
    for (const resultFile of [
      '../escape.json',
      '..\\escape.json',
      'C:\\outside\\escape.json'
    ]) {
      await assert.rejects(
        () => writeHumanViewerBundle({
          result: run.result,
          graph: run.state.graph,
          outDir: root,
          resultFile
        }),
        /must stay inside the Viewer bundle/
      );
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Viewer lazy Evidence loader rejects ref identity mismatch', async () => {
  const run = await execution();
  const bundle = createHumanViewerManifest(run.result);
  const evidence = run.result.evidence[0];
  assert.ok(evidence);

  const ref = '/' + bundle.manifest.evidence_index[evidence.id].ref;
  const wrong = structuredClone(evidence);
  wrong.id = 'evidence:wrong-id';

  const resources = new Map([
    ['/viewer-manifest.json', bundle.manifest],
    ['/analysis-result.json', bundle.result],
    ['/graph.json', run.state.graph],
    [ref, wrong]
  ]);

  const fetchImpl = async url => {
    const value = resources.get(String(url));
    if (value == null) {
      return {
        status: 404,
        ok: false,
        async json() { return null; }
      };
    }
    return {
      status: 200,
      ok: true,
      async json() { return structuredClone(value); }
    };
  };

  const loaded = await loadViewerSources({ fetchImpl });
  await assert.rejects(
    () => loaded.loadEvidence(evidence.id),
    /evidence ref identity mismatch/
  );
});

test('viewer-bundle CLI writes a loadable lazy bundle', async () => {
  const run = await execution();
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'kneekura-viewer-cli-')
  );
  try {
    const resultFile = path.join(root, 'result.json');
    const graphFile = path.join(root, 'graph-input.json');
    const outDir = path.join(root, 'bundle');
    await fs.writeFile(
      resultFile,
      JSON.stringify(run.result, null, 2),
      'utf8'
    );
    await fs.writeFile(
      graphFile,
      JSON.stringify(run.state.graph, null, 2),
      'utf8'
    );

    const { stdout } = await execFile(
      process.execPath,
      [
        path.join(ROOT, 'src/cli.mjs'),
        'viewer-bundle',
        '--result',
        resultFile,
        '--graph',
        graphFile,
        '--out',
        outDir
      ],
      { cwd: ROOT }
    );

    assert.equal(stdout.includes('KNEEKURA viewer bundle:'), true);

    const manifest = JSON.parse(
      await fs.readFile(
        path.join(outDir, 'viewer-manifest.json'),
        'utf8'
      )
    );
    const result = JSON.parse(
      await fs.readFile(
        path.join(outDir, 'analysis-result.json'),
        'utf8'
      )
    );
    assert.equal(
      manifest.schema,
      'core.human-viewer-manifest/v1'
    );
    validateAnalysisResultV1(result);
    assert.equal(Object.hasOwn(result, 'evidence'), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});


test('human responsibility prose never becomes AI renderer context', async () => {
  const run = await execution();
  const graph = structuredClone(run.state.graph);
  const affected = run.result.affected_symbols.find(symbol =>
    graph.nodes.some(node => node.id === symbol.node_id)
  );
  assert.ok(affected);

  const node = graph.nodes.find(item => item.id === affected.node_id);
  node.summary = 'HUMAN_ONLY_RESPONSIBILITY_MARKER';

  const human = createViewerModel({
    graph,
    result: run.result
  });
  const panel = human.node(node.id);
  assert.equal(
    panel.responsibility.text,
    'HUMAN_ONLY_RESPONSIBILITY_MARKER'
  );

  const ai = renderAnalysisForAI(run.result, {
    profile: 'forensic'
  });
  assert.equal(
    ai.includes('HUMAN_ONLY_RESPONSIBILITY_MARKER'),
    false
  );
});

test('Human Viewer source preserves KNEEKURA filters fidelity and raw evidence access', async () => {
  const [html, js] = await Promise.all([
    fs.readFile(path.join(ROOT, 'viewer/index.html'), 'utf8'),
    fs.readFile(path.join(ROOT, 'viewer/viewer.js'), 'utf8')
  ]);

  for (const id of [
    'id="q"',
    'id="kind"',
    'id="edgeType"',
    'id="boundaryOnly"',
    'id="runtimeOnly"'
  ]) {
    assert.equal(html.includes(id), true);
  }

  for (const marker of [
    'Forge network runtime',
    'Molang transport',
    'YSM fidelity',
    'Raw node data',
    'edge evidence'
  ]) {
    assert.equal(js.includes(marker), true);
  }

  assert.equal(js.includes('Math.random'), false);
});


test('focused fallback adds exactly one graph hop and does not cascade', () => {
  const graph = {
    meta: {},
    nodes: [
      { id: 'a', kind: 'class', key: 'A', label: 'A' },
      { id: 'b', kind: 'class', key: 'B', label: 'B' },
      { id: 'c', kind: 'class', key: 'C', label: 'C' },
      { id: 'd', kind: 'class', key: 'D', label: 'D' }
    ],
    edges: [
      { id: 'ab', from: 'a', to: 'b', type: 'CALLS' },
      { id: 'bc', from: 'b', to: 'c', type: 'CALLS' },
      { id: 'cd', from: 'c', to: 'd', type: 'CALLS' }
    ]
  };
  const result = {
    schema: 'core.analysis-result/v1',
    affected_symbols: [{ node_id: 'a' }],
    graph_paths: [],
    claims: [],
    coverage: { entries: [] }
  };

  const projection = projectGraph(graph, result, {
    focused: true
  });
  assert.deepEqual(
    projection.nodes.map(node => node.id).sort(),
    ['a', 'b']
  );
  assert.deepEqual(
    projection.edges.map(edge => edge.id),
    ['ab']
  );
});


test('Viewer lazy loader refuses external or escaping manifest refs', async () => {
  const run = await execution();
  const bundle = createHumanViewerManifest(run.result);
  const evidence = run.result.evidence[0];
  assert.ok(evidence);

  const externalManifest = structuredClone(bundle.manifest);
  externalManifest.evidence_index[evidence.id].ref =
    'https://example.invalid/evidence.json';

  const baseResources = new Map([
    ['/viewer-manifest.json', externalManifest],
    ['/analysis-result.json', bundle.result],
    ['/graph.json', run.state.graph]
  ]);
  const fetchImpl = async url => {
    const value = baseResources.get(String(url));
    if (value == null) {
      return {
        status: 404,
        ok: false,
        async json() { return null; }
      };
    }
    return {
      status: 200,
      ok: true,
      async json() { return structuredClone(value); }
    };
  };

  const externalLoaded = await loadViewerSources({ fetchImpl });
  await assert.rejects(
    () => externalLoaded.loadEvidence(evidence.id),
    /external Viewer refs are forbidden/
  );

  const escapingManifest = structuredClone(bundle.manifest);
  escapingManifest.evidence_index[evidence.id].ref =
    '../outside/evidence.json';
  baseResources.set('/viewer-manifest.json', escapingManifest);

  const escapingLoaded = await loadViewerSources({ fetchImpl });
  await assert.rejects(
    () => escapingLoaded.loadEvidence(evidence.id),
    /may not escape its bundle/
  );
});


test('Viewer lazy Evidence loader requires canonical core.evidence/v1 schema', async () => {
  const run = await execution();
  const bundle = createHumanViewerManifest(run.result);
  const evidence = structuredClone(run.result.evidence[0]);
  assert.ok(evidence);

  const ref = '/' + bundle.manifest.evidence_index[evidence.id].ref;
  evidence.schema = 'fixture.evidence/v1';

  const resources = new Map([
    ['/viewer-manifest.json', bundle.manifest],
    ['/analysis-result.json', bundle.result],
    ['/graph.json', run.state.graph],
    [ref, evidence]
  ]);
  const fetchImpl = async url => {
    const value = resources.get(String(url));
    if (value == null) {
      return {
        status: 404,
        ok: false,
        async json() { return null; }
      };
    }
    return {
      status: 200,
      ok: true,
      async json() { return structuredClone(value); }
    };
  };

  const loaded = await loadViewerSources({ fetchImpl });
  await assert.rejects(
    () => loaded.loadEvidence(evidence.id),
    /must use core\.evidence\/v1/
  );
});


test('Viewer lazy loader rejects protocol-relative and encoded traversal refs', async () => {
  const run = await execution();
  const bundle = createHumanViewerManifest(run.result);
  const evidence = run.result.evidence[0];
  assert.ok(evidence);

  const resources = new Map([
    ['/analysis-result.json', bundle.result],
    ['/graph.json', run.state.graph]
  ]);
  const fetchImpl = async url => {
    const value = resources.get(String(url));
    if (value == null) {
      return {
        status: 404,
        ok: false,
        async json() { return null; }
      };
    }
    return {
      status: 200,
      ok: true,
      async json() { return structuredClone(value); }
    };
  };

  for (const ref of [
    '//example.invalid/evidence.json',
    'data:application/json,%7B%7D',
    '%2e%2e/outside/evidence.json',
    '..\\outside\\evidence.json'
  ]) {
    const manifest = structuredClone(bundle.manifest);
    manifest.evidence_index[evidence.id].ref = ref;
    resources.set('/viewer-manifest.json', manifest);

    const loaded = await loadViewerSources({ fetchImpl });
    await assert.rejects(
      () => loaded.loadEvidence(evidence.id),
      /external Viewer refs are forbidden|may not escape its bundle/
    );
  }
});


test('browser Viewer entry script passes JavaScript syntax check', async () => {
  await execFile(
    process.execPath,
    ['--check', path.join(ROOT, 'viewer/viewer.js')],
    { cwd: ROOT }
  );
});
