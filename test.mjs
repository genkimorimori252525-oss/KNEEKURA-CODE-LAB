import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanRepository } from './src/core/scan.mjs';
import { scanWorkspace } from './src/core/workspace.mjs';
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
  const handler=g.nodes.find(n=>n.id===edge.from);
  assert.equal(handler?.kind,'method');
  assert.equal(handler?.label,'kneekura$afterMove');
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

test('YSM pack, geometry hierarchy and animation bone channels form one resource graph', async()=>{
  const g=await scanRepository(path.join(ROOT,'fixtures/workspace/ysm'));

  const pack=g.nodes.find(n=>n.kind==='ysm_model_pack'&&n.label==='KNEEKURA YSM Fixture');
  const model=g.nodes.find(n=>n.kind==='model_definition'&&n.identifier==='geometry.kneekura_test');
  const root=g.nodes.find(n=>n.kind==='model_bone'&&n.bone==='Root');
  const arm=g.nodes.find(n=>n.kind==='model_bone'&&n.bone==='RightArm');
  const hand=g.nodes.find(n=>n.kind==='model_bone'&&n.bone==='RightHandLocator');
  const handName=g.nodes.find(n=>n.kind==='bone_name'&&n.key==='RightHandLocator');
  const idleDef=g.nodes.find(n=>n.kind==='animation_definition'&&n.animation==='idle2');

  assert(pack&&model&&root&&arm&&hand&&handName&&idleDef);
  assert.equal(model.textureWidth,64);
  assert.equal(model.visibleBoundsHeight,4);
  assert.equal(hand.cubeCount,1);
  assert.equal(hand.locatorCount,1);

  assert(g.edges.some(e=>e.type==='DECLARES_MODEL'&&e.to===model.id));
  assert(g.edges.some(e=>e.type==='HAS_BONE'&&e.from===model.id&&e.to===hand.id));
  assert(g.edges.some(e=>e.type==='BONE_CHILD_OF'&&e.from===arm.id&&e.to===root.id));
  assert(g.edges.some(e=>e.type==='BONE_CHILD_OF'&&e.from===hand.id&&e.to===arm.id));
  assert(g.edges.some(e=>e.type==='PROVIDES_BONE_NAME'&&e.from===hand.id&&e.to===handName.id));
  assert(g.edges.some(e=>e.type==='ANIMATES_BONE'&&e.from===idleDef.id&&e.to===handName.id));
  assert(g.edges.some(e=>e.type==='HAS_LOCATOR'&&e.from===hand.id));

  const mainFile=g.nodes.find(n=>n.kind==='file'&&n.key==='main.json');
  const animationFile=g.nodes.find(n=>n.kind==='file'&&n.key==='tlm.animation.json');
  const textureFile=g.nodes.find(n=>n.kind==='file'&&n.key==='textures/default.png');
  const soundDir=g.nodes.find(n=>n.kind==='resource_directory'&&n.key==='sounds');
  assert(mainFile&&animationFile&&textureFile&&soundDir);
  assert(g.edges.some(e=>e.type==='LOADS_MODEL_RESOURCE'&&e.from===pack.id&&e.to===mainFile.id));
  assert(g.edges.some(e=>e.type==='LOADS_ANIMATION_RESOURCE'&&e.from===pack.id&&e.to===animationFile.id));
  assert(g.edges.some(e=>e.type==='LOADS_TEXTURE_RESOURCE'&&e.from===pack.id&&e.to===textureFile.id));
  assert(g.edges.some(e=>e.type==='LOADS_SOUND_DIRECTORY'&&e.from===pack.id&&e.to===soundDir.id));
});

test('Workspace graph materializes TLM to YSM compatibility boundaries', async()=>{
  const g=await scanWorkspace([
    {name:'tlm',root:path.join(ROOT,'fixtures/workspace/tlm')},
    {name:'ysm',root:path.join(ROOT,'fixtures/workspace/ysm')}
  ]);
  const repos=g.nodes.filter(n=>n.kind==='repository').map(n=>n.key).sort();
  assert.deepEqual(repos,['tlm','ysm']);

  const wuqi=g.nodes.find(n=>n.kind==='molang_variable'&&n.key==='variable.wuqi');
  const idle=g.nodes.find(n=>n.kind==='animation_name'&&n.key==='idle2');
  const handName=g.nodes.find(n=>n.kind==='bone_name'&&n.key==='RightHandLocator');
  assert(wuqi?.crossRepository);
  assert(idle?.crossRepository);
  assert(handName);
  assert.deepEqual([...wuqi.repositories].sort(),['tlm','ysm']);
  assert.deepEqual([...idle.repositories].sort(),['tlm','ysm']);
  assert.deepEqual([...handName.repositories].sort(),['ysm']);

  const boundary=g.edges.filter(e=>e.boundary);
  const types=new Set(boundary.map(e=>e.type));
  assert(types.has('BOUNDARY_PRODUCES_MOLANG'));
  assert(types.has('BOUNDARY_CONSUMES_MOLANG'));
  assert(types.has('BOUNDARY_DISPATCHES_ANIMATION'));
  assert(types.has('BOUNDARY_PROVIDES_ANIMATION'));
  assert.equal(g.meta.workspace.boundaryEdgeCount,4);
  assert(g.meta.workspace.sharedKinds.includes('bone_name'));

  const tlmFile=g.nodes.find(n=>n.kind==='file'&&n.repository==='tlm');
  const ysmFile=g.nodes.find(n=>n.kind==='file'&&n.repository==='ysm');
  assert(tlmFile?.key.startsWith('tlm:'));
  assert(ysmFile?.key.startsWith('ysm:'));
});

