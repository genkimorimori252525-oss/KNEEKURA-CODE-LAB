import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyzeInternal } from '../src/core/api/analyze.mjs';
import {
  digestCanonicalAnalysisResult
} from '../src/viewer/bundle.mjs';
import {
  createExplorerProjection
} from '../src/presentation/explorer/project.mjs';
import {
  createExplorerNodeDetail,
  createExplorerUiModel,
  searchExplorerNodes
} from '../src/presentation/explorer/ui-model.mjs';
import {
  applyElkLayout,
  buildElkLayoutInput,
  layoutExplorerUiModel
} from '../src/presentation/explorer/layout.mjs';

const ROOT = path.dirname(
  path.dirname(fileURLToPath(import.meta.url))
);
const FORGE_FIXTURE = path.join(
  ROOT,
  'fixtures/forge-mini'
);
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

let executionPromise = null;

function execution() {
  executionPromise ??= analyzeInternal({
    schema: 'core.analysis-request/v1',
    repository: FORGE_FIXTURE,
    mode: 'RUNTIME',
    question:
      'P2 Explorer Shell acceptance fixture.',
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

async function projection() {
  const run = await execution();
  return {
    run,
    projection: createExplorerProjection({
      graph: run.state.graph,
      result: run.result
    })
  };
}

test('P2 UI model preserves canonical React Flow identities and edge semantics', async () => {
  const { projection: value } = await projection();
  const model = createExplorerUiModel(value);

  assert.deepEqual(
    model.nodes.map(node => node.id).sort(),
    value.presentation.nodes
      .map(node => node.node_id)
      .sort()
  );
  assert.deepEqual(
    model.edges.map(edge => edge.id).sort(),
    value.presentation.edges
      .map(edge => edge.edge_id)
      .sort()
  );

  const canonicalEdgeById = new Map(
    value.canonical.graph.edges.map(edge => [
      edge.id,
      edge
    ])
  );

  for (const edge of model.edges) {
    const canonical = canonicalEdgeById.get(edge.id);
    assert.ok(canonical);
    assert.equal(edge.source, canonical.from);
    assert.equal(edge.target, canonical.to);
    assert.equal(
      edge.data.canonical_type,
      canonical.type
    );
  }
});

test('P2 ELK input is deterministically sorted and layout changes geometry only', async () => {
  const { projection: value } = await projection();
  const model = createExplorerUiModel(value);
  const before = structuredClone(model);
  let captured = null;

  const elk = {
    async layout(input) {
      captured = structuredClone(input);
      return {
        ...structuredClone(input),
        children: input.children.map(
          (child, index) => ({
            ...child,
            x: index * 100,
            y: index * 40
          })
        )
      };
    }
  };

  const laidOut = await layoutExplorerUiModel(
    model,
    elk
  );

  assert.deepEqual(model, before);
  assert.deepEqual(
    captured.children.map(node => node.id),
    [...captured.children]
      .map(node => node.id)
      .sort()
  );
  assert.deepEqual(
    captured.edges.map(edge => edge.id),
    [...captured.edges]
      .map(edge => edge.id)
      .sort()
  );

  assert.deepEqual(
    laidOut.nodes.map(node => node.id),
    model.nodes.map(node => node.id)
  );
  assert.deepEqual(
    laidOut.edges,
    model.edges
  );
  assert.ok(
    laidOut.nodes.every(node =>
      Number.isFinite(node.position.x) &&
      Number.isFinite(node.position.y)
    )
  );
});

test('P2 rejects incomplete or foreign layout identities instead of repairing them', async () => {
  const { projection: value } = await projection();
  const model = createExplorerUiModel(value);
  const input = buildElkLayoutInput(model);

  assert.throws(
    () => applyElkLayout(model, {
      ...input,
      children: input.children.slice(1)
    }),
    /map every canonical UI node exactly once/
  );

  assert.throws(
    () => applyElkLayout(model, {
      ...input,
      children: [
        ...input.children.map(node => ({
          ...node,
          x: 0,
          y: 0
        })),
        {
          id: 'node:foreign',
          x: 1,
          y: 1
        }
      ]
    }),
    /map every canonical UI node exactly once/
  );

  assert.throws(
    () => applyElkLayout(model, {
      ...input,
      children: input.children.flatMap(
        (node, index) => index === 0
          ? [
              { ...node, x: 0, y: 0 },
              { ...node, x: 1, y: 1 }
            ]
          : [{ ...node, x: 0, y: 0 }]
      )
    }),
    /layout node IDs must be unique/
  );
});

test('P2 search keeps repository-controlled markup inert as plain text', async () => {
  const { projection: original } = await projection();
  const value = structuredClone(original);
  const target = value.presentation.nodes[0];

  target.label =
    '<img src=x onerror=alert(1)>';

  const model = createExplorerUiModel(value);
  const node = model.nodes.find(
    item => item.id === target.node_id
  );

  assert.equal(
    node.data.label,
    '<img src=x onerror=alert(1)>'
  );
  assert.deepEqual(
    searchExplorerNodes(model, 'onerror'),
    [target.node_id]
  );
});

test('P2 UI preparation and failed layout cannot mutate projection or canonical result', async () => {
  const { run, projection: value } =
    await projection();
  const projectionBefore = structuredClone(value);
  const resultBefore = structuredClone(run.result);
  const digestBefore =
    digestCanonicalAnalysisResult(run.result);

  const model = createExplorerUiModel(value);
  await assert.rejects(
    layoutExplorerUiModel(model, {
      async layout() {
        throw new Error('synthetic layout failure');
      }
    }),
    /synthetic layout failure/
  );

  assert.deepEqual(value, projectionBefore);
  assert.deepEqual(run.result, resultBefore);
  assert.equal(
    digestCanonicalAnalysisResult(run.result),
    digestBefore
  );
});

test('P2 node detail remains source-traceable generic Presentation data', async () => {
  const { projection: value } = await projection();
  const nodeId = value.presentation.nodes[0].node_id;
  const detail = createExplorerNodeDetail(
    value,
    nodeId
  );

  assert.equal(detail.node_id, nodeId);
  assert.equal(
    detail.canonical_node.id,
    nodeId
  );
  assert.equal(
    detail.canonical_node.kind,
    detail.canonical_kind
  );

  for (const relation of detail.relations) {
    const edge = value.canonical.graph.edges.find(
      item => item.id === relation.edge_id
    );
    assert.ok(edge);
    assert.equal(
      relation.canonical_type,
      edge.type
    );
  }
});

test('P2 React shell has no executable repository-text rendering escape hatch', async () => {
  const [app, main] = await Promise.all([
    fs.readFile(
      path.join(
        ROOT,
        'packages/human-explorer/src/App.jsx'
      ),
      'utf8'
    ),
    fs.readFile(
      path.join(
        ROOT,
        'packages/human-explorer/src/main.jsx'
      ),
      'utf8'
    )
  ]);
  const source = app + '\n' + main;

  for (const forbidden of [
    'dangerouslySetInnerHTML',
    '.innerHTML',
    'eval(',
    'new Function',
    'javascript:'
  ]) {
    assert.equal(
      source.includes(forbidden),
      false,
      'forbidden Explorer rendering path: ' +
      forbidden
    );
  }

  for (const required of [
    'ReactFlow',
    'MiniMap',
    'Controls',
    'fitView',
    'JSON.stringify'
  ]) {
    assert.equal(
      source.includes(required),
      true,
      'missing P2 shell capability: ' +
      required
    );
  }
});

test('P2 remains opt-in and Classic Viewer stays the default serve path', async () => {
  const [cli, pkgText] = await Promise.all([
    fs.readFile(
      path.join(ROOT, 'src/cli.mjs'),
      'utf8'
    ),
    fs.readFile(
      path.join(ROOT, 'package.json'),
      'utf8'
    )
  ]);
  const pkg = JSON.parse(pkgText);

  assert.match(
    cli,
    /cmd === 'serve-explorer'/
  );
  assert.match(
    cli,
    /cmd === 'explorer-projection'/
  );
  assert.match(
    cli,
    /cmd === 'serve'/
  );
  assert.match(
    cli,
    /path\.resolve\(here,'\.\.\/viewer'\)/
  );

  assert.equal(
    pkg.scripts.serve,
    'node src/cli.mjs serve'
  );
  assert.equal(
    pkg.dependencies['@xyflow/react'],
    '12.11.5'
  );
  assert.equal(
    pkg.dependencies.elkjs,
    '0.12.0'
  );
  assert.equal(
    pkg.dependencies.react,
    '19.2.8'
  );
  assert.equal(
    pkg.dependencies['react-dom'],
    '19.2.8'
  );
  assert.equal(
    pkg.devDependencies.vite,
    '8.2.2'
  );
});
