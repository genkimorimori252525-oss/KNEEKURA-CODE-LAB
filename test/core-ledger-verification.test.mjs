import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { GraphBuilder } from '../src/core/graph.mjs';
import { createRepositoryIdentity } from '../src/core/identity/repository.mjs';
import { createWorkspaceSnapshot } from '../src/core/identity/snapshot.mjs';
import { scanRepository } from '../src/core/scan.mjs';
import { createEvidenceRecord } from '../src/core/evidence/provider.mjs';
import {
  addClaim,
  createEvidenceLedger,
  createEvidenceLedgerFromGraph,
  finalizeEvidenceLedger,
  reconstructConclusions,
  replaceClaim,
  storeEvidence
} from '../src/core/ledger/evidence-ledger.mjs';
import {
  createClaimEvidenceLink,
  createClaimRecord
} from '../src/core/ledger/claims.mjs';
import {
  buildVerifiedRuntimeLedger
} from '../src/core/ledger/runtime-claims.mjs';
import {
  verifyAndRecordClaim
} from '../src/core/verification/pipeline.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FORGE_FIXTURE = path.join(ROOT, 'fixtures/forge-mini');
const TRACE = path.join(ROOT, 'fixtures/runtime/kneekura-trace.jsonl');
const SERVER_NET = path.join(ROOT, 'fixtures/runtime/kneekura-server.net.jsonl');
const CLIENT_NET = path.join(ROOT, 'fixtures/runtime/kneekura-client.net.jsonl');
const M6_NET = path.join(ROOT, 'fixtures/runtime/kneekura-client-m6-applied.net.jsonl');

function syntheticContext() {
  const repository = createRepositoryIdentity({ root: '/tmp/kneekura-ledger-fixture' });
  const snapshot = createWorkspaceSnapshot(repository, {
    entries: [
      { path: 'src/A.java', state: 'UNTRACKED', digest: 'sha256:' + '1'.repeat(64) },
      { path: 'src/B.java', state: 'UNTRACKED', digest: 'sha256:' + '2'.repeat(64) }
    ]
  });

  return { repository, snapshot };
}

function completeCoverage(snapshotId, ids = ['scope:A']) {
  return {
    schema: 'core.coverage/v1',
    completeness: 'COMPLETE',
    snapshot_id: snapshotId,
    fingerprint: 'sha256:' + 'c'.repeat(64),
    entries: ids.map(id => ({
      id,
      role: 'PRIMARY',
      status: 'ANALYZED'
    }))
  };
}

function partialCoverage(snapshotId) {
  return {
    schema: 'core.coverage/v1',
    completeness: 'PARTIAL',
    snapshot_id: snapshotId,
    fingerprint: 'sha256:' + 'd'.repeat(64),
    entries: [
      { id: 'scope:A', role: 'PRIMARY', status: 'ANALYZED' },
      {
        id: 'scope:B',
        role: 'DEPENDENCY',
        status: 'UNEXPLORED',
        reason: 'fixture gap',
        reason_code: 'FIXTURE_GAP'
      }
    ]
  };
}

function runtimeEvidence({
  repository,
  snapshot,
  edgeTypes,
  run = 'run-1',
  artifactChar = 'a',
  observation = {}
}) {
  const digest = 'sha256:' + artifactChar.repeat(64);
  return createEvidenceRecord({
    kind: 'RUNTIME',
    observation: {
      runtime_run_id: run,
      physical_side: 'CLIENT',
      graph_delta: {
        nodes_added: 1,
        edges_added: Object.values(edgeTypes).reduce((sum, count) => sum + count, 0),
        node_kinds: {},
        edge_types: edgeTypes
      },
      ...observation
    },
    provenance: {
      repository_id: repository.repository_id,
      snapshot_id: snapshot.snapshot_id,
      provider_id: 'network-companion-adapter',
      provider_version: 'v1',
      extraction_method: 'fixture-network',
      artifact_id: 'artifact:' + digest,
      artifact_digest: digest,
      runtime_run_id: run
    },
    trustClass: 'RUNTIME_MEASURED',
    providerId: 'network-companion-adapter',
    providerVersion: 'v1'
  });
}