test('KNEEKURA runtime trace overlays observed animation and Molang on static contracts', async()=>{
  const g=await scanRepository(path.join(ROOT,'fixtures/forge-mini'), {
    trace:path.join(ROOT,'fixtures/runtime/kneekura-trace.jsonl')
  });

  const runtime=g.nodes.find(n=>n.kind==='runtime'&&n.key==='kneekura:trace');
  assert(runtime);
  assert.equal(runtime.scenario,'ysm-compat');
  assert.equal(runtime.deltaMode,'row');
  assert.equal(runtime.keyframeTicks,100);
  assert.equal(runtime.endReason,'duration');
  assert.equal(runtime.endTicks,40);
  assert.equal(runtime.channelCounts.anim,4);

  const entity=g.nodes.find(n=>n.kind==='runtime_entity'&&n.runtimeId===314);
  assert(entity);
  assert.equal(entity.role,'reimu');
  assert.equal(entity.type,'touhou_little_maid:reimu');
  assert.equal(entity.goneReason,'removed');
  assert.equal(entity.lastObservedMainHand,'empty');
  assert.equal(entity.lastObservedOffHand,'sword');

  const idle=g.nodes.find(n=>n.kind==='animation_name'&&n.key==='idle2');
  const bow=g.nodes.find(n=>n.kind==='animation_name'&&n.key==='use_offhand:bow');
  const wuqi=g.nodes.find(n=>n.kind==='molang_variable'&&n.key==='variable.wuqi');
  const face=g.nodes.find(n=>n.kind==='molang_variable'&&n.key==='variable.roaming.zui');
  assert(idle?.runtimeObserved&&bow?.runtimeObserved&&wuqi?.runtimeObserved&&face?.runtimeObserved);

  const animEdge=g.edges.find(e=>e.type==='OBSERVED_RUNTIME_ANIMATION'&&e.from===entity.id&&e.to===idle.id);
  const pendEdge=g.edges.find(e=>e.type==='OBSERVED_RUNTIME_PENDING_ANIMATION'&&e.from===entity.id&&e.to===bow.id);
  const molangEdge=g.edges.find(e=>e.type==='OBSERVED_RUNTIME_MOLANG_SEND'&&e.from===entity.id&&e.to===wuqi.id);
  const faceEdge=g.edges.find(e=>e.type==='OBSERVED_RUNTIME_FACE_STATE'&&e.from===entity.id&&e.to===face.id);
  assert(animEdge&&pendEdge&&molangEdge&&faceEdge);
  assert.equal(animEdge.observationCount,2);
  assert.equal(animEdge.firstTick,1);
  assert.equal(animEdge.lastTick,3);
  assert.equal(animEdge.runtimeObservation,true);
  assert.equal(pendEdge.observationCount,1);
  assert.equal(molangEdge.observationCount,2);
  assert.equal(molangEdge.firstTick,1);
  assert.equal(molangEdge.lastTick,2);
  assert.equal(faceEdge.observationCount,1);

  assert(g.edges.some(e=>e.type==='PROVIDES_ANIMATION_NAME'&&e.to===idle.id));
  assert(g.edges.some(e=>e.type==='WRITES_MOLANG'&&e.to===wuqi.id));
  assert(g.edges.some(e=>e.type==='OBSERVED_RUNTIME_MOD'&&e.to===g.nodes.find(n=>n.kind==='mod'&&n.key==='yes_steve_model')?.id));
  assert(g.edges.some(e=>e.type==='RUNTIME_INSTANCE_OF'&&e.from===entity.id));

  // Explicit '-' sentinels and delta omissions must not become fake observations.
  assert.equal(g.edges.filter(e=>e.runtimeObservation&&e.to===idle.id&&e.type==='OBSERVED_RUNTIME_ANIMATION').length,1);
  assert(!g.nodes.some(n=>n.kind==='animation_name'&&n.key==='-'));
});

