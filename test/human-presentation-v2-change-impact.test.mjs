import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CHANGE_IMPACT_MAX_ITEMS,
  createExplorerChangeImpact
} from '../src/presentation/explorer/impact.mjs';

const ROOT = path.dirname(
  path.dirname(fileURLToPath(import.meta.url))
);

function fixture() {
  const nodes = [
    node('node:changed','class','<script>changed</script>'),
    node('node:caller','class','Caller'),
    node('node:upstream','method','Upstream'),
    node('node:downstream','class','Downstream'),
    node('node:correlated','class','Correlated'),
    node('node:low','class','Low confidence')
  ];
  const edges = [
    edge('edge:caller','node:caller','node:changed','CALLS',1),
    edge('edge:upstream','node:upstream','node:caller','CALLS',1),
    edge('edge:out','node:changed','node:downstream','CALLS',1),
    edge('edge:corr','node:correlated','node:changed','CODEGRAPH_COCHANGE',1),
    edge('edge:low','node:low','node:changed','CALLS',0.5)
  ];
  const projection={
    schema:'kneekura.explorer-projection/v1',
    source:{analysis_id:'impact:test'},
    canonical:{
      graph:{
        schema:'kneekura.graph/v1',
        nodes,
        edges
      },
      result:{
        schema:'core.analysis-result/v1',
        status:'COMPLETE'
      }
    },
    presentation:{
      nodes:nodes.map((item,index)=>({
        node_id:item.id,
        canonical_index:index,
        canonical_kind:item.kind,
        display_family:'source',
        label:item.label
      })),
      edges:edges.map((item,index)=>({
        edge_id:item.id,
        canonical_index:index,
        from_node_id:item.from,
        to_node_id:item.to,
        canonical_type:item.type
      })),
      claims:[],
      coverage:[]
    }
  };
  const model={
    schema:'kneekura.explorer-ui-model/v1',
    projection_schema:'kneekura.explorer-projection/v1',
    source:structuredClone(projection.source),
    nodes:projection.presentation.nodes.map(item=>({
      id:item.node_id,
      canonical_index:item.canonical_index,
      position:{x:0,y:0},
      width:240,
      height:72,
      data:{
        label:item.label,
        canonical_kind:item.canonical_kind,
        display_family:item.display_family,
        canonical_node_id:item.node_id
      }
    })),
    edges:projection.presentation.edges.map(item=>({
      id:item.edge_id,
      canonical_index:item.canonical_index,
      source:item.from_node_id,
      target:item.to_node_id,
      data:{
        canonical_edge_id:item.edge_id,
        canonical_type:item.canonical_type
      }
    }))
  };
  return {projection,model};
}

function node(id,kind,label){
  return {id,kind,label,key:id};
}
function edge(id,from,to,type,confidence){
  return {id,from,to,type,confidence};
}

test('change impact delegates to CORE IMPACT reverse-only scope and preserves exact causal edges',()=>{
  const {projection,model}=fixture();
  const impact=createExplorerChangeImpact(
    projection,model,'node:changed',
    {maxDepth:2,maxItems:20}
  );

  assert.equal(impact.seed_node_id,'node:changed');
  assert.equal(
    impact.terminology,
    'CORE IMPACT investigation scope; not a verified breakage claim'
  );
  assert.deepEqual(
    impact.selected_node_ids,
    ['node:caller','node:changed','node:upstream']
  );
  assert.equal(
    impact.selected_node_ids.includes('node:downstream'),
    false
  );
  assert.equal(
    impact.selected_node_ids.includes('node:correlated'),
    false
  );
  assert.equal(
    impact.selected_node_ids.includes('node:low'),
    false
  );
  assert.deepEqual(
    impact.causal_edge_ids,
    ['edge:caller','edge:upstream']
  );
  const callerDecision=impact.decisions.find(
    item=>item.node_id==='node:caller' &&
      item.action==='EXPAND'
  );
  assert.deepEqual(callerDecision.causal_edge,{
    edge_id:'edge:caller',
    canonical_type:'CALLS',
    source:'node:caller',
    target:'node:changed'
  });
});