function syntheticGraph({
  edgeType,
  edgeAttrs = {},
  key = 'variable.wuqi',
  kind = 'molang_variable',
  providers = true
} = {}) {
  const { repository, snapshot } = syntheticContext();
  const builder = new GraphBuilder('/tmp/kneekura-ledger-fixture');
  const node = builder.node(kind, key, { label: key });

  if (edgeType) {
    const source = builder.node('runtime_network_semantic_observation', 'obs:' + edgeType, {
      label: edgeType,
      runtimeObserved: true
    });
    builder.edge(source, node, edgeType, {
      runtimeObservation: true,
      ...edgeAttrs
    });
  }

  const graph = builder.finish();
  graph.meta.repository = repository;
  graph.meta.snapshot = snapshot;
  graph.meta.providers = providers ? [{
    id: 'network-companion-adapter',
    version: 'v1',
    capabilities: {
      input_kinds: ['runtime-network-companion'],
      supported_properties: ['packet-send','packet-receive','network-semantic','runtime-molang-payload'],
      deterministic: true,
      evidence_kind: 'RUNTIME',
      failure_classes: ['PARSE_FAILED']
    }
  }] : [];
  graph.meta.providerFailures = [];
  graph.meta.evidence = [];

  return { graph, node, repository, snapshot };
}

function ledgerWithEvidence(graph, coverage, evidence) {
  graph.meta.evidence = Array.isArray(evidence) ? evidence : [evidence];
  return createEvidenceLedgerFromGraph(graph, coverage);
}

test('Evidence Ledger deduplicates identical observations but preserves distinct runtime runs/artifacts', () => {
  const { repository, snapshot } = syntheticContext();
  const coverage = completeCoverage(snapshot.snapshot_id);
  const ledger = createEvidenceLedger({
    repositoryIds: [repository.repository_id],
    snapshotIds: [snapshot.snapshot_id],
    coverage
  });

  const first = runtimeEvidence({
    repository,
    snapshot,
    edgeTypes: { OBSERVED_PACKET_SEND: 1 },
    run: 'run-1',
    artifactChar: 'a'
  });
  const identical = structuredClone(first);
  const secondRun = runtimeEvidence({
    repository,
    snapshot,
    edgeTypes: { OBSERVED_PACKET_SEND: 1 },
    run: 'run-2',
    artifactChar: 'b'
  });

  const result = storeEvidence(ledger, [first, identical, secondRun]);
  assert.equal(result[0].reused, false);
  assert.equal(result[1].reused, true);
  assert.equal(result[2].reused, false);
  assert.equal(ledger.evidence.length, 2);
  assert.notEqual(ledger.evidence[0].id, ledger.evidence[1].id);
});

test('Claim construction enforces OBSERVED, DERIVED, INFERRED, NEGATIVE and UNKNOWN entry rules', () => {
  assert.throws(() => createClaimRecord({
    type: 'OBSERVED',
    subject: 'A',
    predicate: 'exists',
    objectOrValue: true,
    coverageRef: 'coverage:test'
  }), /DIRECT SUPPORT/);

  assert.throws(() => createClaimRecord({
    type: 'DERIVED',
    subject: 'A',
    predicate: 'derived',
    objectOrValue: true,
    coverageRef: 'coverage:test'
  }), /dependency/);

  assert.throws(() => createClaimRecord({
    type: 'INFERRED',
    status: 'VERIFIED',
    subject: 'A',
    predicate: 'guess',
    objectOrValue: true,
    coverageRef: 'coverage:test'
  }), /must begin PROPOSED/);

  assert.throws(() => createClaimRecord({
    type: 'NEGATIVE',
    status: 'VERIFIED',
    subject: 'A',
    predicate: 'missing',
    objectOrValue: true,
    coverageRef: 'coverage:test'
  }), /must begin PROPOSED/);

  assert.throws(() => createClaimRecord({
    type: 'UNKNOWN',
    subject: 'A',
    predicate: 'unknown',
    objectOrValue: null,
    coverageRef: 'coverage:test'
  }), /unresolvedReason/);
});

