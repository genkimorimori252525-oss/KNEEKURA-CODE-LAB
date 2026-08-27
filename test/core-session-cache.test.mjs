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
