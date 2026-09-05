import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  analyzeInternal
} from '../src/core/api/analyze.mjs';
import {
  createExplorerProjection
} from '../src/presentation/explorer/project.mjs';
import {
  createExplorerConfidenceEvidenceInspector,
  INSPECTOR_EVIDENCE_INLINE,
  INSPECTOR_EVIDENCE_UNAVAILABLE_INLINE
} from '../src/presentation/explorer/inspector.mjs';

const ROOT = path.dirname(
  path.dirname(fileURLToPath(import.meta.url))
);
const FORGE_FIXTURE = path.join(
  ROOT,
  'fixtures/forge-mini'
);

let fixturePromise;

async function fixture() {
  if (!fixturePromise) {
    fixturePromise = buildFixture();
  }
  return structuredClone(await fixturePromise);
}

async function buildFixture() {
  const execution = await analyzeInternal({
    schema: 'core.analysis-request/v1',
    repository: FORGE_FIXTURE,
    mode: 'TRACE',
    policy: 'balanced',
    question:
      'Build deterministic confidence/evidence inspector fixture.',
    scope: {
      paths: ['ReimuPacket.java']
    },
    budget: {
      scope_depth: 2
    },
    output_profile: 'compact'
  });

  const graph = structuredClone(
    execution.state.graph
  );
  const result = structuredClone(
    execution.result
  );

  const node = {
    id: 'node:inspector',
    kind: 'class',
    key: 'fixture.InspectorTarget',
    label:
      'Inspector <script>alert(1)</script>',
    path: 'src/InspectorTarget.java'
  };
  graph.nodes.push(node);

  const evidence = {
    schema: 'core.evidence/v1',
    id: 'evidence:inspector-inline',
    kind: 'SOURCE',
    observation: {
      text:
        '<img src=x onerror=alert(1)> Evidence is inert data'
    },
    provenance: {
      repository_id:
        result.repository.repository_id,
      snapshot_id:
        result.snapshot.snapshot_id,
      provider_id: 'inspector-fixture',
      provider_version: 'v1',
      path: 'src/InspectorTarget.java',
      extraction_method: 'fixture'
    },
    integrity_digest:
      'sha256:' + '4'.repeat(64),
    trust_class: 'repository',
    provider_id: 'inspector-fixture',
    provider_version: 'v1'
  };
  result.evidence = [
    ...(result.evidence ?? []),
    evidence
  ];
  result.evidence_refs = [
    ...(result.evidence_refs ?? []),
    evidence.id
  ];
  result.counterevidence_refs = [
    ...(result.counterevidence_refs ?? []),
    evidence.id
  ];

  const coverage = {
    id: 'coverage:inspector',
    node_id: node.id,
    role: 'PRIMARY',
    status: 'ANALYZED'
  };
  result.coverage.entries.push(coverage);

  const claim = {
    schema: 'core.claim/v1',
    id: 'claim:inspector',
    type: 'HYPOTHESIS',
    status: 'UNRESOLVED',
    subject: {
      node_id: node.id
    },
    predicate:
      '<b>fixture.inspector</b>',
    object_or_value: {
      value:
        '<script>object remains data</script>'
    },
    evidence_links: [{
      evidence_id: evidence.id,
      role: 'SUPPORT',
      strength: 'INDIRECT',
      rationale:
        '<b>support rationale remains inert</b>'
    }],
    counterevidence_links: [{
      evidence_id: evidence.id,
      role: 'CONTRADICT',
      strength: 'CORRELATED',
      rationale:
        '<script>counter rationale remains inert</script>'
    }],
    dependency_claim_ids: [],
    coverage_ref: coverage.id,
    provenance_refs: [
      'fixture:provenance'
    ],
    confidence: {
      level: 'LOW',
      rationale:
        '<img src=x onerror=alert(1)> canonical LOW only'
    },
    verifier_results: []
  };
  result.claims = [
    ...(result.claims ?? []),
    claim
  ];

  const projection = createExplorerProjection({
    graph,
    result
  });

  return {
    projection,
    node_id: node.id,
    claim_id: claim.id,
    evidence_id: evidence.id,
    coverage_id: coverage.id
  };
}