test('host-like M5-to-M6 proposal is rejected deterministically', () => {
  const { graph, node, repository, snapshot } = syntheticGraph({
    edgeType: 'OBSERVED_YSM_CLIENT_COMMAND_HANDLED',
    edgeAttrs: { handledByClient: true }
  });
  const coverage = completeCoverage(snapshot.snapshot_id);
  const evidence = runtimeEvidence({
    repository,
    snapshot,
    edgeTypes: { OBSERVED_YSM_CLIENT_COMMAND_HANDLED: 1 }
  });
  const ledger = ledgerWithEvidence(graph, coverage, evidence);

  const proposal = createClaimRecord({
    type: 'INFERRED',
    subject: { node_id: node.id, key: node.key },
    predicate: 'ysm.molang_state_applied',
    objectOrValue: true,
    evidenceLinks: [createClaimEvidenceLink({
      evidenceId: evidence.id,
      role: 'SUPPORT',
      strength: 'DIRECT',
      rationale: 'host incorrectly treats M5 as M6'
    })],
    coverageRef: ledger.coverage_ref
  });
  addClaim(ledger, proposal);

  const result = verifyAndRecordClaim(ledger, proposal.id, { graph, coverage });
  assert.equal(result.status, 'REJECTED');
  assert.equal(result.records.some(record =>
    record.findings.some(item => item.code === 'M5_IS_NOT_M6')
  ), true);
});

test('packet send cannot verify packet receive', () => {
  const { graph, node, repository, snapshot } = syntheticGraph({
    edgeType: 'OBSERVED_PACKET_SEND',
    key: 'ReimuPacket',
    kind: 'network_message'
  });
  const coverage = completeCoverage(snapshot.snapshot_id);
  const evidence = runtimeEvidence({
    repository,
    snapshot,
    edgeTypes: { OBSERVED_PACKET_SEND: 1 }
  });
  const ledger = ledgerWithEvidence(graph, coverage, evidence);

  const proposal = createClaimRecord({
    type: 'INFERRED',
    subject: { node_id: node.id, key: node.key },
    predicate: 'runtime.packet_received',
    objectOrValue: true,
    evidenceLinks: [createClaimEvidenceLink({
      evidenceId: evidence.id,
      role: 'SUPPORT',
      strength: 'DIRECT'
    })],
    coverageRef: ledger.coverage_ref
  });
  addClaim(ledger, proposal);

  const result = verifyAndRecordClaim(ledger, proposal.id, { graph, coverage });
  assert.equal(result.status, 'REJECTED');
  assert.equal(result.records.some(record =>
    record.findings.some(item => item.code === 'SEND_IS_NOT_RECEIVE')
  ), true);
});

test('formal qualified M6 observed claim verifies', () => {
  const { graph, node, repository, snapshot } = syntheticGraph({
    edgeType: 'OBSERVED_YSM_MOLANG_STATE_APPLIED',
    edgeAttrs: {
      controlledE2Qualified: true,
      exactVariableIdentity: true,
      evidenceLevel: 'E2_ACTUAL_PRE_POST_TRANSITION'
    }
  });
  const coverage = completeCoverage(snapshot.snapshot_id);
  const evidence = runtimeEvidence({
    repository,
    snapshot,
    edgeTypes: { OBSERVED_YSM_MOLANG_STATE_APPLIED: 1 }
  });
  const ledger = ledgerWithEvidence(graph, coverage, evidence);

  const claim = createClaimRecord({
    type: 'OBSERVED',
    subject: { node_id: node.id, key: node.key },
    predicate: 'ysm.molang_state_applied',
    objectOrValue: true,
    evidenceLinks: [createClaimEvidenceLink({
      evidenceId: evidence.id,
      role: 'SUPPORT',
      strength: 'DIRECT'
    })],
    coverageRef: ledger.coverage_ref
  });
  addClaim(ledger, claim);

  const result = verifyAndRecordClaim(ledger, claim.id, { graph, coverage });
  assert.equal(result.status, 'VERIFIED');
});

