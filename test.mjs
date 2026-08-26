import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanRepository } from './src/core/scan.mjs';
const ROOT=path.dirname(fileURLToPath(import.meta.url));

test('Forge semantics are materialized in graph', async()=>{
  const g=await scanRepository(path.join(ROOT,'fixtures/forge-mini'));
  const types=new Set(g.edges.map(e=>e.type));
  assert(types.has('MOD_ENTRYPOINT'));
  assert(types.has('MIXES_INTO'));
  assert(types.has('SUBSCRIBES_EVENT'));
  assert(types.has('CREATES_DEFERRED_REGISTER'));
  assert(types.has('DEPENDS_MOD'));
  assert(types.has('OPTIONAL_MOD'));
  assert(g.nodes.some(n=>n.kind==='mod'&&n.key==='yes_steve_model'));
});

test('Graph IDs are stable for same repository contents', async()=>{
  const a=await scanRepository(path.join(ROOT,'fixtures/forge-mini'));
  const b=await scanRepository(path.join(ROOT,'fixtures/forge-mini'));
  assert.deepEqual(a.nodes.map(n=>n.id),b.nodes.map(n=>n.id));
});

test('Understand Anything graph imports nodes, edges, layers and tour', async()=>{
  const g=await scanRepository(path.join(ROOT,'fixtures/forge-mini'), {
    understand:path.join(ROOT,'fixtures/understand-anything')
  });
  const types=new Set(g.edges.map(e=>e.type));
  assert(g.nodes.some(n=>n.kind==='ua:class'&&n.label==='Main'));
  assert(g.nodes.some(n=>n.kind==='ua:layer'&&n.label==='Entry'));
  assert(g.nodes.some(n=>n.kind==='ua:tour_step'&&n.label==='Start here'));
  assert(types.has('UA_CONTAINS'));
  assert(types.has('UA_LAYER_CONTAINS'));
  assert(types.has('UA_TOUR_HIGHLIGHTS'));
});