test('Inspector preserves exact canonical confidence Claim Coverage and source identity',async()=>{
  const fx=await fixture();
  const inspector=
    createExplorerConfidenceEvidenceInspector(
      fx.projection,
      fx.node_id
    );

  assert.equal(
    inspector.schema,
    'kneekura.explorer-confidence-evidence-inspector/v1'
  );
  assert.equal(inspector.node_id,fx.node_id);
  assert.equal(inspector.claims.length,1);

  const claim=inspector.claims[0];
  const canonical=fx.projection.canonical.result
    .claims.find(item=>item.id===fx.claim_id);

  assert.equal(claim.claim_id,fx.claim_id);
  assert.equal(claim.type,canonical.type);
  assert.equal(claim.status,canonical.status);
  assert.deepEqual(claim.subject,canonical.subject);
  assert.equal(claim.predicate,canonical.predicate);
  assert.deepEqual(
    claim.object_or_value,
    canonical.object_or_value
  );
  assert.deepEqual(claim.confidence,canonical.confidence);
  assert.deepEqual(
    claim.dependency_claim_ids,
    canonical.dependency_claim_ids
  );
  assert.deepEqual(
    claim.provenance_refs,
    canonical.provenance_refs
  );
  assert.deepEqual(
    claim.verifier_results,
    canonical.verifier_results
  );
  assert.equal(claim.coverage.id,fx.coverage_id);
  assert.equal(claim.coverage.status,'ANALYZED');
  assert.equal(claim.coverage.role,'PRIMARY');
  assert.equal(
    inspector.source.analysis_result_digest,
    fx.projection.source.analysis_result_digest
  );
});

test('Inspector keeps Evidence and Counterevidence separate and preserves exact link order and fields',async()=>{
  const fx=await fixture();
  const inspector=
    createExplorerConfidenceEvidenceInspector(
      fx.projection,
      fx.node_id
    );
  const claim=inspector.claims[0];

  assert.equal(claim.evidence_links.length,1);
  assert.equal(
    claim.counterevidence_links.length,
    1
  );
  assert.equal(
    claim.evidence_links[0].source_field,
    'evidence_links'
  );
  assert.equal(
    claim.counterevidence_links[0].source_field,
    'counterevidence_links'
  );
  assert.deepEqual(
    claim.evidence_links[0].link,
    fx.projection.canonical.result.claims
      .find(item=>item.id===fx.claim_id)
      .evidence_links[0]
  );
  assert.deepEqual(
    claim.counterevidence_links[0].link,
    fx.projection.canonical.result.claims
      .find(item=>item.id===fx.claim_id)
      .counterevidence_links[0]
  );
});

test('Inspector exposes exact inline Evidence provenance trust integrity provider and observation',async()=>{
  const fx=await fixture();
  const inspector=
    createExplorerConfidenceEvidenceInspector(
      fx.projection,
      fx.node_id
    );
  const item=inspector.claims[0].evidence_links[0];
  const canonical=fx.projection.canonical.result
    .evidence.find(x=>x.id===fx.evidence_id);

  assert.equal(
    item.record_status,
    INSPECTOR_EVIDENCE_INLINE
  );
  assert.deepEqual(item.evidence,canonical);
  assert.deepEqual(
    item.evidence.provenance,
    canonical.provenance
  );
  assert.equal(
    item.evidence.integrity_digest,
    canonical.integrity_digest
  );
  assert.equal(
    item.evidence.trust_class,
    canonical.trust_class
  );
  assert.equal(
    item.evidence.provider_id,
    canonical.provider_id
  );
  assert.equal(
    item.evidence.provider_version,
    canonical.provider_version
  );
  assert.deepEqual(
    item.evidence.observation,
    canonical.observation
  );
});

test('Inspector marks valid ref-only Evidence UNAVAILABLE_INLINE without inventing absence semantics',async()=>{
  const fx=await fixture();
  const graph=structuredClone(
    fx.projection.canonical.graph
  );
  const result=structuredClone(
    fx.projection.canonical.result
  );
  result.evidence=result.evidence.filter(
    item=>item.id!==fx.evidence_id
  );

  const rebuilt=createExplorerProjection({
    graph,
    result
  });
  const inspector=
    createExplorerConfidenceEvidenceInspector(
      rebuilt,
      fx.node_id
    );

  for(const item of [
    inspector.claims[0].evidence_links[0],
    inspector.claims[0].counterevidence_links[0]
  ]){
    assert.equal(
      item.record_status,
      INSPECTOR_EVIDENCE_UNAVAILABLE_INLINE
    );
    assert.equal(item.evidence,null);
    assert.equal(
      item.link.evidence_id,
      fx.evidence_id
    );
  }
  assert.equal(
    inspector.terminology.includes('no score'),
    true
  );
});