test('weak YSM state correlation never verifies as M6', () => {
  const { graph, node, repository, snapshot } = syntheticGraph({
    edgeType: 'OBSERVED_YSM_STATE_CORRELATED',
    edgeAttrs: {
      controlledE2Qualified: false,
      evidenceLevel: 'E2_ACTUAL_PRE_POST_TRANSITION_UNQUALIFIED'
    }
  });
  const coverage = completeCoverage(snapshot.snapshot_id);
  const evidence = runtimeEvidence({
    repository,
    snapshot,
    edgeTypes: { OBSERVED_YSM_STATE_CORRELATED: 1 }
  });
  const ledger = ledgerWithEvidence(graph, coverage, evidence);

  const claim = createClaimRecord({
    type: 'INFERRED',
    subject: { node_id: node.id, key: node.key },
    predicate: 'ysm.molang_state_applied',
    objectOrValue: true,
    evidenceLinks: [createClaimEvidenceLink({
      evidenceId: evidence.id,
      role: 'SUPPORT',
      strength: 'CORRELATED'
    })],
    coverageRef: ledger.coverage_ref
  });
  addClaim(ledger, claim);

  const result = verifyAndRecordClaim(ledger, claim.id, { graph, coverage });
  assert.equal(result.status, 'REJECTED');
  assert.equal(result.records.some(record =>
    record.findings.some(item => item.code === 'WEAK_CORRELATION_IS_NOT_M6')
  ), true);
});

function negativeFixture({ coverage, supported = true, failed = false } = {}) {
  const { graph, node, repository, snapshot } = syntheticGraph({
    key: 'ReimuPacket',
    kind: 'network_message',
    providers: supported
  });
  graph.meta.providerFailures = failed ? [{
    code: 'PARSE_FAILED',
    message: 'fixture analyzer failed',
    provider_id: 'network-companion-adapter',
    provider_version: 'v1',
    unit_ref: 'fixture'
  }] : [];

  const actualCoverage = coverage?.(snapshot.snapshot_id) ?? completeCoverage(snapshot.snapshot_id, ['scope:A','scope:B']);
  const ledger = createEvidenceLedgerFromGraph(graph, actualCoverage);
  const claim = createClaimRecord({
    type: 'NEGATIVE',
    subject: { node_id: node.id, key: node.key },
    predicate: 'runtime.packet_received',
    objectOrValue: false,
    coverageRef: ledger.coverage_ref
  });
  addClaim(ledger, claim);

  return { graph, node, repository, snapshot, coverage: actualCoverage, ledger, claim };
}

function negativeContext() {
  return {
    searched_property: 'packet-receive',
    provider_id: 'network-companion-adapter',
    search_universe: {
      id: 'universe:packet-receive',
      enumerable: true,
      item_ids: ['scope:A','scope:B']
    }
  };
}

test('negative gate verifies absence only over a full explicit enumerable universe', () => {
  const f = negativeFixture();
  const result = verifyAndRecordClaim(f.ledger, f.claim.id, {
    graph: f.graph,
    coverage: f.coverage,
    negativeContext: negativeContext()
  });

  assert.equal(result.status, 'VERIFIED');
  assert.equal(result.records.some(record =>
    record.verifier_id === 'core.verifier.negative' &&
    record.findings.some(item => item.code === 'NEGATIVE_GATE_PASSED')
  ), true);
});

test('one unexplored relevant item prevents a strong negative claim', () => {
  const f = negativeFixture({ coverage: partialCoverage });
  const result = verifyAndRecordClaim(f.ledger, f.claim.id, {
    graph: f.graph,
    coverage: f.coverage,
    negativeContext: negativeContext()
  });

  assert.equal(result.status, 'UNRESOLVED');
  assert.equal(result.records.some(record =>
    record.findings.some(item => item.code === 'COVERAGE_GAP')
  ), true);
});

test('unsupported analyzer degrades negative proposal to unknown verification outcome', () => {
  const f = negativeFixture({ supported: false });
  const result = verifyAndRecordClaim(f.ledger, f.claim.id, {
    graph: f.graph,
    coverage: f.coverage,
    negativeContext: negativeContext()
  });

  assert.equal(result.status, 'UNRESOLVED');
  const negative = result.records.find(record => record.verifier_id === 'core.verifier.negative');
  assert.equal(negative.findings[0].code, 'ANALYZER_UNSUPPORTED');
  assert.equal(negative.findings[0].details.outcome, 'UNKNOWN');
});

test('analyzer failure prevents negative verification', () => {
  const f = negativeFixture({ failed: true });
  const result = verifyAndRecordClaim(f.ledger, f.claim.id, {
    graph: f.graph,
    coverage: f.coverage,
    negativeContext: negativeContext()
  });

  assert.notEqual(result.status, 'VERIFIED');
  assert.equal(result.records.some(record =>
    record.findings.some(item => item.code === 'ANALYZER_FAILED')
  ), true);
});

