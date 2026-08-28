import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyzeInternal } from '../src/core/api/analyze.mjs';
import {
  createHumanViewerManifest,
  digestCanonicalAnalysisResult,
  writeHumanViewerBundle
} from '../src/viewer/bundle.mjs';
import { loadViewerSources } from '../viewer/loader.mjs';
import {
  auditCorePresentationBoundary
} from '../scripts/check-presentation-boundary.mjs';

const ROOT = path.dirname(
  path.dirname(fileURLToPath(import.meta.url))
);
const FORGE_FIXTURE = path.join(ROOT, 'fixtures/forge-mini');
const TRACE = path.join(
  ROOT,
  'fixtures/runtime/kneekura-trace.jsonl'
);
const SERVER_NET = path.join(
  ROOT,
  'fixtures/runtime/kneekura-server.net.jsonl'
);
const CLIENT_NET = path.join(
  ROOT,
  'fixtures/runtime/kneekura-client.net.jsonl'
);

let canonicalExecutionPromise = null;

function canonicalExecution() {
  canonicalExecutionPromise ??= analyzeInternal({
    schema: 'core.analysis-request/v1',
    repository: FORGE_FIXTURE,
    mode: 'RUNTIME',
    question:
      'P0 digest gate: trace ReimuPacket without changing canonical semantics.',
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
  return canonicalExecutionPromise;
}

test('P0 CORE has no Presentation or UI imports', async () => {
  const violations = await auditCorePresentationBoundary({
    root: ROOT
  });
  assert.deepEqual(violations, []);
});

test('P0 boundary guard rejects package and local Presentation imports', async t => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'kneekura-presentation-boundary-')
  );
  t.after(() =>
    fs.rm(root, { recursive: true, force: true })
  );

  const core = path.join(root, 'src', 'core');
  await fs.mkdir(core, { recursive: true });
  await fs.writeFile(
    path.join(core, 'bad.mjs'),
    [
      "import React from 'react';",
      "import { ReactFlow } from '@xyflow/react';",
      "import ELK from 'elkjs/lib/elk.bundled.js';",
      "import dagre from '@dagrejs/dagre';",
      "import { forceSimulation } from 'd3-force';",
      "import archify from 'archify';",
      "import '../viewer/model.mjs';",
      "require('..\\\\viewer\\\\windows.mjs');",
      "export { x } from '../../third_party/example/x.mjs';"
    ].join('\n') + '\n',
    'utf8'
  );

  const violations = await auditCorePresentationBoundary({
    root
  });
  const specifiers = new Set(
    violations.map(item => item.specifier)
  );

  for (const forbidden of [
    'react',
    '@xyflow/react',
    'elkjs/lib/elk.bundled.js',
    '@dagrejs/dagre',
    'd3-force',
    'archify',
    '../viewer/model.mjs',
    '..\\\\viewer\\\\windows.mjs',
    '../../third_party/example/x.mjs'
  ]) {
    assert.equal(
      specifiers.has(forbidden),
      true,
      'expected boundary violation for ' + forbidden
    );
  }
});


test('P0 canonical digest gate proves Viewer projection is non-mutating', async () => {
  const run = await canonicalExecution();
  const original = structuredClone(run.result);

  const before = digestCanonicalAnalysisResult(run.result);
  const topLevelReordered = Object.fromEntries(
    Object.entries(run.result).reverse()
  );
  assert.equal(
    digestCanonicalAnalysisResult(topLevelReordered),
    before,
    'object key order must not change the canonical digest'
  );

  const projected = createHumanViewerManifest(run.result);
  const after = digestCanonicalAnalysisResult(run.result);

  assert.equal(after, before);
  assert.equal(
    projected.manifest.source_result_digest,
    before
  );
  assert.deepEqual(run.result, original);

  assert.equal(
    Object.hasOwn(projected.result, 'evidence'),
    false,
    'Viewer bundle may externalize Evidence only from its clone'
  );
  assert.equal(
    Object.hasOwn(run.result, 'evidence'),
    true,
    'canonical AnalysisResult must retain its Evidence field'
  );
});


test('P0 Classic Viewer graph-only fallback remains available', async () => {
  const graph = {
    schema: 'kneekura.graph/v1',
    meta: {},
    nodes: [],
    edges: []
  };
  const requested = [];

  const source = await loadViewerSources({
    fetchImpl: async url => {
      requested.push(url);
      if (url === '/graph.json') {
        return jsonResponse(200, graph);
      }
      return jsonResponse(404, null);
    }
  });

  assert.equal(source.mode, 'GRAPH_ONLY');
  assert.deepEqual(source.graph, graph);
  assert.deepEqual(requested, [
    '/viewer-manifest.json',
    '/analysis-result.json',
    '/graph.json'
  ]);
});

test('P0 Presentation failure is isolated from canonical AnalysisResult', async t => {
  const run = await canonicalExecution();
  const original = structuredClone(run.result);
  const before = digestCanonicalAnalysisResult(run.result);
  const outDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'kneekura-presentation-failure-')
  );
  t.after(() =>
    fs.rm(outDir, { recursive: true, force: true })
  );

  await assert.rejects(
    writeHumanViewerBundle({
      result: run.result,
      graph: run.state.graph,
      outDir,
      resultFile: '../outside-analysis-result.json'
    }),
    /must stay inside the Viewer bundle/
  );

  assert.equal(
    digestCanonicalAnalysisResult(run.result),
    before
  );
  assert.deepEqual(run.result, original);
});

function jsonResponse(status, value) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() {
      return structuredClone(value);
    }
  };
}
