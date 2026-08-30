import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createExplorerGuidedTour,
  createGuidedTourPlayback,
  exitGuidedTour,
  guidedTourCurrentStep,
  moveGuidedTour,
  startGuidedTour
} from '../src/presentation/explorer/tour.mjs';

const ROOT = path.dirname(
  path.dirname(fileURLToPath(import.meta.url))
);

function fixture() {
  const nodes = [
    node('node:a', 'class', { label: 'A' }),
    node('node:b', 'method', { label: 'B' }),
    node('node:c', 'method', { label: 'C' }),
    node('tour:z', 'ua:tour_step', {
      label: '<img src=x onerror=alert(1)>',
      order: 1,
      description: '<script>alert(1)</script>',
      languageLesson: 'Treat repository text as data.'
    }),
    node('tour:a', 'ua:tour_step', {
      label: 'Same order, stable ID tie-break',
      order: 1
    }),
    node('tour:last', 'ua:tour_step', {
      label: 'Unnumbered',
      order: '2'
    })
  ];
  const edges = [
    edge(
      'edge:z-a',
      'tour:z',
      'node:a',
      'UA_TOUR_HIGHLIGHTS'
    ),
    edge(
      'edge:z-b',
      'tour:z',
      'node:b',
      'UA_TOUR_HIGHLIGHTS'
    ),
    edge(
      'edge:a-c',
      'tour:a',
      'node:c',
      'UA_TOUR_HIGHLIGHTS'
    )
  ];

  const projection = {
    schema: 'kneekura.explorer-projection/v1',
    source: { analysis_id: 'guided:test' },
    canonical: {
      graph: {
        schema: 'kneekura.graph/v1',
        nodes,
        edges
      },
      result: {
        schema: 'core.analysis-result/v1',
        status: 'COMPLETE'
      }
    },
    presentation: {
      nodes: nodes.map((item, index) => ({
        node_id: item.id,
        canonical_index: index,
        canonical_kind: item.kind,
        display_family: 'canonical',
        label: item.label ?? item.id
      })),
      edges: edges.map((item, index) => ({
        edge_id: item.id,
        canonical_index: index,
        from_node_id: item.from,
        to_node_id: item.to,
        canonical_type: item.type
      })),
      claims: [],
      coverage: []
    }
  };

  const model = {
    schema: 'kneekura.explorer-ui-model/v1',
    projection_schema:
      'kneekura.explorer-projection/v1',
    source: structuredClone(projection.source),
    nodes: projection.presentation.nodes.map(item => ({
      id: item.node_id,
      canonical_index: item.canonical_index,
      position: { x: 0, y: 0 },
      width: 240,
      height: 72,
      data: {
        label: item.label,
        canonical_kind: item.canonical_kind,
        display_family: item.display_family,
        canonical_node_id: item.node_id
      }
    })),
    edges: projection.presentation.edges.map(item => ({
      id: item.edge_id,
      canonical_index: item.canonical_index,
      source: item.from_node_id,
      target: item.to_node_id,
      data: {
        canonical_edge_id: item.edge_id,
        canonical_type: item.canonical_type
      }
    }))
  };
  return { projection, model };
}

function node(id, kind, extra = {}) {
  return { id, kind, ...extra };
}

function edge(id, from, to, type) {
  return { id, from, to, type };
}

test('guided tours use canonical order with stable ID tie-break and preserve multi-node highlights', () => {
  const { projection, model } = fixture();
  const tour=createExplorerGuidedTour(projection,model);

  assert.equal(tour.has_tour,true);
  assert.equal(tour.step_count,3);
  assert.deepEqual(
    tour.steps.map(item => item.step_node_id),
    ['tour:a','tour:z','tour:last']
  );
  const z=tour.steps.find(item=>item.step_node_id==='tour:z');
  assert.deepEqual(z.highlight_node_ids,['node:a','node:b']);
  assert.deepEqual(z.highlight_edge_ids,['edge:z-a','edge:z-b']);
  assert.equal(z.focus_node_id,'node:a');
  assert.equal(z.description,'<script>alert(1)</script>');
  assert.equal(z.language_lesson,'Treat repository text as data.');
  assert.equal(tour.steps[2].order,null);
});