test('stale snapshot prevents negative verification', () => {
  const f = negativeFixture();
  const result = verifyAndRecordClaim(f.ledger, f.claim.id, {
    graph: f.graph,
    coverage: f.coverage,
    negativeContext: negativeContext(),
    staleSnapshot: true
  });

  assert.notEqual(result.status, 'VERIFIED');
  assert.equal(result.records.some(record =>
    record.findings.some(item => item.code === 'STALE_SNAPSHOT')
  ), true);
});

test('direct counterevidence rejects a claim without deleting its support', () => {
  const { graph, node, repository, snapshot } = syntheticGraph({
    edgeType: 'OBSERVED_PACKET_RECEIVE',
    key: 'ReimuPacket',
    kind: 'network_message'
  });
  const coverage = completeCoverage(snapshot.snapshot_id);
  const support = runtimeEvidence({
    repository,
    snapshot,
    edgeTypes: { OBSERVED_PACKET_RECEIVE: 1 },
    artifactChar: 'a'
  });
  const contradiction = runtimeEvidence({
    repository,
    snapshot,
    edgeTypes: { OBSERVED_PACKET_SEND: 1 },
    artifactChar: 'b',
    observation: { contradiction: 'capture proves a mutually exclusive fixture condition' }
  });
  const ledger = ledgerWithEvidence(graph, coverage, [support, contradiction]);

  const claim = createClaimRecord({
    type: 'OBSERVED',
    subject: { node_id: node.id, key: node.key },
    predicate: 'runtime.packet_received',
    objectOrValue: true,
    evidenceLinks: [createClaimEvidenceLink({
      evidenceId: support.id,
      role: 'SUPPORT',
      strength: 'DIRECT'
    })],
    counterevidenceLinks: [createClaimEvidenceLink({
      evidenceId: contradiction.id,
      role: 'CONTRADICT',
      strength: 'DIRECT'
    })],
    coverageRef: ledger.coverage_ref
  });
  addClaim(ledger, claim);

  const result = verifyAndRecordClaim(ledger, claim.id, { graph, coverage });
  assert.equal(result.status, 'REJECTED');

  const stored = ledger.claims.find(item => item.id === claim.id);
  assert.equal(stored.evidence_links.length, 1);
  assert.equal(stored.counterevidence_links.length, 1);
});

test('indirect counterevidence produces VERIFIED_WITH_LIMITS and preserves both sides', () => {
  const { graph, node, repository, snapshot } = syntheticGraph({
    edgeType: 'OBSERVED_PACKET_RECEIVE',
    key: 'ReimuPacket',
    kind: 'network_message'
  });
  const coverage = completeCoverage(snapshot.snapshot_id);
  const support = runtimeEvidence({
    repository,
    snapshot,
    edgeTypes: { OBSERVED_PACKET_RECEIVE: 1 },
    artifactChar: 'a'
  });
  const contextEvidence = runtimeEvidence({
    repository,
    snapshot,
    edgeTypes: { OBSERVED_PACKET_SEND: 1 },
    artifactChar: 'b',
    observation: { note: 'indirect contradictory context' }
  });
  const ledger = ledgerWithEvidence(graph, coverage, [support, contextEvidence]);

  const claim = createClaimRecord({
    type: 'OBSERVED',
    subject: { node_id: node.id, key: node.key },
    predicate: 'runtime.packet_received',
    objectOrValue: true,
    evidenceLinks: [createClaimEvidenceLink({
      evidenceId: support.id,
      role: 'SUPPORT',
      strength: 'DIRECT'
    })],
    counterevidenceLinks: [createClaimEvidenceLink({
      evidenceId: contextEvidence.id,
      role: 'CONTRADICT',
      strength: 'INDIRECT'
    })],
    coverageRef: ledger.coverage_ref
  });
  addClaim(ledger, claim);

  const result = verifyAndRecordClaim(ledger, claim.id, { graph, coverage });
  assert.equal(result.status, 'VERIFIED_WITH_LIMITS');
});

