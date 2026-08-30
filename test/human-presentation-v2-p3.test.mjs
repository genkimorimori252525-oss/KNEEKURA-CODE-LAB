import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createExplorerHierarchy,
  createExplorerScope,
  EXPLORER_ROOT_CONTAINER_ID,
  searchExplorerScopeNodes
} from '../src/presentation/explorer/hierarchy.mjs';

const ROOT = path.dirname(
  path.dirname(fileURLToPath(import.meta.url))
);

function sampleModel() {
  return {
    schema: 'kneekura.explorer-ui-model/v1',
    projection_schema:
      'kneekura.explorer-projection/v1',
    source: {
      analysis_id: 'analysis:p3'
    },
    nodes: [
      node('n:class','class','source','ExampleClass'),
      node(
        'n:method',
        'method',
        'source',
        '<img src=x onerror=alert(1)>'
      ),
      node(
        'n:packet',
        'packet_send',
        'network',
        'Packet send'
      ),
      node(
        'n:runtime',
        'runtime_event',
        'runtime',
        'Runtime event'
      ),
      node(
        'n:semantic',
        'molang_variable',
        'semantic',
        'Molang state'
      )
    ],
    edges: [
      edge('e:contains','n:class','n:method','contains'),
      edge('e:send','n:method','n:packet','sends'),
      edge('e:receive','n:packet','n:runtime','delivers'),
      edge('e:apply','n:runtime','n:semantic','applies')
    ]
  };
}

function node(id, canonicalKind, displayFamily, label) {
  return {
    id,
    canonical_index: 0,
    position: { x: 0, y: 0 },
    width: 240,
    height: 72,
    data: {
      label,
      canonical_kind: canonicalKind,
      display_family: displayFamily,
      canonical_node_id: id
    }
  };
}

function edge(id, source, target, canonicalType) {
  return {
    id,
    canonical_index: 0,
    source,
    target,
    data: {
      canonical_edge_id: id,
      canonical_type: canonicalType
    }
  };
}

test('P3 hierarchy is deterministic and uses Presentation-only containers', () => {
  const model = sampleModel();
  const hierarchy = createExplorerHierarchy(model);
  const reversed = {
    ...structuredClone(model),
    nodes: [...model.nodes].reverse(),
    edges: [...model.edges].reverse()
  };

  assert.deepEqual(
    createExplorerHierarchy(reversed),
    hierarchy
  );
  assert.deepEqual(
    hierarchy.layers.map(layer => layer.key),
    ['network', 'runtime', 'semantic', 'source']
  );

  const root = hierarchy.containers.find(
    item => item.id === EXPLORER_ROOT_CONTAINER_ID
  );
  assert.deepEqual(
    root.node_ids,
    model.nodes.map(item => item.id).sort()
  );

  const canonicalIds = new Set(
    model.nodes.map(item => item.id)
  );
  assert.equal(
    hierarchy.containers.some(item =>
      canonicalIds.has(item.id)
    ),
    false
  );
  assert.equal(
    hierarchy.node_membership.length,
    model.nodes.length
  );
});

test('P3 family drill-down hides boundary edges without synthesizing replacements', () => {
  const model = sampleModel();
  const before = structuredClone(model);
  const hierarchy = createExplorerHierarchy(model);
  const sourceLayer = hierarchy.layers.find(
    layer => layer.key === 'source'
  );
  const scope = createExplorerScope(
    model,
    hierarchy,
    {
      container_id: sourceLayer.container_id
    }
  );

  assert.deepEqual(
    scope.visible_node_ids,
    ['n:class', 'n:method']
  );
  assert.deepEqual(
    scope.visible_edge_ids,
    ['e:contains']
  );
  assert.deepEqual(
    scope.hidden_boundary_edge_ids,
    ['e:send']
  );
  assert.deepEqual(model, before);

  const sourceEdge = model.edges.find(
    item => item.id === scope.visible_edge_ids[0]
  );
  assert.equal(scope.edges[0].id, sourceEdge.id);
  assert.equal(scope.edges[0].source, sourceEdge.source);
  assert.equal(scope.edges[0].target, sourceEdge.target);
  assert.equal(
    scope.edges[0].data.canonical_type,
    sourceEdge.data.canonical_type
  );
});

test('P3 canonical-kind container gives root/layer/kind breadcrumbs', () => {
  const model = sampleModel();
  const hierarchy = createExplorerHierarchy(model);
  const sourceLayer = hierarchy.layers.find(
    layer => layer.key === 'source'
  );
  const kindContainer = hierarchy.containers.find(
    item =>
      item.parent_id === sourceLayer.container_id &&
      item.key === 'class'
  );
  const scope = createExplorerScope(
    model,
    hierarchy,
    {
      container_id: kindContainer.id
    }
  );

  assert.deepEqual(
    scope.breadcrumbs.map(item => item.label),
    ['All architecture', 'source', 'class']
  );
  assert.deepEqual(scope.visible_node_ids, ['n:class']);
  assert.deepEqual(scope.visible_edge_ids, []);
  assert.deepEqual(
    scope.hidden_boundary_edge_ids,
    ['e:contains']
  );
});