test('Inspector rejects unavailable Evidence linked through the wrong aggregate ref class',async()=>{
  const fx=await fixture();
  const graph=structuredClone(
    fx.projection.canonical.graph
  );
  const result=structuredClone(
    fx.projection.canonical.result
  );

  result.evidence=result.evidence.filter(
    item=>item.id!==fx.evidence_id
  );
  result.evidence_refs=(
    result.evidence_refs ?? []
  ).filter(item=>item!==fx.evidence_id);
  assert.equal(
    result.counterevidence_refs.includes(
      fx.evidence_id
    ),
    true
  );

  const rebuilt=createExplorerProjection({
    graph,
    result
  });
  assert.throws(
    ()=>createExplorerConfidenceEvidenceInspector(
      rebuilt,
      fx.node_id
    ),
    /evidence link ref mismatch/
  );
});

test('Inspector validates Evidence refs for non-selected Claims too',async()=>{
  const fx=await fixture();
  const graph=structuredClone(
    fx.projection.canonical.graph
  );
  const result=structuredClone(
    fx.projection.canonical.result
  );

  const otherNode={
    id:'node:inspector-other',
    kind:'class',
    key:'fixture.Other',
    label:'Other',
    path:'src/Other.java'
  };
  graph.nodes.push(otherNode);
  const otherCoverage={
    id:'coverage:inspector-other',
    node_id:otherNode.id,
    role:'PRIMARY',
    status:'ANALYZED'
  };
  result.coverage.entries.push(otherCoverage);
  result.claims.push({
    schema:'core.claim/v1',
    id:'claim:inspector-other',
    type:'HYPOTHESIS',
    status:'UNRESOLVED',
    subject:{node_id:otherNode.id},
    predicate:'fixture.other',
    object_or_value:null,
    evidence_links:[{
      evidence_id:'evidence:foreign-missing',
      role:'SUPPORT',
      strength:'INDIRECT'
    }],
    counterevidence_links:[],
    dependency_claim_ids:[],
    coverage_ref:otherCoverage.id,
    provenance_refs:[],
    confidence:{
      level:'LOW',
      rationale:'canonical categorical confidence'
    },
    verifier_results:[]
  });

  const rebuilt=createExplorerProjection({
    graph,
    result
  });
  assert.throws(
    ()=>createExplorerConfidenceEvidenceInspector(
      rebuilt,
      fx.node_id
    ),
    /evidence link ref mismatch/
  );
});

test('Inspector preserves canonical Claim order and never sorts or scores by confidence',async()=>{
  const fx=await fixture();
  const graph=structuredClone(
    fx.projection.canonical.graph
  );
  const result=structuredClone(
    fx.projection.canonical.result
  );
  const first=result.claims.find(
    item=>item.id===fx.claim_id
  );
  const second=structuredClone(first);
  second.id='claim:inspector-second';
  second.confidence={
    level:'HIGH',
    rationale:
      'HIGH remains categorical, not a rank'
  };
  second.evidence_links=[];
  second.counterevidence_links=[];
  result.claims.push(second);

  const rebuilt=createExplorerProjection({
    graph,
    result
  });
  const inspector=
    createExplorerConfidenceEvidenceInspector(
      rebuilt,
      fx.node_id
    );

  assert.deepEqual(
    inspector.claims.map(item=>item.claim_id),
    ['claim:inspector','claim:inspector-second']
  );
  assert.equal(
    'confidence_score' in inspector.claims[0],
    false
  );
  assert.equal(
    'evidence_score' in inspector.claims[0],
    false
  );
});

test('Inspector is deterministic non-mutating and source-digest pinned',async()=>{
  const fx=await fixture();
  const before=structuredClone(fx.projection);
  const first=
    createExplorerConfidenceEvidenceInspector(
      fx.projection,
      fx.node_id
    );
  const second=
    createExplorerConfidenceEvidenceInspector(
      fx.projection,
      fx.node_id
    );

  assert.deepEqual(first,second);
  assert.deepEqual(fx.projection,before);

  const tampered=structuredClone(fx.projection);
  tampered.source.analysis_result_digest=
    'sha256:'+'0'.repeat(64);
  assert.throws(
    ()=>createExplorerConfidenceEvidenceInspector(
      tampered,
      fx.node_id
    ),
    /source identity\/digest mismatch/
  );
});