test('real M5 fixture derives command-consumed but never fabricates M6 applied state', async () => {
  const graph = await scanRepository(FORGE_FIXTURE, {
    trace: TRACE,
    network: [SERVER_NET, CLIENT_NET]
  });
  const coverage = completeCoverage(graph.meta.snapshot.snapshot_id, ['runtime:fixture']);
  const built = buildVerifiedRuntimeLedger({ graph, coverage });

  const handled = built.ledger.claims.find(claim =>
    claim.predicate === 'ysm.client_command_handled' &&
    ['VERIFIED','VERIFIED_WITH_LIMITS'].includes(claim.status)
  );
  const consumed = built.ledger.claims.find(claim =>
    claim.predicate === 'ysm.client_command_consumed' &&
    ['VERIFIED','VERIFIED_WITH_LIMITS'].includes(claim.status)
  );
  const applied = built.ledger.claims.find(claim =>
    claim.predicate === 'ysm.molang_state_applied' &&
    ['VERIFIED','VERIFIED_WITH_LIMITS'].includes(claim.status)
  );

  assert.ok(handled);
  assert.ok(consumed);
  assert.equal(applied, undefined);

  const matrix = graph.nodes.find(node =>
    node.kind === 'molang_transport_matrix' &&
    node.variable === 'variable.wuqi'
  );
  assert.equal(matrix.observedThroughStage, 'M5');
  assert.equal(matrix.firstUnobservedStage, 'M6');
});

test('real formal M6 fixture produces verified applied-state claim', async () => {
  const graph = await scanRepository(FORGE_FIXTURE, {
    trace: TRACE,
    network: [SERVER_NET, M6_NET]
  });
  const coverage = completeCoverage(graph.meta.snapshot.snapshot_id, ['runtime:fixture']);
  const built = buildVerifiedRuntimeLedger({ graph, coverage });

  const applied = built.ledger.claims.find(claim =>
    claim.predicate === 'ysm.molang_state_applied' &&
    claim.status === 'VERIFIED'
  );
  assert.ok(applied);

  const matrix = graph.nodes.find(node =>
    node.kind === 'molang_transport_matrix' &&
    node.variable === 'variable.wuqi'
  );
  assert.equal(matrix.observedThroughStage, 'M6');
  assert.equal(matrix.m6StateAppliedObserved, true);
});

test('real send-only fixture creates send conclusion but no receive conclusion', async () => {
  const graph = await scanRepository(FORGE_FIXTURE, {
    trace: TRACE,
    network: [SERVER_NET]
  });
  const coverage = completeCoverage(graph.meta.snapshot.snapshot_id, ['runtime:fixture']);
  const built = buildVerifiedRuntimeLedger({ graph, coverage });

  assert.equal(built.ledger.claims.some(claim =>
    claim.predicate === 'runtime.packet_sent' &&
    ['VERIFIED','VERIFIED_WITH_LIMITS'].includes(claim.status)
  ), true);
  assert.equal(built.ledger.claims.some(claim =>
    claim.predicate === 'runtime.packet_received' &&
    ['VERIFIED','VERIFIED_WITH_LIMITS'].includes(claim.status)
  ), false);
});

test('final Ledger reconstructs conclusions without renderer prose', () => {
  const { graph, node, repository, snapshot } = syntheticGraph({
    edgeType: 'OBSERVED_PACKET_RECEIVE',
    key: 'ReimuPacket',
    kind: 'network_message'
  });
  const coverage = completeCoverage(snapshot.snapshot_id);
  const evidence = runtimeEvidence({
    repository,
    snapshot,
    edgeTypes: { OBSERVED_PACKET_RECEIVE: 1 }
  });
  const ledger = ledgerWithEvidence(graph, coverage, evidence);
  const claim = createClaimRecord({
    type: 'OBSERVED',
    subject: { node_id: node.id, key: node.key },
    predicate: 'runtime.packet_received',
    objectOrValue: true,
    evidenceLinks: [createClaimEvidenceLink({
      evidenceId: evidence.id,
      role: 'SUPPORT',
      strength: 'DIRECT'
    })],
    coverageRef: ledger.coverage_ref
  });
  addClaim(ledger, claim);
  verifyAndRecordClaim(ledger, claim.id, { graph, coverage });

  const final = finalizeEvidenceLedger(ledger);
  const conclusions = reconstructConclusions(ledger);

  assert.equal(final.schema, 'core.evidence-ledger/v1');
  assert.equal(final.evidence.length, 1);
  assert.equal(final.claims.length, 1);
  assert.equal(final.verification_records.length, 9);
  assert.equal(final.claim_evidence_links.length, 1);
  assert.equal(conclusions.length, 1);
  assert.equal(conclusions[0].predicate, 'runtime.packet_received');
  assert.equal(Object.hasOwn(final, 'renderer_prose'), false);
});