test('P3 layer filter is visibility-only over the root scope', () => {
  const model = sampleModel();
  const hierarchy = createExplorerHierarchy(model);
  const sourceLayer = hierarchy.layers.find(
    layer => layer.key === 'source'
  );
  const networkLayer = hierarchy.layers.find(
    layer => layer.key === 'network'
  );

  const scope = createExplorerScope(
    model,
    hierarchy,
    {
      enabled_layer_ids: [
        networkLayer.id,
        sourceLayer.id
      ]
    }
  );

  assert.deepEqual(
    scope.visible_node_ids,
    ['n:class', 'n:method', 'n:packet']
  );
  assert.deepEqual(
    scope.visible_edge_ids,
    ['e:contains', 'e:send']
  );
  assert.deepEqual(
    scope.hidden_boundary_edge_ids,
    ['e:receive']
  );
});

test('P3 scoped search keeps repository-controlled text inert', () => {
  const model = sampleModel();
  const hierarchy = createExplorerHierarchy(model);
  const sourceLayer = hierarchy.layers.find(
    layer => layer.key === 'source'
  );
  const scope = createExplorerScope(
    model,
    hierarchy,
    {
      container_id: sourceLayer.container_id
    }
  );

  assert.deepEqual(
    searchExplorerScopeNodes(scope, 'onerror'),
    ['n:method']
  );
  assert.equal(
    scope.nodes.find(
      item => item.id === 'n:method'
    ).data.label,
    '<img src=x onerror=alert(1)>'
  );
});

test('P3 scopes never replace canonical UI node or edge identities', () => {
  const model = sampleModel();
  const hierarchy = createExplorerHierarchy(model);

  for (const layer of hierarchy.layers) {
    const scope = createExplorerScope(
      model,
      hierarchy,
      {
        container_id: layer.container_id
      }
    );
    for (const nodeItem of scope.nodes) {
      assert.ok(
        model.nodes.some(
          item => item.id === nodeItem.id
        )
      );
    }
    for (const edgeItem of scope.edges) {
      const original = model.edges.find(
        item => item.id === edgeItem.id
      );
      assert.ok(original);
      assert.equal(edgeItem.source, original.source);
      assert.equal(edgeItem.target, original.target);
      assert.equal(
        edgeItem.data.canonical_type,
        original.data.canonical_type
      );
    }
  }
});

test('P3 React shell exposes hierarchy controls without executable text rendering', async () => {
  const app = await fs.readFile(
    path.join(
      ROOT,
      'packages/human-explorer/src/App.jsx'
    ),
    'utf8'
  );

  for (const required of [
    'createExplorerHierarchy',
    'createExplorerScope',
    'HierarchyPanel',
    'Layers',
    'Hierarchy',
    'explorer-breadcrumbs',
    'Boundary edges hidden'
  ]) {
    assert.equal(
      app.includes(required),
      true,
      'missing P3 UI capability: ' + required
    );
  }

  for (const forbidden of [
    'dangerouslySetInnerHTML',
    '.innerHTML',
    'eval(',
    'new Function',
    'javascript:'
  ]) {
    assert.equal(
      app.includes(forbidden),
      false,
      'forbidden P3 rendering path: ' + forbidden
    );
  }
});

test('P3 remains opt-in, tested in CI, and keeps P4 semantic specialization deferred', async () => {
  const [pkgText, ci, cli, doc] = await Promise.all([
    fs.readFile(
      path.join(ROOT, 'package.json'),
      'utf8'
    ),
    fs.readFile(
      path.join(ROOT, '.github/workflows/ci.yml'),
      'utf8'
    ),
    fs.readFile(
      path.join(ROOT, 'src/cli.mjs'),
      'utf8'
    ),
    fs.readFile(
      path.join(ROOT, 'docs/HUMAN_PRESENTATION_V2.md'),
      'utf8'
    )
  ]);
  const pkg = JSON.parse(pkgText);

  assert.equal(
    pkg.scripts['test:presentation-p3'],
    'node --test test/human-presentation-v2-p3.test.mjs'
  );
  assert.match(ci, /npm run test:presentation-p3/);
  assert.equal(
    pkg.scripts.serve,
    'node src/cli.mjs serve'
  );
  assert.match(cli, /cmd === 'serve'/);
  assert.match(
    doc,
    /P3 — Architecture Layers, Containers, Drill-down contract/
  );
  assert.match(
    doc,
    /P4 KNEEKURA-specific semantic visualization remains deferred/
  );
});