test('change impact exposes depth horizon as explicit UNEXPLORED boundary',()=>{
  const {projection,model}=fixture();
  const impact=createExplorerChangeImpact(
    projection,model,'node:changed',
    {maxDepth:1,maxItems:20}
  );
  assert.deepEqual(
    impact.selected_node_ids,
    ['node:caller','node:changed']
  );
  assert.deepEqual(
    impact.boundary_node_ids,
    ['node:upstream']
  );
  assert.equal(impact.boundary[0].status,'UNEXPLORED');
  assert.equal(
    impact.boundary[0].reason_code,
    'DEPTH_HORIZON'
  );
  const decision=impact.decisions.find(
    item=>item.node_id==='node:upstream'
  );
  assert.equal(decision.action,'EXCLUDE');
  assert.equal(decision.cause,'DEPTH_HORIZON');
  assert.equal(
    decision.causal_edge.edge_id,
    'edge:upstream'
  );
});

test('change impact exposes item-budget exhaustion rather than hiding omitted scope',()=>{
  const {projection,model}=fixture();
  const impact=createExplorerChangeImpact(
    projection,model,'node:changed',
    {maxDepth:3,maxItems:1}
  );
  assert.deepEqual(
    impact.selected_node_ids,
    ['node:changed']
  );
  assert.deepEqual(
    impact.boundary_node_ids,
    ['node:caller']
  );
  assert.equal(
    impact.boundary[0].reason_code,
    'BUDGET_EXHAUSTED'
  );
  assert.equal(
    impact.closure.budget_exhausted,
    true
  );
});

test('change impact is deterministic and non-mutating',()=>{
  const {projection,model}=fixture();
  const p=structuredClone(projection);
  const m=structuredClone(model);
  const first=createExplorerChangeImpact(
    projection,model,'node:changed',
    {maxDepth:2,maxItems:20}
  );
  const second=createExplorerChangeImpact(
    projection,model,'node:changed',
    {maxDepth:2,maxItems:20}
  );
  assert.deepEqual(first,second);
  assert.deepEqual(projection,p);
  assert.deepEqual(model,m);
  assert.match(
    first.planner_fingerprint,
    /^sha256:[a-f0-9]{64}$/
  );
});

test('change impact fails closed on Presentation edge trace drift',()=>{
  const {projection,model}=fixture();
  projection.presentation.edges[0].canonical_type=
    'INVENTED';
  assert.throws(
    ()=>createExplorerChangeImpact(
      projection,model,'node:changed',
      {maxDepth:2,maxItems:20}
    ),
    /causal edge UI trace mismatch/
  );
});

test('change impact fails closed on UI node identity drift',()=>{
  const {projection,model}=fixture();
  model.nodes.find(item=>item.id==='node:caller')
    .data.canonical_kind='method';
  assert.throws(
    ()=>createExplorerChangeImpact(
      projection,model,'node:changed',
      {maxDepth:2,maxItems:20}
    ),
    /scope node trace mismatch/
  );
});

test('change impact requires an exact existing canonical node seed and bounded options',()=>{
  const {projection,model}=fixture();
  assert.throws(
    ()=>createExplorerChangeImpact(
      projection,model,'node:missing'
    ),
    /seed node trace mismatch/
  );
  assert.throws(
    ()=>createExplorerChangeImpact(
      projection,model,'node:changed',
      {maxDepth:9}
    ),
    /maxDepth/
  );
  assert.throws(
    ()=>createExplorerChangeImpact(
      projection,model,'node:changed',
      {maxItems:1001}
    ),
    /maxItems/
  );
  assert.equal(CHANGE_IMPACT_MAX_ITEMS,200);
});