test('Inspector fails closed on node Claim Coverage and duplicate Evidence identity drift',async()=>{
  const fx=await fixture();

  const nodeDrift=structuredClone(fx.projection);
  nodeDrift.presentation.nodes.find(item=>
    item.node_id===fx.node_id
  ).canonical_kind='invented';
  assert.throws(
    ()=>createExplorerConfidenceEvidenceInspector(
      nodeDrift,
      fx.node_id
    ),
    /node trace mismatch/
  );

  const claimDrift=structuredClone(fx.projection);
  claimDrift.presentation.claims.find(item=>
    item.claim_id===fx.claim_id
  ).status='VERIFIED';
  assert.throws(
    ()=>createExplorerConfidenceEvidenceInspector(
      claimDrift,
      fx.node_id
    ),
    /Claim trace mismatch/
  );

  const coverageDrift=structuredClone(fx.projection);
  coverageDrift.presentation.coverage.find(item=>
    item.coverage_id===fx.coverage_id
  ).node_id='node:invented';
  assert.throws(
    ()=>createExplorerConfidenceEvidenceInspector(
      coverageDrift,
      fx.node_id
    ),
    /Coverage trace mismatch/
  );

  const duplicateResult=structuredClone(
    fx.projection.canonical.result
  );
  duplicateResult.evidence.push(
    structuredClone(
      duplicateResult.evidence.find(
        item=>item.id===fx.evidence_id
      )
    )
  );
  const duplicateProjection=createExplorerProjection({
    graph:structuredClone(
      fx.projection.canonical.graph
    ),
    result:duplicateResult
  });
  assert.throws(
    ()=>createExplorerConfidenceEvidenceInspector(
      duplicateProjection,
      fx.node_id
    ),
    /Canonical Evidence IDs must be unique/
  );

  const duplicateNodeMeta=structuredClone(
    fx.projection
  );
  duplicateNodeMeta.presentation.nodes[1]=
    structuredClone(
      duplicateNodeMeta.presentation.nodes[0]
    );
  assert.throws(
    ()=>createExplorerConfidenceEvidenceInspector(
      duplicateNodeMeta,
      fx.node_id
    ),
    /Presentation node IDs must be unique|node trace/
  );
});

test('Explorer UI presents exact Confidence Evidence Counterevidence and unavailable state with hostile text inert',async()=>{
  const [app,css]=await Promise.all([
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
        'packages/human-explorer/src/styles.css'
      ),
      'utf8'
    )
  ]);
  const source=app+'\n'+css;

  for(const required of [
    '信頼度と根拠',
    '信頼度の理由',
    'title="根拠"',
    'title="反証"',
    '根拠本文はこの成果物へ直接同梱されていません',
    'explorer-confidence-inspector'
  ]){
    assert.equal(
      source.includes(required),
      true,
      'missing inspector UI: '+required
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
      'forbidden inspector rendering path: '+forbidden
    );
  }
});

test('Final inspector remains Presentation-only CI-covered Classic-default and closes Human Presentation roadmap',async()=>{
  const [pkgText,ci,road,cli,doc,src]=
    await Promise.all([
      fs.readFile(path.join(ROOT,'package.json'),'utf8'),
      fs.readFile(
        path.join(ROOT,'.github/workflows/ci.yml'),
        'utf8'
      ),
      fs.readFile(path.join(ROOT,'ROADMAP.md'),'utf8'),
      fs.readFile(path.join(ROOT,'src/cli.mjs'),'utf8'),
      fs.readFile(
        path.join(ROOT,'docs/HUMAN_PRESENTATION_V2.md'),
        'utf8'
      ),
      fs.readFile(
        path.join(
          ROOT,
          'src/presentation/explorer/inspector.mjs'
        ),
        'utf8'
      )
    ]);
  const pkg=JSON.parse(pkgText);

  assert.equal(
    pkg.scripts['test:presentation-confidence-evidence'],
    'node --test test/human-presentation-v2-confidence-evidence.test.mjs'
  );
  assert.match(
    ci,
    /npm run test:presentation-confidence-evidence/
  );
  assert.equal(
    pkg.scripts.serve,
    'node src/cli.mjs serve'
  );
  assert.match(cli,/cmd === 'serve'/);
  assert.match(
    road,
    /- \[x\] confidence\/evidence inspector/
  );
  assert.equal(
    /- \[ \] (guided tours|change impact view|ask-graph adapter for AI agents|confidence\/evidence inspector)/.test(road),
    false
  );
  assert.match(
    doc,
    /Confidence\/Evidence Inspector contract/
  );
  assert.match(
    doc,
    /UNAVAILABLE_INLINE/
  );
  assert.equal(
    /confidence_score|evidence_score|rankEvidence|sortByConfidence/.test(src),
    false
  );
  assert.equal(
    src.includes('src/core/'),
    false
  );
});