test('Claim ID is stable across evidence ordering, evidence expansion, and verification state', () => {
  const subject = { node_id: 'node:stable', key: 'StableSubject' };
  const linkA = createClaimEvidenceLink({
    evidenceId: 'evidence:alpha',
    role: 'SUPPORT',
    strength: 'DIRECT'
  });
  const linkB = createClaimEvidenceLink({
    evidenceId: 'evidence:beta',
    role: 'SUPPORT',
    strength: 'DIRECT'
  });

  const first = createClaimRecord({
    type: 'OBSERVED',
    subject,
    predicate: 'exists',
    objectOrValue: true,
    evidenceLinks: [linkB, linkA],
    coverageRef: 'coverage:first',
    provenanceRefs: ['graph-edge:z', 'graph-edge:a']
  });
  const reordered = createClaimRecord({
    type: 'OBSERVED',
    subject,
    predicate: 'exists',
    objectOrValue: true,
    evidenceLinks: [linkA, linkB],
    coverageRef: 'coverage:second',
    provenanceRefs: ['graph-edge:a']
  });
  const expanded = createClaimRecord({
    type: 'OBSERVED',
    subject,
    predicate: 'exists',
    objectOrValue: true,
    evidenceLinks: [linkA],
    coverageRef: 'coverage:third'
  });

  assert.equal(first.id, reordered.id);
  assert.equal(first.id, expanded.id);
  assert.deepEqual(
    first.evidence_links.map(link => link.evidence_id),
    ['evidence:alpha', 'evidence:beta']
  );
  assert.deepEqual(first.provenance_refs, ['graph-edge:a', 'graph-edge:z']);

  const verified = {
    ...first,
    status: 'VERIFIED',
    verifier_results: []
  };
  assert.equal(verified.id, first.id);
});

test('DERIVED Claim ID includes deterministic derivation lineage rather than evidence ordering', () => {
  const base = {
    type: 'DERIVED',
    subject: { node_id: 'node:stable', key: 'StableSubject' },
    predicate: 'derived.fact',
    objectOrValue: true,
    evidenceLinks: [createClaimEvidenceLink({
      evidenceId: 'evidence:alpha',
      role: 'SUPPORT',
      strength: 'INDIRECT'
    })],
    dependencyClaimIds: ['claim:z', 'claim:a'],
    coverageRef: 'coverage:first',
    derivation: {
      rule_id: 'core.derive.fixture',
      rule_version: 'v1'
    }
  };

  const first = createClaimRecord(base);
  const reordered = createClaimRecord({
    ...base,
    dependencyClaimIds: ['claim:a', 'claim:z'],
    evidenceLinks: [createClaimEvidenceLink({
      evidenceId: 'evidence:beta',
      role: 'SUPPORT',
      strength: 'INDIRECT'
    })],
    coverageRef: 'coverage:second'
  });
  const differentLineage = createClaimRecord({
    ...base,
    dependencyClaimIds: ['claim:a'],
    derivation: {
      rule_id: 'core.derive.fixture',
      rule_version: 'v2'
    }
  });

  assert.equal(first.id, reordered.id);
  assert.notEqual(first.id, differentLineage.id);
  assert.deepEqual(first.dependency_claim_ids, ['claim:a', 'claim:z']);
});


test('negative verification searches the graph and refuses a strong negative when positive evidence exists', () => {
  const { graph, node, snapshot } = syntheticGraph({
    edgeType: 'OBSERVED_PACKET_RECEIVE',
    key: 'ReimuPacket',
    kind: 'network_message'
  });
  const coverage = completeCoverage(snapshot.snapshot_id, ['scope:A','scope:B']);
  const ledger = createEvidenceLedgerFromGraph(graph, coverage);
  const claim = createClaimRecord({
    type: 'NEGATIVE',
    subject: { node_id: node.id, key: node.key },
    predicate: 'runtime.packet_received',
    objectOrValue: false,
    coverageRef: ledger.coverage_ref
  });
  addClaim(ledger, claim);

  const result = verifyAndRecordClaim(ledger, claim.id, {
    graph,
    coverage,
    negativeContext: negativeContext()
  });

  assert.equal(result.status, 'UNRESOLVED');
  const negative = result.records.find(record =>
    record.verifier_id === 'core.verifier.negative'
  );
  assert.ok(negative);
  assert.equal(negative.findings[0].code, 'COUNTEREVIDENCE_FOUND');
  assert.equal(
    negative.findings[0].details.refs.some(ref => ref.startsWith('edge:')),
    true
  );
});

