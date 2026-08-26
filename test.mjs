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

test('Deep Mixin injector semantics survive multiline nested annotations', async()=>{
  const g=await scanRepository(path.join(ROOT,'fixtures/forge-mini'));
  const edge=g.edges.find(e=>e.type==='INJECTS_AT'&&e.injector==='Inject');
  assert(edge, 'expected an INJECTS_AT edge');
  assert.deepEqual(edge.mixinMethods,['tick','move']);
  assert.equal(edge.atValue,'INVOKE');
  assert.equal(edge.atTarget,'Lnet/minecraft/world/entity/Entity;setPos(DDD)V');
  assert.equal(edge.ordinal,1);
  assert.equal(edge.shift,'AFTER');
  assert.equal(edge.cancellable,true);
  assert(g.nodes.some(n=>n.kind==='symbol'&&n.key==='Entity'));
});

test('TLM Java producers join YSM Molang consumers and animation names', async()=>{
  const g=await scanRepository(path.join(ROOT,'fixtures/forge-mini'));
  const wuqi=g.nodes.find(n=>n.kind==='molang_variable'&&n.key==='variable.wuqi');
  const animTime=g.nodes.find(n=>n.kind==='molang_variable'&&n.key==='query.anim_time');
  assert(wuqi, 'v.wuqi and variable.wuqi must normalize to the same node');
  assert(animTime, 'q/query aliases should be materialized');
  assert(g.edges.some(e=>e.type==='WRITES_MOLANG'&&e.to===wuqi.id));
  assert(g.edges.some(e=>e.type==='READS_MOLANG'&&e.to===wuqi.id));

  const idle=g.nodes.find(n=>n.kind==='animation_name'&&n.key==='idle2');
  const bow=g.nodes.find(n=>n.kind==='animation_name'&&n.key==='use_offhand:bow');
  assert(idle&&bow);
  assert(g.edges.some(e=>e.type==='PLAYS_YSM_ANIMATION'&&e.to===idle.id));
  assert(g.edges.some(e=>e.type==='DISPATCHES_YSM_ANIMATION'&&e.to===bow.id));
  assert(g.edges.some(e=>e.type==='PROVIDES_ANIMATION_NAME'&&e.to===idle.id));
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