test('guided tour playback is bounded, non-wrapping, and exits cleanly', () => {
  const { projection, model } = fixture();
  const tour=createExplorerGuidedTour(projection,model);
  let playback=startGuidedTour(tour);

  assert.deepEqual(playback,{
    active:true,index:0,step_node_id:'tour:a'
  });
  playback=moveGuidedTour(tour,playback,-1);
  assert.equal(playback.index,0);
  playback=moveGuidedTour(tour,playback,1);
  assert.equal(playback.index,1);
  playback=moveGuidedTour(tour,playback,1);
  playback=moveGuidedTour(tour,playback,1);
  assert.equal(playback.index,2);
  assert.equal(
    guidedTourCurrentStep(tour,playback).step_node_id,
    'tour:last'
  );
  assert.deepEqual(exitGuidedTour(tour),{
    active:false,index:null,step_node_id:null
  });
});

test('empty canonical tour is a valid no-op state', () => {
  const { projection, model } = fixture();
  projection.canonical.graph.nodes=
    projection.canonical.graph.nodes.filter(
      item=>item.kind!=='ua:tour_step'
    );
  projection.canonical.graph.edges=[];
  projection.presentation.nodes=
    projection.presentation.nodes.filter(
      item=>item.canonical_kind!=='ua:tour_step'
    );
  projection.presentation.edges=[];
  model.nodes=model.nodes.filter(
    item=>item.data.canonical_kind!=='ua:tour_step'
  );
  model.edges=[];

  const tour=createExplorerGuidedTour(projection,model);
  assert.equal(tour.has_tour,false);
  assert.equal(tour.step_count,0);
  assert.deepEqual(startGuidedTour(tour),{
    active:false,index:null,step_node_id:null
  });
});

test('guided tour derivation is deterministic and non-mutating', () => {
  const { projection, model } = fixture();
  const beforeProjection=structuredClone(projection);
  const beforeModel=structuredClone(model);
  const first=createExplorerGuidedTour(projection,model);
  const second=createExplorerGuidedTour(projection,model);
  assert.deepEqual(first,second);
  assert.deepEqual(projection,beforeProjection);
  assert.deepEqual(model,beforeModel);
});

test('guided tours fail closed on foreign highlight targets and edge trace drift', () => {
  const { projection, model } = fixture();

  const foreign=structuredClone(projection);
  foreign.canonical.graph.edges[0].to='node:missing';
  assert.throws(
    ()=>createExplorerGuidedTour(foreign,model),
    /highlight target is foreign/
  );

  const drift=structuredClone(projection);
  drift.presentation.edges[0].canonical_type='INVENTED';
  assert.throws(
    ()=>createExplorerGuidedTour(drift,model),
    /highlight edge trace mismatch/
  );
});

test('guided tours reject duplicate highlight targets instead of inventing repair semantics', () => {
  const { projection, model } = fixture();
  const duplicate=edge(
    'edge:z-a-duplicate',
    'tour:z',
    'node:a',
    'UA_TOUR_HIGHLIGHTS'
  );
  projection.canonical.graph.edges.push(duplicate);
  projection.presentation.edges.push({
    edge_id:duplicate.id,
    canonical_index:projection.presentation.edges.length,
    from_node_id:duplicate.from,
    to_node_id:duplicate.to,
    canonical_type:duplicate.type
  });
  model.edges.push({
    id:duplicate.id,
    canonical_index:model.edges.length,
    source:duplicate.from,
    target:duplicate.to,
    data:{
      canonical_edge_id:duplicate.id,
      canonical_type:duplicate.type
    }
  });
  assert.throws(
    ()=>createExplorerGuidedTour(projection,model),
    /highlight target is duplicated/
  );
});