test('Ledger ingress cannot accept a host-forged already-VERIFIED claim', () => {
  const { graph, node, snapshot } = syntheticGraph({
    key: 'ReimuPacket',
    kind: 'network_message'
  });
  const coverage = completeCoverage(snapshot.snapshot_id);
  const ledger = createEvidenceLedgerFromGraph(graph, coverage);
  const proposed = createClaimRecord({
    type: 'INFERRED',
    subject: { node_id: node.id, key: node.key },
    predicate: 'runtime.packet_received',
    objectOrValue: true,
    coverageRef: ledger.coverage_ref
  });

  const forged = {
    ...structuredClone(proposed),
    status: 'VERIFIED',
    verifier_results: []
  };
  assert.throws(
    () => addClaim(ledger, forged),
    /ingress must be PROPOSED/
  );
});

test('Ledger replacement cannot promote a claim without machine verifier records', () => {
  const { graph, node, snapshot } = syntheticGraph({
    key: 'ReimuPacket',
    kind: 'network_message'
  });
  const coverage = completeCoverage(snapshot.snapshot_id);
  const ledger = createEvidenceLedgerFromGraph(graph, coverage);
  const proposed = createClaimRecord({
    type: 'INFERRED',
    subject: { node_id: node.id, key: node.key },
    predicate: 'runtime.packet_received',
    objectOrValue: true,
    coverageRef: ledger.coverage_ref
  });
  addClaim(ledger, proposed);

  const forged = {
    ...structuredClone(proposed),
    status: 'VERIFIED',
    verifier_results: []
  };
  assert.throws(
    () => replaceClaim(ledger, forged),
    /requires machine verifier_results/
  );
});


test('stored EvidenceRecords are deeply immutable Ledger facts', () => {
  const { graph, repository, snapshot } = syntheticGraph();
  const coverage = completeCoverage(snapshot.snapshot_id);
  const evidence = runtimeEvidence({
    repository,
    snapshot,
    edgeTypes: { OBSERVED_PACKET_SEND: 1 }
  });
  const ledger = ledgerWithEvidence(graph, coverage, evidence);
  const stored = ledger.evidence[0];

  assert.equal(Object.isFrozen(stored), true);
  assert.equal(Object.isFrozen(stored.observation), true);
  assert.equal(Object.isFrozen(stored.observation.graph_delta), true);
  assert.throws(
    () => {
      stored.observation.graph_delta.edge_types.OBSERVED_PACKET_SEND = 999;
    },
    TypeError
  );
  assert.equal(
    stored.observation.graph_delta.edge_types.OBSERVED_PACKET_SEND,
    1
  );
});

test('HYPOTHESIS remains UNRESOLVED even when deterministic verification otherwise runs', () => {
  const { graph, node, snapshot } = syntheticGraph({
    key: 'HypothesisTarget',
    kind: 'class'
  });
  const coverage = completeCoverage(snapshot.snapshot_id);
  const ledger = createEvidenceLedgerFromGraph(graph, coverage);
  const hypothesis = createClaimRecord({
    type: 'HYPOTHESIS',
    subject: { node_id: node.id, key: node.key },
    predicate: 'hypothesis.possible_behavior',
    objectOrValue: true,
    coverageRef: ledger.coverage_ref
  });
  addClaim(ledger, hypothesis);

  const result = verifyAndRecordClaim(ledger, hypothesis.id, {
    graph,
    coverage
  });

  assert.equal(result.status, 'UNRESOLVED');
  const stored = ledger.claims.find(claim => claim.id === hypothesis.id);
  assert.equal(stored.status, 'UNRESOLVED');
  assert.equal(reconstructConclusions(ledger).some(claim => claim.id === hypothesis.id), false);
});
