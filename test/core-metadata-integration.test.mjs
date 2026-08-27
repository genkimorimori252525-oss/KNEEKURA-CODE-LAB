import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanRepository } from '../src/core/scan.mjs';
import { mergeWorkspaceGraphs, scanWorkspace } from '../src/core/workspace.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('single-repository scan adds stable repository and WORKSPACE snapshot metadata without changing graph schema', async () => {
  const fixture = path.join(ROOT, 'fixtures/forge-mini');
  const first = await scanRepository(fixture);
  const second = await scanRepository(fixture);

  assert.equal(first.schema, 'kneekura.graph/v1');
  assert.equal(first.meta.repository?.schema, 'core.repository-identity/v1');
  assert.equal(first.meta.snapshot?.schema, 'core.snapshot-identity/v1');
  assert.equal(first.meta.snapshot?.kind, 'WORKSPACE');
  assert.ok(first.nodes.length > 0);
  assert.ok(first.edges.length > 0);
  assert.equal(first.meta.repository.repository_id, second.meta.repository.repository_id);
  assert.equal(first.meta.snapshot.snapshot_id, second.meta.snapshot.snapshot_id);
});

test('workspace scan preserves existing boundary metadata and adds per-repository plus MULTI_REPO identity metadata', async () => {
  const graph = await scanWorkspace([
    { name: 'tlm', root: path.join(ROOT, 'fixtures/workspace/tlm') },
    { name: 'ysm', root: path.join(ROOT, 'fixtures/workspace/ysm') }
  ]);

  assert.equal(graph.schema, 'kneekura.graph/v1');
  assert.deepEqual(graph.meta.workspace?.repositories, ['tlm', 'ysm']);
  assert.ok((graph.meta.workspace?.boundaryEdgeCount ?? 0) > 0);
  assert.ok(graph.edges.some(edge => edge.boundary));

  assert.equal(graph.meta.repositories?.length, 2);
  for (const entry of graph.meta.repositories) {
    assert.equal(entry.repository?.schema, 'core.repository-identity/v1');
    assert.equal(entry.snapshot?.schema, 'core.snapshot-identity/v1');
    assert.equal(entry.snapshot?.kind, 'WORKSPACE');
  }
  assert.equal(graph.meta.snapshot?.schema, 'core.snapshot-identity/v1');
  assert.equal(graph.meta.snapshot?.kind, 'MULTI_REPO');
});

test('workspace merge remains compatible with handcrafted graphs that do not carry identity metadata', () => {
  const graph = mergeWorkspaceGraphs([
    { name: 'left', graph: { root: '/left', nodes: [], edges: [], meta: { analyzers: [] } } },
    { name: 'right', graph: { root: '/right', nodes: [], edges: [], meta: { analyzers: [] } } }
  ]);

  assert.equal(graph.schema, 'kneekura.graph/v1');
  assert.deepEqual(graph.meta.workspace.repositories, ['left', 'right']);
  assert.deepEqual(graph.meta.repositories, [
    { name: 'left', repository: null, snapshot: null },
    { name: 'right', repository: null, snapshot: null }
  ]);
  assert.equal(Object.hasOwn(graph.meta, 'snapshot'), false);
});
