import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyzeInternal } from '../src/core/api/analyze.mjs';
import {
  digestCanonicalAnalysisResult
} from '../src/viewer/bundle.mjs';
import {
  createExplorerProjection,
  displayFamilyForKind,
  validateExplorerGraph
} from '../src/presentation/explorer/project.mjs';

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

let executionPromise = null;

function execution() {
  executionPromise ??= analyzeInternal({
    schema: 'core.analysis-request/v1',
    repository: FORGE_FIXTURE,
    mode: 'RUNTIME',
    question:
      'P1 Explorer Projection acceptance fixture.',
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

test('P1 PT-01/PT-02/PT-12 preserve graph identities one-to-one', async () => {
  const run = await execution();
  const projection = createExplorerProjection({
    graph: run.state.graph,
    result: run.result
  });

  assert.equal(
    projection.schema,
    'kneekura.explorer-projection/v1'
  );

  const canonicalNodeIds = run.state.graph.nodes
    .map(node => node.id)
    .sort();
  const projectedNodeIds = projection.presentation.nodes
    .map(node => node.node_id)
    .sort();

  const canonicalEdgeIds = run.state.graph.edges
    .map(edge => edge.id)
    .sort();
  const projectedEdgeIds = projection.presentation.edges
    .map(edge => edge.edge_id)
    .sort();

  assert.deepEqual(projectedNodeIds, canonicalNodeIds);
  assert.deepEqual(projectedEdgeIds, canonicalEdgeIds);
  assert.equal(
    new Set(projectedNodeIds).size,
    run.state.graph.nodes.length
  );
  assert.equal(
    new Set(projectedEdgeIds).size,
    run.state.graph.edges.length
  );

  for (const item of projection.presentation.nodes) {
    const source =
      projection.canonical.graph.nodes[item.canonical_index];
    assert.equal(source.id, item.node_id);
    assert.equal(source.kind, item.canonical_kind);
  }

  for (const item of projection.presentation.edges) {
    const source =
      projection.canonical.graph.edges[item.canonical_index];
    assert.equal(source.id, item.edge_id);
    assert.equal(source.from, item.from_node_id);
    assert.equal(source.to, item.to_node_id);
    assert.equal(source.type, item.canonical_type);
  }
});

test('P1 PT-03/PT-06/PT-07/PT-08 preserve edge semantics without promotion', async () => {
  const run = await execution();
  const graph = semanticGraphFixture();
  const projection = createExplorerProjection({
    graph,
    result: run.result
  });

  assert.deepEqual(projection.canonical.graph, graph);

  const byId = new Map(
    projection.presentation.edges.map(edge => [
      edge.edge_id,
      edge
    ])
  );

  assert.equal(
    byId.get('edge:send').canonical_type,
    'PACKET_SEND'
  );
  assert.equal(
    byId.get('edge:receive').canonical_type,
    'PACKET_RECEIVE'
  );
  assert.notEqual(
    byId.get('edge:send').canonical_type,
    byId.get('edge:receive').canonical_type
  );

  assert.equal(
    byId.get('edge:m5').canonical_type,
    'M5_CLIENT_CONSUMED'
  );
  assert.equal(
    byId.get('edge:m6').canonical_type,
    'M6_FINAL_APPLICATION'
  );
  assert.notEqual(
    byId.get('edge:m5').canonical_type,
    byId.get('edge:m6').canonical_type
  );

  const canonicalById = new Map(
    projection.canonical.graph.edges.map(edge => [
      edge.id,
      edge
    ])
  );
  assert.equal(
    canonicalById.get('edge:static').runtimeObservation,
    false
  );
  assert.equal(
    canonicalById.get('edge:receive').runtimeObservation,
    true
  );
  assert.equal(
    canonicalById.get('edge:m5').transport_stage,
    'M5'
  );
  assert.equal(
    canonicalById.get('edge:m6').transport_stage,
    'M6'
  );

  for (const item of projection.presentation.edges) {
    assert.equal(
      Object.hasOwn(item, 'runtime_observed'),
      false,
      'P1 must not infer runtime truth into metadata'
    );
  }
});

test('P1 PT-04/PT-05/PT-09/PT-10 preserve Claim and Coverage semantics verbatim', async () => {
  const run = await execution();
  const result = semanticResultFixture(run.result);
  const graph = semanticGraphFixture();

  const projection = createExplorerProjection({
    graph,
    result
  });

  assert.deepEqual(projection.canonical.result, result);
  assert.equal(projection.canonical.result.status, 'PARTIAL');
  assert.equal(
    projection.canonical.result.coverage.completeness,
    'PARTIAL'
  );

  const coverageById = new Map(
    projection.presentation.coverage.map(entry => [
      entry.coverage_id,
      entry
    ])
  );
  assert.equal(
    coverageById.get('coverage:failed').status,
    'FAILED'
  );
  assert.equal(
    coverageById.get('coverage:unexplored').status,
    'UNEXPLORED'
  );
  assert.notEqual(
    coverageById.get('coverage:failed').status,
    'ABSENT'
  );
  assert.notEqual(
    coverageById.get('coverage:unexplored').status,
    'ABSENT'
  );

  const claimById = new Map(
    projection.presentation.claims.map(claim => [
      claim.claim_id,
      claim
    ])
  );
  const unknown = claimById.get('claim:unknown');
  assert.equal(unknown.type, 'UNKNOWN');
  assert.equal(unknown.status, 'UNRESOLVED');

  const limited = claimById.get('claim:limited');
  assert.equal(limited.status, 'VERIFIED_WITH_LIMITS');
  assert.deepEqual(limited.evidence_links, [{
    evidence_id: 'evidence:support',
    role: 'SUPPORT',
    strength: 'INDIRECT'
  }]);
  assert.deepEqual(limited.counterevidence_links, [{
    evidence_id: 'evidence:counter',
    role: 'CONTRADICT',
    strength: 'CORRELATED'
  }]);
  assert.notDeepEqual(
    limited.evidence_links,
    limited.counterevidence_links
  );

  assert.deepEqual(
    projection.canonical.result.evidence_refs,
    ['evidence:support']
  );
  assert.deepEqual(
    projection.canonical.result.counterevidence_refs,
    ['evidence:counter']
  );
  assert.deepEqual(
    projection.canonical.result.unknowns,
    [{ id: 'unknown:fixture', status: 'UNKNOWN' }]
  );
});

test('P1 PT-11 preserves KNEEKURA-specific kinds and keeps display family secondary', async () => {
  const run = await execution();
  const graph = semanticGraphFixture();

  const projection = createExplorerProjection({
    graph,
    result: run.result
  });
  const byId = new Map(
    projection.presentation.nodes.map(node => [
      node.node_id,
      node
    ])
  );

  assert.equal(
    byId.get('node:molang').canonical_kind,
    'molang_variable'
  );
  assert.equal(
    byId.get('node:bone').canonical_kind,
    'model_bone'
  );
  assert.equal(
    byId.get('node:animation').canonical_kind,
    'animation_name'
  );

  assert.equal(
    byId.get('node:molang').display_family,
    'semantic'
  );
  assert.equal(
    byId.get('node:bone').display_family,
    'semantic'
  );

  assert.equal(
    projection.canonical.graph.nodes.find(
      node => node.id === 'node:molang'
    ).kind,
    'molang_variable'
  );
  assert.equal(
    displayFamilyForKind('molang_variable'),
    'semantic'
  );
});

test('P1 projection is deterministic and cannot mutate canonical inputs', async () => {
  const run = await execution();
  const graph = semanticGraphFixture();
  const result = semanticResultFixture(run.result);
  const graphBefore = structuredClone(graph);
  const resultBefore = structuredClone(result);
  const digestBefore =
    digestCanonicalAnalysisResult(result);

  const first = createExplorerProjection({
    graph,
    result
  });
  const second = createExplorerProjection({
    graph,
    result
  });

  assert.deepEqual(second, first);
  assert.deepEqual(graph, graphBefore);
  assert.deepEqual(result, resultBefore);
  assert.equal(
    digestCanonicalAnalysisResult(result),
    digestBefore
  );
  assert.equal(
    first.source.analysis_result_digest,
    digestBefore
  );

  assert.notEqual(first.canonical.graph, graph);
  assert.notEqual(first.canonical.result, result);
  assert.notEqual(
    first.canonical.graph.nodes,
    graph.nodes
  );
  assert.notEqual(
    first.canonical.result.claims,
    result.claims
  );
});

test('P1 rejects malformed graph identity instead of inventing repair edges', async () => {
  const run = await execution();

  assert.throws(
    () => validateExplorerGraph({
      schema: 'kneekura.graph/v1',
      nodes: [
        { id: 'node:a', kind: 'class' },
        { id: 'node:a', kind: 'method' }
      ],
      edges: []
    }),
    /node IDs must be unique/
  );

  assert.throws(
    () => createExplorerProjection({
      graph: {
        schema: 'kneekura.graph/v1',
        nodes: [
          { id: 'node:a', kind: 'class' }
        ],
        edges: [{
          id: 'edge:missing',
          from: 'node:a',
          to: 'node:missing',
          type: 'CALLS'
        }]
      },
      result: run.result
    }),
    /edge endpoint is missing/
  );
});

function semanticGraphFixture() {
  return {
    schema: 'kneekura.graph/v1',
    generatedAt: '2026-08-29T00:00:00.000Z',
    root: '/fixture',
    diagnostics: [],
    meta: { analyzers: [] },
    nodes: [
      {
        id: 'node:sender',
        kind: 'method',
        key: 'sender',
        label: 'sender'
      },
      {
        id: 'node:packet',
        kind: 'packet',
        key: 'packet',
        label: 'Packet'
      },
      {
        id: 'node:molang',
        kind: 'molang_variable',
        key: 'v.wuqi',
        label: 'v.wuqi'
      },
      {
        id: 'node:bone',
        kind: 'model_bone',
        key: 'right_arm',
        label: 'right_arm'
      },
      {
        id: 'node:animation',
        kind: 'animation_name',
        key: 'attack',
        label: 'attack'
      }
    ],
    edges: [
      {
        id: 'edge:static',
        from: 'node:sender',
        to: 'node:packet',
        type: 'STATIC_PACKET_PATH',
        runtimeObservation: false,
        confidence: 1
      },
      {
        id: 'edge:send',
        from: 'node:sender',
        to: 'node:packet',
        type: 'PACKET_SEND',
        runtimeObservation: false,
        transport_stage: 'M1',
        confidence: 1
      },
      {
        id: 'edge:receive',
        from: 'node:packet',
        to: 'node:molang',
        type: 'PACKET_RECEIVE',
        runtimeObservation: true,
        transport_stage: 'M2',
        confidence: 1
      },
      {
        id: 'edge:m5',
        from: 'node:molang',
        to: 'node:animation',
        type: 'M5_CLIENT_CONSUMED',
        runtimeObservation: true,
        transport_stage: 'M5',
        confidence: 1
      },
      {
        id: 'edge:m6',
        from: 'node:animation',
        to: 'node:bone',
        type: 'M6_FINAL_APPLICATION',
        runtimeObservation: false,
        transport_stage: 'M6',
        confidence: 1
      }
    ]
  };
}

function semanticResultFixture(base) {
  const result = structuredClone(base);
  result.status = 'PARTIAL';
  result.coverage = {
    schema: 'core.coverage/v1',
    completeness: 'PARTIAL',
    fingerprint: 'fixture:p1',
    entries: [
      {
        id: 'coverage:primary',
        node_id: 'node:molang',
        role: 'PRIMARY',
        status: 'ANALYZED'
      },
      {
        id: 'coverage:failed',
        node_id: 'node:bone',
        role: 'DEPENDENCY',
        status: 'FAILED',
        reason: 'fixture failure'
      },
      {
        id: 'coverage:unexplored',
        node_id: 'node:animation',
        role: 'SUPPORTING_CONTEXT',
        status: 'UNEXPLORED',
        reason: 'fixture unexplored'
      }
    ]
  };
  result.claims = [
    {
      schema: 'core.claim/v1',
      id: 'claim:unknown',
      type: 'UNKNOWN',
      status: 'UNRESOLVED',
      subject: {
        node_id: 'node:molang'
      },
      predicate: 'fixture.unknown',
      object_or_value: null,
      confidence: {
        level: 'LOW',
        rationale: 'fixture'
      },
      evidence_links: [],
      counterevidence_links: [],
      dependency_claim_ids: [],
      coverage_ref: 'coverage:unexplored',
      provenance_refs: [],
      verifier_results: [],
      unresolved_reason: 'fixture unknown'
    },
    {
      schema: 'core.claim/v1',
      id: 'claim:limited',
      type: 'INFERRED',
      status: 'VERIFIED_WITH_LIMITS',
      subject: {
        node_id: 'node:bone'
      },
      predicate: 'fixture.limited',
      object_or_value: true,
      confidence: {
        level: 'MEDIUM',
        rationale: 'fixture'
      },
      evidence_links: [{
        evidence_id: 'evidence:support',
        role: 'SUPPORT',
        strength: 'INDIRECT'
      }],
      counterevidence_links: [{
        evidence_id: 'evidence:counter',
        role: 'CONTRADICT',
        strength: 'CORRELATED'
      }],
      dependency_claim_ids: [],
      coverage_ref: 'coverage:failed',
      provenance_refs: [],
      verifier_results: []
    }
  ];
  result.evidence_refs = ['evidence:support'];
  result.counterevidence_refs = ['evidence:counter'];
  result.evidence = [];
  result.unknowns = [{
    id: 'unknown:fixture',
    status: 'UNKNOWN'
  }];
  return result;
}