test('change impact UI uses investigation-scope language and keeps repository text inert',async()=>{
  const [app,css]=await Promise.all([
    fs.readFile(
      path.join(ROOT,'packages/human-explorer/src/App.jsx'),
      'utf8'
    ),
    fs.readFile(
      path.join(ROOT,'packages/human-explorer/src/styles.css'),
      'utf8'
    )
  ]);
  const source=app+'\n'+css;
  for(const required of [
    'ChangeImpactPanel',
    'CORE IMPACT investigation scope',
    'Analyze selected node',
    'Recompute from selected',
    'Exit impact',
    'explorer-node-impact-seed',
    'explorer-node-impact-scope',
    'explorer-node-impact-boundary',
    'explorer-edge-impact-causal'
  ]){
    assert.equal(
      source.includes(required),
      true,
      'missing change-impact UI: '+required
    );
  }
  for(const forbidden of [
    'dangerouslySetInnerHTML',
    '.innerHTML',
    'eval(',
    'new Function',
    'javascript:'
  ]){
    assert.equal(
      source.includes(forbidden),
      false,
      'forbidden impact rendering path: '+forbidden
    );
  }
});

test('change impact preserves CORE ScopeDecision order and viewport includes known boundaries',async()=>{
  const {projection,model}=fixture();
  const impact=createExplorerChangeImpact(
    projection,model,'node:changed',
    {maxDepth:2,maxItems:20}
  );
  assert.deepEqual(
    impact.decisions.map(item=>[
      item.action,
      item.node_id,
      item.depth
    ]),
    [
      ['INCLUDE','node:changed',0],
      ['EXPAND','node:caller',1],
      ['EXPAND','node:upstream',2]
    ]
  );

  const app=await fs.readFile(
    path.join(
      ROOT,
      'packages/human-explorer/src/App.jsx'
    ),
    'utf8'
  );
  assert.match(
    app,
    /\.\.\.impactModel\.selected_node_ids,[\s\S]*\.\.\.impactModel\.boundary_node_ids/
  );
});

test('change impact adapter uses CORE planner authority instead of a Presentation adjacency traversal',async()=>{
  const source=await fs.readFile(
    path.join(
      ROOT,
      'src/presentation/explorer/impact.mjs'
    ),
    'utf8'
  );
  assert.match(
    source,
    /planScope\([\s\S]*mode: 'IMPACT'/
  );
  assert.match(source,/isStrongSemanticEdge/);
  assert.equal(
    /function\s+adjacent\s*\(/.test(source),
    false
  );
  assert.equal(
    /CODEGRAPH_COCHANGE/.test(source),
    false
  );
});

test('change impact remains Presentation-only, CI-covered, Classic-default and later roadmap items stay separate',async()=>{
  const [pkgText,ci,road,cli,doc]=await Promise.all([
    fs.readFile(path.join(ROOT,'package.json'),'utf8'),
    fs.readFile(path.join(ROOT,'.github/workflows/ci.yml'),'utf8'),
    fs.readFile(path.join(ROOT,'ROADMAP.md'),'utf8'),
    fs.readFile(path.join(ROOT,'src/cli.mjs'),'utf8'),
    fs.readFile(path.join(ROOT,'docs/HUMAN_PRESENTATION_V2.md'),'utf8')
  ]);
  const pkg=JSON.parse(pkgText);
  assert.equal(
    pkg.scripts['test:presentation-change-impact'],
    'node --test test/human-presentation-v2-change-impact.test.mjs'
  );
  assert.match(ci,/npm run test:presentation-change-impact/);
  assert.equal(pkg.scripts.serve,'node src/cli.mjs serve');
  assert.match(cli,/cmd === 'serve'/);
  assert.match(road,/- \[x\] change impact view/);
  assert.match(road,/- \[x\] ask-graph adapter for AI agents/);
  assert.match(road,/- \[x\] confidence\/evidence inspector/);
  assert.match(doc,/Change Impact View Presentation contract/);
  assert.match(
    doc,
    /investigation scope, not a verified breakage claim/
  );
});
