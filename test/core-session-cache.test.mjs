import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { scanRepository } from '../src/core/scan.mjs';
import {
  c0BlobKey,
  c1ArtifactKey,
  c2GraphKey,
  c3PlanningKey,
  c4AnalysisKey,
  contentDigest
} from '../src/core/cache/fingerprint.mjs';
import {
  createCacheStore
} from '../src/core/cache/store.mjs';
import {
  createExplorationLedger,
  evaluateClaimReuse,
  findReusableAcquisition,
  recordProviderAcquisition
} from '../src/core/session/exploration-ledger.mjs';
import {
  createSessionEvent,
  createSessionStore,
  replaySessionEvents,
  verifyEventChain
} from '../src/core/session/event-log.mjs';
import {
  assertNoPathOnlyReuse,
  planSessionContinuation
} from '../src/core/session/resume.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FORGE_FIXTURE = path.join(ROOT, 'fixtures/forge-mini');

async function tempRoot(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test('cache tier keys are deterministic and dependency-sensitive', () => {
  const digest = contentDigest('class A {}');
  assert.equal(c0BlobKey('class A {}'), 'c0:' + digest);

  const c1a = c1ArtifactKey({
    content_digest: digest,
    provider_id: 'builtin-java',
    provider_version: 'lexical-v1',
    analyzer_config_fingerprint: 'config:v1'
  });
  const c1b = c1ArtifactKey({
    provider_version: 'lexical-v1',
    analyzer_config_fingerprint: 'config:v1',
    content_digest: digest,
    provider_id: 'builtin-java'
  });
  const c1Changed = c1ArtifactKey({
    content_digest: contentDigest('class A { int x; }'),
    provider_id: 'builtin-java',
    provider_version: 'lexical-v1',
    analyzer_config_fingerprint: 'config:v1'
  });
  assert.equal(c1a, c1b);
  assert.notEqual(c1a, c1Changed);

  assert.equal(
    c2GraphKey({
      snapshot_id: 'snapshot:1',
      provider_dependencies: ['b','a'],
      ontology_fingerprint: 'ontology:v1'
    }),
    c2GraphKey({
      snapshot_id: 'snapshot:1',
      provider_dependencies: ['a','b'],
      ontology_fingerprint: 'ontology:v1'
    })
  );
  assert.notEqual(
    c3PlanningKey({
      snapshot_id: 'snapshot:1',
      normalized_seeds: ['A'],
      planner_version: 'v1'
    }),
    c3PlanningKey({
      snapshot_id: 'snapshot:1',
      normalized_seeds: ['B'],
      planner_version: 'v1'
    })
  );
  assert.notEqual(
    c4AnalysisKey({
      snapshot_id: 'snapshot:1',
      normalized_request: { query: 'A' },
      engine_fingerprint: 'engine:v1'
    }),
    c4AnalysisKey({
      snapshot_id: 'snapshot:1',
      normalized_request: { query: 'A' },
      engine_fingerprint: 'engine:v2'
    })
  );
});

test('C0 blobs are immutable content-addressed artifacts', async () => {
  const root = await tempRoot('kneekura-cache-c0-');
  try {
    const store = createCacheStore({ storageRoot: root });
    const first = await store.putBlob(Buffer.from('hello'));
    const second = await store.putBlob(Buffer.from('hello'));
    assert.equal(first.artifact.key, second.artifact.key);
    assert.equal(first.hit, false);
    assert.equal(first.reused, false);
    assert.equal(second.hit, true);
    assert.equal(second.reused, true);

    const loaded = await store.getBlob(first.artifact.key);
    assert.equal(loaded.hit, true);
    assert.equal(loaded.artifact.bytes.toString('utf8'), 'hello');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('one-file change preserves unrelated C1 cache artifact', async () => {
  const root = await tempRoot('kneekura-cache-c1-');
  try {
    const store = createCacheStore({ storageRoot: root });
    const a1 = contentDigest('class A {}');
    const b1 = contentDigest('class B {}');
    const keyA1 = c1ArtifactKey({
      content_digest: a1,
      provider_id: 'builtin-java',
      provider_version: 'lexical-v1'
    });
    const keyB1 = c1ArtifactKey({
      content_digest: b1,
      provider_id: 'builtin-java',
      provider_version: 'lexical-v1'
    });

    await store.putArtifact({
      tier: 'C1',
      key: keyA1,
      dependencies: [{ kind: 'content', id: a1 }],
      payload: { file: 'A.java', facts: ['A'] }
    });
    await store.putArtifact({
      tier: 'C1',
      key: keyB1,
      dependencies: [{ kind: 'content', id: b1 }],
      payload: { file: 'B.java', facts: ['B'] }
    });

    const a2 = contentDigest('class A { int changed; }');
    const keyA2 = c1ArtifactKey({
      content_digest: a2,
      provider_id: 'builtin-java',
      provider_version: 'lexical-v1'
    });
    assert.notEqual(keyA1, keyA2);

    const unrelated = await store.getArtifact({
      tier: 'C1',
      key: keyB1,
      expectedDependencies: [{ kind: 'content', id: b1 }]
    });
    assert.equal(unrelated.hit, true);
    assert.deepEqual(unrelated.artifact.payload.facts, ['B']);

    const oldAWithNewDependency = await store.getArtifact({
      tier: 'C1',
      key: keyA1,
      expectedDependencies: [{ kind: 'content', id: a2 }]
    });
    assert.equal(oldAWithNewDependency.hit, false);
    assert.equal(oldAWithNewDependency.reason, 'DEPENDENCY_MISMATCH');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('CORE-owned cache and session storage refuse writes inside target repository', async () => {
  const target = await tempRoot('kneekura-target-readonly-');
  const forbidden = path.join(target, '.kneekura-core');
  try {
    assert.throws(
      () => createCacheStore({
        storageRoot: forbidden,
        targetRepositoryRoot: target
      }),
      /must not be inside the target repository/
    );
    assert.throws(
      () => createSessionStore({
        storageRoot: forbidden,
        targetRepositoryRoot: target
      }),
      /must not be inside the target repository/
    );
    await assert.rejects(fs.access(forbidden));
  } finally {
    await fs.rm(target, { recursive: true, force: true });
  }
});

test('append-only session event chain detects tampering', () => {
  const first = createSessionEvent({
    sequence: 1,
    type: 'SESSION_STARTED',
    payload: { session_id: 'session:test' },
    timestamp: '2026-01-01T00:00:00.000Z'
  });
  const second = createSessionEvent({
    sequence: 2,
    type: 'SNAPSHOT_FROZEN',
    payload: { snapshot_id: 'snapshot:test' },
    previousDigest: first.event_digest,
    timestamp: '2026-01-01T00:00:01.000Z'
  });
  assert.equal(verifyEventChain([first, second]), true);

  const tampered = structuredClone(second);
  tampered.payload.snapshot_id = 'snapshot:tampered';
  assert.throws(
    () => verifyEventChain([first, tampered]),
    /event digest mismatch/
  );
});

test('session replay reproduces terminal coverage and claims', async () => {
  const coreRoot = await tempRoot('kneekura-session-core-');
  const targetRoot = await tempRoot('kneekura-session-target-');
  try {
    const store = createSessionStore({
      storageRoot: coreRoot,
      targetRepositoryRoot: targetRoot
    });
    await store.startSession({
      sessionId: 'session:replay',
      targetSnapshotId: 'snapshot:1',
      normalizedRequest: { mode: 'DIAGNOSE', seeds: ['A'] },
      engineFingerprint: 'engine:v1',
      ruleFingerprints: ['rules:v1']
    });
    await store.append('session:replay', 'SNAPSHOT_FROZEN', {
      snapshot: { snapshot_id: 'snapshot:1', kind: 'WORKSPACE' }
    });
    await store.append('session:replay', 'SCOPE_DECISION', {
      decision: { id: 'scope:A', reason: 'seed' }
    });
    await store.append('session:replay', 'EVIDENCE_STORED', {
      evidence_ids: ['evidence:1']
    });
    const proposed = {
      id: 'claim:1',
      type: 'INFERRED',
      status: 'PROPOSED',
      evidence_links: []
    };
    const verified = {
      ...proposed,
      status: 'VERIFIED'
    };
    await store.append('session:replay', 'CLAIM_PROPOSED', { claim: proposed });
    await store.append('session:replay', 'CLAIM_VERIFIED', { claim: verified });
    const coverage = {
      schema: 'core.coverage/v1',
      completeness: 'COMPLETE',
      snapshot_id: 'snapshot:1',
      entries: [{ id: 'scope:A', role: 'PRIMARY', status: 'ANALYZED' }]
    };
    await store.append('session:replay', 'COVERAGE_CHANGED', { coverage });
    await store.append('session:replay', 'METRICS_UPDATED', {
      metrics: {
        provider_acquisitions: 2,
        cache_hits: 1
      }
    });
    await store.append('session:replay', 'SESSION_FINALIZED', {
      coverage,
      claims: [verified]
    });

    const events = await store.readEvents('session:replay');
    const replayed = replaySessionEvents(events);
    const materialized = await store.writeMaterializedState('session:replay');

    assert.equal(replayed.session_id, 'session:replay');
    assert.equal(replayed.target_snapshot_id, 'snapshot:1');
    assert.equal(replayed.finalized, true);
    assert.deepEqual(replayed.coverage, coverage);
    assert.deepEqual(replayed.claims['claim:1'], verified);
    assert.equal(replayed.metrics.provider_acquisitions, 2);
    assert.equal(replayed.metrics.cache_hits, 1);
    assert.deepEqual(materialized, replayed);
  } finally {
    await fs.rm(coreRoot, { recursive: true, force: true });
    await fs.rm(targetRoot, { recursive: true, force: true });
  }
});

test('same snapshot rerun reuses deterministic provider results without re-acquisition', async () => {
  const exploration = createExplorationLedger();

  const first = await scanRepository(FORGE_FIXTURE, {
    explorationLedger: exploration
  });
  const acquiredAfterFirst = exploration.metrics.provider_acquisitions;
  const reusedAfterFirst = exploration.metrics.provider_reuse_count;
  assert.ok(acquiredAfterFirst > 0);
  assert.equal(reusedAfterFirst, 0);

  const second = await scanRepository(FORGE_FIXTURE, {
    explorationLedger: exploration
  });

  assert.equal(exploration.metrics.provider_acquisitions, acquiredAfterFirst);
  assert.ok(exploration.metrics.provider_reuse_count >= acquiredAfterFirst);
  assert.equal(second.meta.snapshot.snapshot_id, first.meta.snapshot.snapshot_id);
  assert.equal(second.nodes.length, first.nodes.length);
  assert.equal(second.edges.length, first.edges.length);
  assert.deepEqual(second.meta.counts, first.meta.counts);
  assert.equal(
    second.meta.providerResults.every(result => result.reused === true),
    true
  );
});

test('higher fidelity request does not reuse insufficient exploration acquisition', () => {
  const exploration = createExplorationLedger({ snapshotId: 'snapshot:1' });
  recordProviderAcquisition(exploration, {
    providerId: 'fixture-provider',
    providerVersion: 'v1',
    dependencyFingerprint: 'sha256:' + '1'.repeat(64),
    fidelity: 1,
    result: {
      provider: { id: 'fixture-provider', version: 'v1' },
      dependency_fingerprint: 'sha256:' + '1'.repeat(64),
      evidence: [{ id: 'evidence:low' }]
    }
  });

  const low = findReusableAcquisition(exploration, {
    providerId: 'fixture-provider',
    providerVersion: 'v1',
    dependencyFingerprint: 'sha256:' + '1'.repeat(64),
    requiredFidelity: 1,
    targetSnapshotId: 'snapshot:1'
  });
  assert.ok(low);

  const high = findReusableAcquisition(exploration, {
    providerId: 'fixture-provider',
    providerVersion: 'v1',
    dependencyFingerprint: 'sha256:' + '1'.repeat(64),
    requiredFidelity: 2,
    targetSnapshotId: 'snapshot:1'
  });
  assert.equal(high, null);
});

test('cross-snapshot continuation invalidates stale dependent claims', () => {
  const coverageFingerprint = 'sha256:' + 'c'.repeat(64);
  const parent = {
    session_id: 'session:parent',
    target_snapshot_id: 'snapshot:old',
    evidence_ids: ['evidence:stable','evidence:changed'],
    claims: {
      'claim:stable': {
        id: 'claim:stable',
        coverage_ref: 'coverage:' + coverageFingerprint,
        evidence_links: [{ evidence_id: 'evidence:stable' }],
        counterevidence_links: [],
        verifier_results: []
      },
      'claim:changed': {
        id: 'claim:changed',
        coverage_ref: 'coverage:' + coverageFingerprint,
        evidence_links: [{ evidence_id: 'evidence:changed' }],
        counterevidence_links: [],
        verifier_results: []
      }
    }
  };

  const continuation = planSessionContinuation({
    parentSession: parent,
    targetSnapshotId: 'snapshot:new',
    availableEvidenceIds: ['evidence:stable'],
    currentCoverageFingerprint: coverageFingerprint
  });

  assert.equal(continuation.parent_session_id, 'session:parent');
  assert.equal(continuation.target_snapshot_id, 'snapshot:new');
  assert.deepEqual(continuation.reused_evidence_ids, ['evidence:stable']);
  assert.deepEqual(continuation.invalidated_evidence_ids, ['evidence:changed']);
  assert.deepEqual(continuation.reusable_claim_ids, ['claim:stable']);
  assert.equal(continuation.invalidated_claims[0].claim_id, 'claim:changed');
  assert.equal(
    continuation.invalidated_claims[0].reasons[0].code,
    'EVIDENCE_INVALIDATED'
  );
});

test('cross-snapshot reuse rejects path-only evidence identity', () => {
  const continuation = {
    schema: 'core.session-continuation/v1',
    reused_evidence_ids: ['evidence:path-only']
  };
  const parent = {
    evidence_records: [{
      id: 'evidence:path-only',
      provenance: { path: 'src/A.java' }
    }]
  };
  assert.throws(
    () => assertNoPathOnlyReuse(continuation, parent),
    /cannot rely on path alone/
  );
});


test('cross-snapshot continuation invalidates claims when engine or rules are not proven compatible', () => {
  const coverageFingerprint = 'sha256:' + 'd'.repeat(64);
  const parent = {
    session_id: 'session:engine-parent',
    target_snapshot_id: 'snapshot:old',
    engine_fingerprint: 'engine:v1',
    rule_fingerprints: ['rules:v1'],
    evidence_ids: ['evidence:stable'],
    claims: {
      'claim:stable': {
        id: 'claim:stable',
        coverage_ref: 'coverage:' + coverageFingerprint,
        evidence_links: [{ evidence_id: 'evidence:stable' }],
        counterevidence_links: [],
        verifier_results: []
      }
    }
  };

  const missingCompatibility = planSessionContinuation({
    parentSession: parent,
    targetSnapshotId: 'snapshot:new',
    availableEvidenceIds: ['evidence:stable'],
    currentCoverageFingerprint: coverageFingerprint
  });
  assert.deepEqual(missingCompatibility.reusable_claim_ids, []);
  assert.equal(
    missingCompatibility.invalidated_claims[0].reasons.some(reason =>
      reason.code === 'ENGINE_DEPENDENCY_UNVERIFIED'
    ),
    true
  );
  assert.equal(
    missingCompatibility.invalidated_claims[0].reasons.some(reason =>
      reason.code === 'RULESET_DEPENDENCIES_UNVERIFIED'
    ),
    true
  );

  const compatible = planSessionContinuation({
    parentSession: parent,
    targetSnapshotId: 'snapshot:new',
    availableEvidenceIds: ['evidence:stable'],
    currentCoverageFingerprint: coverageFingerprint,
    currentEngineFingerprint: 'engine:v1',
    currentRuleFingerprints: ['rules:v1']
  });
  assert.deepEqual(compatible.reusable_claim_ids, ['claim:stable']);
});


test('persisted Exploration Ledger resumes same-snapshot provider reuse after reload', async () => {
  const coreRoot = await tempRoot('kneekura-exploration-persist-');
  try {
    const sessionStore = createSessionStore({
      storageRoot: coreRoot,
      targetRepositoryRoot: FORGE_FIXTURE
    });
    await sessionStore.startSession({
      sessionId: 'session:persisted-exploration'
    });

    const firstLedger = createExplorationLedger();
    const firstGraph = await scanRepository(FORGE_FIXTURE, {
      explorationLedger: firstLedger
    });
    const acquired = firstLedger.metrics.provider_acquisitions;
    assert.ok(acquired > 0);

    await sessionStore.writeExplorationLedger(
      'session:persisted-exploration',
      firstLedger
    );
    const restored = await sessionStore.readExplorationLedger(
      'session:persisted-exploration',
      { targetSnapshotId: firstGraph.meta.snapshot.snapshot_id }
    );

    const secondGraph = await scanRepository(FORGE_FIXTURE, {
      explorationLedger: restored
    });

    assert.equal(restored.metrics.provider_acquisitions, acquired);
    assert.ok(restored.metrics.provider_reuse_count >= acquired);
    assert.equal(secondGraph.meta.snapshot.snapshot_id, firstGraph.meta.snapshot.snapshot_id);
    assert.equal(secondGraph.nodes.length, firstGraph.nodes.length);
    assert.equal(secondGraph.edges.length, firstGraph.edges.length);
  } finally {
    await fs.rm(coreRoot, { recursive: true, force: true });
  }
});


test('finalized session is sealed against later event appends', async () => {
  const coreRoot = await tempRoot('kneekura-session-seal-');
  try {
    const store = createSessionStore({ storageRoot: coreRoot });
    await store.startSession({ sessionId: 'session:sealed' });
    await store.append('session:sealed', 'SESSION_FINALIZED', {});
    await assert.rejects(
      () => store.append('session:sealed', 'SCOPE_DECISION', {
        decision: { id: 'too-late' }
      }),
      /cannot append events after SESSION_FINALIZED/
    );
  } finally {
    await fs.rm(coreRoot, { recursive: true, force: true });
  }
});

test('child session state persists reused and invalidated evidence IDs', async () => {
  const coreRoot = await tempRoot('kneekura-child-session-');
  try {
    const store = createSessionStore({ storageRoot: coreRoot });
    await store.startSession({
      sessionId: 'session:child',
      parentSessionId: 'session:parent',
      targetSnapshotId: 'snapshot:new',
      reusedEvidenceIds: ['evidence:b', 'evidence:a', 'evidence:a'],
      invalidatedEvidenceIds: ['evidence:old']
    });

    const state = await store.replay('session:child');
    assert.equal(state.parent_session_id, 'session:parent');
    assert.equal(state.target_snapshot_id, 'snapshot:new');
    assert.deepEqual(state.reused_evidence_ids, ['evidence:a', 'evidence:b']);
    assert.deepEqual(state.evidence_ids, ['evidence:a', 'evidence:b']);
    assert.deepEqual(state.invalidated_evidence_ids, ['evidence:old']);
  } finally {
    await fs.rm(coreRoot, { recursive: true, force: true });
  }
});

test('provider acquisition and reuse metrics replay from session events', async () => {
  const coreRoot = await tempRoot('kneekura-session-metrics-');
  try {
    const sessionId = 'session:metrics';
    const store = createSessionStore({
      storageRoot: coreRoot,
      targetRepositoryRoot: FORGE_FIXTURE
    });
    await store.startSession({ sessionId });
    const exploration = createExplorationLedger();
    const onSessionEvent = (type, payload) =>
      store.append(sessionId, type, payload);

    const first = await scanRepository(FORGE_FIXTURE, {
      explorationLedger: exploration,
      onSessionEvent
    });
    await store.append(sessionId, 'SNAPSHOT_FROZEN', {
      snapshot: first.meta.snapshot
    });

    await scanRepository(FORGE_FIXTURE, {
      explorationLedger: exploration,
      onSessionEvent
    });

    const state = await store.replay(sessionId);
    assert.ok(state.metrics.provider_acquisitions > 0);
    assert.equal(
      state.metrics.provider_acquisitions,
      exploration.metrics.provider_acquisitions
    );
    assert.ok(state.metrics.provider_reuse_count > 0);
    assert.equal(
      state.metrics.provider_reuse_count,
      exploration.metrics.provider_reuse_count
    );
    assert.equal(state.metrics.cache_hits, exploration.metrics.cache_hits);
    assert.equal(state.metrics.cache_misses, exploration.metrics.cache_misses);
  } finally {
    await fs.rm(coreRoot, { recursive: true, force: true });
  }
});

test('duplicate dependency declarations do not perturb cache identity', () => {
  const digest = contentDigest('class Stable {}');
  const once = c1ArtifactKey({
    content_digest: digest,
    provider_id: 'builtin-java',
    provider_version: 'lexical-v1',
    dependencies: [{ kind: 'config', id: 'java:v1' }]
  });
  const duplicated = c1ArtifactKey({
    content_digest: digest,
    provider_id: 'builtin-java',
    provider_version: 'lexical-v1',
    dependencies: [
      { kind: 'config', id: 'java:v1' },
      { id: 'java:v1', kind: 'config' }
    ]
  });
  assert.equal(once, duplicated);
});


test('concurrent session appends are serialized into a valid hash chain', async () => {
  const coreRoot = await tempRoot('kneekura-session-concurrent-');
  try {
    const store = createSessionStore({ storageRoot: coreRoot });
    const sessionId = 'session:concurrent';
    await store.startSession({ sessionId });

    await Promise.all(
      Array.from({ length: 24 }, (_, index) =>
        store.append(sessionId, 'SCOPE_DECISION', {
          decision: { id: 'scope:' + index }
        })
      )
    );

    const events = await store.readEvents(sessionId);
    assert.equal(events.length, 25);
    assert.equal(verifyEventChain(events), true);
    assert.deepEqual(
      new Set(events.slice(1).map(event => event.payload.decision.id)),
      new Set(Array.from({ length: 24 }, (_, index) => 'scope:' + index))
    );
  } finally {
    await fs.rm(coreRoot, { recursive: true, force: true });
  }
});

test('cross-snapshot provider-result reuse is rejected even when caller opts in', () => {
  const exploration = createExplorationLedger({ snapshotId: 'snapshot:old' });
  recordProviderAcquisition(exploration, {
    providerId: 'fixture-provider',
    providerVersion: 'v1',
    dependencyFingerprint: 'sha256:' + '1'.repeat(64),
    cacheFingerprint: 'sha256:' + '2'.repeat(64),
    cacheScope: 'CONTENT',
    fidelity: 2,
    result: {
      provider: { id: 'fixture-provider', version: 'v1' },
      dependency_fingerprint: 'sha256:' + '1'.repeat(64),
      evidence: [{ id: 'evidence:old-snapshot' }]
    },
    snapshotId: 'snapshot:old'
  });

  assert.throws(
    () => findReusableAcquisition(exploration, {
      providerId: 'fixture-provider',
      providerVersion: 'v1',
      dependencyFingerprint: 'sha256:' + '3'.repeat(64),
      cacheFingerprint: 'sha256:' + '2'.repeat(64),
      requiredFidelity: 1,
      allowCrossSnapshot: true,
      targetSnapshotId: 'snapshot:new'
    }),
    /cross-snapshot provider-result reuse is forbidden/
  );
});

test('continuation exposes machine-counted invalidation reasons for session metrics', () => {
  const coverageFingerprint = 'sha256:' + 'e'.repeat(64);
  const parent = {
    session_id: 'session:metric-parent',
    target_snapshot_id: 'snapshot:old',
    evidence_ids: ['evidence:gone'],
    claims: {
      'claim:gone': {
        id: 'claim:gone',
        coverage_ref: 'coverage:' + coverageFingerprint,
        evidence_links: [{ evidence_id: 'evidence:gone' }],
        counterevidence_links: [],
        verifier_results: []
      }
    }
  };

  const continuation = planSessionContinuation({
    parentSession: parent,
    targetSnapshotId: 'snapshot:new',
    availableEvidenceIds: [],
    currentCoverageFingerprint: coverageFingerprint
  });

  assert.equal(
    continuation.metrics_delta.invalidation_reasons.EVIDENCE_INVALIDATED,
    1
  );
  assert.equal(
    continuation.metrics_delta.invalidation_reasons.EVIDENCE_NOT_AVAILABLE,
    1
  );
});

test('cache content identity rejects ambiguous object coercion', async () => {
  assert.throws(
    () => contentDigest({ source: 'class A {}' }),
    /content digest input must be a string, Buffer, or Uint8Array/
  );

  const root = await tempRoot('kneekura-cache-bytes-');
  try {
    const store = createCacheStore({ storageRoot: root });
    await assert.rejects(
      () => store.putBlob({ source: 'class A {}' }),
      /C0 blob input must be a string, Buffer, or Uint8Array/
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('cache reuse ignores informational metadata differences for identical artifact identity', async () => {
  const root = await tempRoot('kneekura-cache-metadata-');
  try {
    const store = createCacheStore({ storageRoot: root });
    const digest = contentDigest('class MetadataStable {}');
    const key = c1ArtifactKey({
      content_digest: digest,
      provider_id: 'builtin-java',
      provider_version: 'lexical-v1'
    });
    const dependencies = [{ kind: 'content', id: digest }];

    const first = await store.putArtifact({
      tier: 'C1',
      key,
      dependencies,
      payload: { facts: ['stable'] },
      metadata: { note: 'first writer' }
    });
    const second = await store.putArtifact({
      tier: 'C1',
      key,
      dependencies,
      payload: { facts: ['stable'] },
      metadata: { note: 'later observer' }
    });

    assert.equal(first.reused, false);
    assert.equal(second.reused, true);
    assert.deepEqual(second.artifact.payload, { facts: ['stable'] });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});


test('persisted C1 artifact payload tampering is detected before reuse', async () => {
  const root = await tempRoot('kneekura-cache-tamper-');
  try {
    const store = createCacheStore({ storageRoot: root });
    const digest = contentDigest('class TamperTarget {}');
    const key = c1ArtifactKey({
      content_digest: digest,
      provider_id: 'builtin-java',
      provider_version: 'lexical-v1'
    });
    const dependencies = [{ kind: 'content', id: digest }];
    await store.putArtifact({
      tier: 'C1',
      key,
      dependencies,
      payload: { facts: ['original'] }
    });

    const file = path.join(
      root, 'cache', 'C1',
      Buffer.from(key).toString('base64url') + '.json'
    );
    const stored = JSON.parse(await fs.readFile(file, 'utf8'));
    stored.payload.facts = ['tampered'];
    await fs.writeFile(file, JSON.stringify(stored, null, 2) + '\n', 'utf8');

    await assert.rejects(
      () => store.getArtifact({ tier: 'C1', key, expectedDependencies: dependencies }),
      /cache artifact content digest mismatch/
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('persisted Exploration Ledger tampering is detected before restore', async () => {
  const root = await tempRoot('kneekura-exploration-tamper-');
  try {
    const store = createSessionStore({ storageRoot: root });
    const sessionId = 'session:exploration-tamper';
    await store.startSession({ sessionId });

    const exploration = createExplorationLedger({ snapshotId: 'snapshot:1' });
    recordProviderAcquisition(exploration, {
      providerId: 'fixture-provider',
      providerVersion: 'v1',
      dependencyFingerprint: 'sha256:' + '1'.repeat(64),
      fidelity: 1,
      result: {
        provider: { id: 'fixture-provider', version: 'v1' },
        dependency_fingerprint: 'sha256:' + '1'.repeat(64),
        evidence: [{ id: 'evidence:fixture' }]
      },
      snapshotId: 'snapshot:1'
    });
    await store.writeExplorationLedger(sessionId, exploration);

    const file = path.join(
      root, 'sessions',
      Buffer.from(sessionId).toString('base64url'),
      'exploration.json'
    );
    const envelope = JSON.parse(await fs.readFile(file, 'utf8'));
    envelope.ledger.acquisitions[0].fidelity = 99;
    await fs.writeFile(file, JSON.stringify(envelope, null, 2) + '\n', 'utf8');

    await assert.rejects(
      () => store.readExplorationLedger(sessionId),
      /exploration snapshot digest mismatch/
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Exploration Ledger rejects provider identity and dependency mismatches', () => {
  const exploration = createExplorationLedger({ snapshotId: 'snapshot:1' });
  assert.throws(
    () => recordProviderAcquisition(exploration, {
      providerId: 'expected-provider',
      providerVersion: 'v1',
      dependencyFingerprint: 'sha256:' + '1'.repeat(64),
      fidelity: 1,
      result: {
        provider: { id: 'different-provider', version: 'v1' },
        dependency_fingerprint: 'sha256:' + '1'.repeat(64),
        evidence: []
      },
      snapshotId: 'snapshot:1'
    }),
    /provider result identity mismatch/
  );
  assert.throws(
    () => recordProviderAcquisition(exploration, {
      providerId: 'expected-provider',
      providerVersion: 'v1',
      dependencyFingerprint: 'sha256:' + '1'.repeat(64),
      fidelity: 1,
      result: {
        provider: { id: 'expected-provider', version: 'v1' },
        dependency_fingerprint: 'sha256:' + '2'.repeat(64),
        evidence: []
      },
      snapshotId: 'snapshot:1'
    }),
    /provider result dependency fingerprint mismatch/
  );
});

test('same-snapshot reuse requires explicit matching stored snapshot when target is known', () => {
  const exploration = createExplorationLedger();
  recordProviderAcquisition(exploration, {
    providerId: 'fixture-provider',
    providerVersion: 'v1',
    dependencyFingerprint: 'sha256:' + '1'.repeat(64),
    fidelity: 1,
    result: {
      provider: { id: 'fixture-provider', version: 'v1' },
      dependency_fingerprint: 'sha256:' + '1'.repeat(64),
      evidence: []
    },
    snapshotId: null
  });
  const reused = findReusableAcquisition(exploration, {
    providerId: 'fixture-provider',
    providerVersion: 'v1',
    dependencyFingerprint: 'sha256:' + '1'.repeat(64),
    targetSnapshotId: 'snapshot:known'
  });
  assert.equal(reused, null);
});

test('session lifecycle validation requires one start and terminal finalize', () => {
  const wrongFirst = createSessionEvent({
    sequence: 1,
    type: 'SCOPE_DECISION',
    payload: { decision: { id: 'scope:first' } },
    timestamp: '2026-01-01T00:00:00.000Z'
  });
  assert.throws(
    () => verifyEventChain([wrongFirst]),
    /must begin with SESSION_STARTED/
  );

  const start = createSessionEvent({
    sequence: 1,
    type: 'SESSION_STARTED',
    payload: { session_id: 'session:lifecycle' },
    timestamp: '2026-01-01T00:00:00.000Z'
  });
  const finalized = createSessionEvent({
    sequence: 2,
    type: 'SESSION_FINALIZED',
    payload: {},
    previousDigest: start.event_digest,
    timestamp: '2026-01-01T00:00:01.000Z'
  });
  const afterFinalize = createSessionEvent({
    sequence: 3,
    type: 'SCOPE_DECISION',
    payload: { decision: { id: 'scope:late' } },
    previousDigest: finalized.event_digest,
    timestamp: '2026-01-01T00:00:02.000Z'
  });
  assert.throws(
    () => verifyEventChain([start, finalized, afterFinalize]),
    /SESSION_FINALIZED must be the final event/
  );
});


test('in-memory Exploration Ledger acquisition tampering is detected before reuse', () => {
  const exploration = createExplorationLedger({ snapshotId: 'snapshot:1' });
  recordProviderAcquisition(exploration, {
    providerId: 'fixture-provider',
    providerVersion: 'v1',
    dependencyFingerprint: 'sha256:' + '1'.repeat(64),
    fidelity: 2,
    result: {
      provider: { id: 'fixture-provider', version: 'v1' },
      dependency_fingerprint: 'sha256:' + '1'.repeat(64),
      evidence: [{ id: 'evidence:stable' }],
      graph_fragment: {
        nodes: [{ id: 'node:1', kind: 'class', key: 'Stable', label: 'Stable' }],
        edges: []
      }
    },
    snapshotId: 'snapshot:1'
  });

  exploration.acquisitions[0].provider_result.graph_fragment.nodes[0].label = 'tampered';

  assert.throws(
    () => findReusableAcquisition(exploration, {
      providerId: 'fixture-provider',
      providerVersion: 'v1',
      dependencyFingerprint: 'sha256:' + '1'.repeat(64),
      requiredFidelity: 1,
      targetSnapshotId: 'snapshot:1'
    }),
    /exploration acquisition content digest mismatch/
  );
});