test('guided tours reject UA_TOUR_HIGHLIGHTS from non-tour canonical sources', () => {
  const { projection, model } = fixture();
  const bad=edge(
    'edge:bad',
    'node:a',
    'node:b',
    'UA_TOUR_HIGHLIGHTS'
  );
  projection.canonical.graph.edges.push(bad);
  projection.presentation.edges.push({
    edge_id:bad.id,
    canonical_index:projection.presentation.edges.length,
    from_node_id:bad.from,
    to_node_id:bad.to,
    canonical_type:bad.type
  });
  model.edges.push({
    id:bad.id,
    canonical_index:model.edges.length,
    source:bad.from,
    target:bad.to,
    data:{
      canonical_edge_id:bad.id,
      canonical_type:bad.type
    }
  });
  assert.throws(
    ()=>createExplorerGuidedTour(projection,model),
    /highlight source is not a tour step/
  );
});

test('guided tour React declarations precede consumers and focus waits for layout', async () => {
  const app=await fs.readFile(
    path.join(
      ROOT,
      'packages/human-explorer/src/App.jsx'
    ),
    'utf8'
  );
  const highlightDeclaration=
    app.indexOf('const tourHighlightSet');
  const visibleNodesDeclaration=
    app.indexOf('const visibleNodes');
  assert.equal(highlightDeclaration >= 0,true);
  assert.equal(visibleNodesDeclaration >= 0,true);
  assert.equal(
    highlightDeclaration < visibleNodesDeclaration,
    true,
    'tourHighlightSet must be initialized before visibleNodes render consumes it'
  );
  assert.match(
    app,
    /!layout[\s\S]*!tourPlayback\.active/
  );
  assert.match(
    app,
    /layout\.nodes\.map\(node => node\.id\)/
  );
});

test('guided tour UI keeps repository text inert and uses only fixed Presentation classes', async () => {
  const [app,css]=await Promise.all([
    fs.readFile(path.join(ROOT,'packages/human-explorer/src/App.jsx'),'utf8'),
    fs.readFile(path.join(ROOT,'packages/human-explorer/src/styles.css'),'utf8')
  ]);
  const source=app+'\n'+css;
  for(const required of [
    'GuidedTourPanel',
    'Start tour',
    'Previous',
    'Next',
    'Exit',
    'explorer-node-tour-highlight'
  ]){
    assert.equal(source.includes(required),true,'missing guided-tour UI: '+required);
  }
  for(const forbidden of [
    'dangerouslySetInnerHTML',
    '.innerHTML',
    'eval(',
    'new Function',
    'javascript:'
  ]){
    assert.equal(source.includes(forbidden),false,'forbidden guided-tour rendering path: '+forbidden);
  }
});

test('guided tours remain Presentation-only, CI-covered, Classic-default, and later roadmap work stays separate', async () => {
  const [pkgText,ci,cli,road,doc]=await Promise.all([
    fs.readFile(path.join(ROOT,'package.json'),'utf8'),
    fs.readFile(path.join(ROOT,'.github/workflows/ci.yml'),'utf8'),
    fs.readFile(path.join(ROOT,'src/cli.mjs'),'utf8'),
    fs.readFile(path.join(ROOT,'ROADMAP.md'),'utf8'),
    fs.readFile(path.join(ROOT,'docs/HUMAN_PRESENTATION_V2.md'),'utf8')
  ]);
  const pkg=JSON.parse(pkgText);
  assert.equal(
    pkg.scripts['test:presentation-guided-tour'],
    'node --test test/human-presentation-v2-guided-tour.test.mjs'
  );
  assert.match(ci,/npm run test:presentation-guided-tour/);
  assert.equal(pkg.scripts.serve,'node src/cli.mjs serve');
  assert.match(cli,/cmd === 'serve'/);
  assert.match(road,/- \[x\] guided tours/);
  assert.match(road,/- \[x\] change impact view/);
  assert.match(road,/- \[ \] ask-graph adapter for AI agents/);
  assert.match(road,/- \[ \] confidence\/evidence inspector/);
  assert.match(doc,/Guided Tours Presentation contract/);
  assert.match(doc,/Tour text is repository-controlled inert data/);
});

test('invalid playback indices and deltas fail closed', () => {
  const { projection, model } = fixture();
  const tour=createExplorerGuidedTour(projection,model);
  assert.throws(
    ()=>createGuidedTourPlayback(tour,99),
    /out of range/
  );
  assert.throws(
    ()=>moveGuidedTour(tour,startGuidedTour(tour),2),
    /must be -1 or 1/
  );
});