test('KNEEKURA pose companion proves matching client render vertices without inventing bone transforms', async()=>{
  const g=await scanRepository(path.join(ROOT,'fixtures/forge-mini'), {
    trace:path.join(ROOT,'fixtures/runtime/kneekura-trace.jsonl'),
    pose:path.join(ROOT,'fixtures/runtime/kneekura.pose.json')
  });

  const pose=g.nodes.find(n=>n.kind==='runtime_pose_capture');
  assert(pose, 'matching v2 pose companion should become render evidence');
  assert.equal(pose.identityTrust,'uuid');
  assert.equal(pose.poseVersion,2);
  assert.equal(pose.overlapTicks,4);
  assert.equal(pose.frameCount,2);
  assert.equal(pose.vertexCount,3);
  assert.equal(pose.slotCount,4);
  assert.equal(pose.recordedTicks,3);
  assert.equal(pose.unrecordedTicks,1);
  assert.equal(pose.referencedFrameCount,2);
  assert.equal(pose.expectedBinaryBytes,132);
  assert.equal(pose.actualBinaryBytes,132);
  assert.equal(pose.binaryValidation,'exact-size + sampled-finite-f32le');
  assert.equal(pose.binarySampledFloatCount,33);
  assert.equal(pose.renderGroupCount,2);
  assert.equal(pose.renderTextureCount,1);

  const entity=g.nodes.find(n=>n.kind==='runtime_entity'&&n.runtimeId===314);
  assert(entity);
  assert.equal(entity.uuid,'11111111-2222-3333-4444-555555555555');
  assert(g.edges.some(e=>e.type==='OBSERVED_RENDERED_POSE'&&e.from===entity.id&&e.to===pose.id&&e.runtimeObservation));
  assert(g.edges.some(e=>e.type==='OBSERVED_POSE_COMPANION'&&e.to===pose.id&&e.runtimeObservation));
  assert(!g.diagnostics.some(d=>d.message==='pose companion rejected'));
});

test('KNEEKURA pose companion UUID mismatch is a hard rejection', async()=>{
  const g=await scanRepository(path.join(ROOT,'fixtures/forge-mini'), {
    trace:path.join(ROOT,'fixtures/runtime/kneekura-trace.jsonl'),
    pose:path.join(ROOT,'fixtures/runtime/kneekura-mismatch.pose.json')
  });

  assert(!g.nodes.some(n=>n.kind==='runtime_pose_capture'));
  assert(!g.edges.some(e=>e.type==='OBSERVED_RENDERED_POSE'));
  const rejection=g.diagnostics.find(d=>d.message==='pose companion rejected');
  assert(rejection, 'mismatched UUID must be visible as a diagnostic');
  assert.match(rejection.reason,/UUID mismatch/);
  assert.equal(rejection.traceUuid,'11111111-2222-3333-4444-555555555555');
  assert.equal(rejection.poseUuid,'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
});

test('YSM fidelity matrix observes through client render when trace and pose evidence exist', async()=>{
  const g=await scanRepository(path.join(ROOT,'fixtures/forge-mini'), {
    trace:path.join(ROOT,'fixtures/runtime/kneekura-trace.jsonl'),
    pose:path.join(ROOT,'fixtures/runtime/kneekura.pose.json')
  });

  const matrix=g.nodes.find(n=>n.kind==='fidelity_matrix'&&n.key==='ysm-tlm-runtime');
  assert(matrix);
  assert.equal(matrix.totalStages,6);
  assert.equal(matrix.observedStageCount,5);
  assert.equal(matrix.observedThroughStage,'C4');
  assert.equal(matrix.firstUnobservedStage,'C5');
  assert.match(matrix.nextDiagnosticHint,/per-bone/i);
  assert.equal(matrix.absenceIsFailure,false);

  const stages=new Map(g.nodes.filter(n=>n.kind==='fidelity_capability').map(n=>[n.stage,n]));
  for (const id of ['C0','C1','C2','C3','C4']) assert.equal(stages.get(id)?.status,'observed',id);
  assert.equal(stages.get('C5')?.status,'unobserved');
  assert(stages.get('C4')?.evidenceKinds.includes('runtime_pose_capture'));
  assert(g.edges.some(e=>e.type==='SUPPORTED_BY'&&e.from===stages.get('C4').id&&e.fidelityEvidence));
});

test('YSM fidelity matrix stops at command evidence when pose is absent', async()=>{
  const g=await scanRepository(path.join(ROOT,'fixtures/forge-mini'), {
    trace:path.join(ROOT,'fixtures/runtime/kneekura-trace.jsonl')
  });

  const matrix=g.nodes.find(n=>n.kind==='fidelity_matrix'&&n.key==='ysm-tlm-runtime');
  assert(matrix);
  assert.equal(matrix.observedThroughStage,'C3');
  assert.equal(matrix.firstUnobservedStage,'C4');
  assert.match(matrix.nextDiagnosticHint,/pose|client|render/i);
  const c4=g.nodes.find(n=>n.kind==='fidelity_capability'&&n.stage==='C4');
  assert.equal(c4?.status,'unobserved');
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
