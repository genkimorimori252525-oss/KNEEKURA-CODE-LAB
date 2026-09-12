import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import * as skill from '../src/skill/index.mjs';

const SNAPSHOT = `snapshot:sha256:${'a'.repeat(64)}`;
const SCOPE = `sha256:${'b'.repeat(64)}`;
const ASSURANCE = 'OPERATOR_SEPARATED_HOST_SESSION_V1';
const ENGINES = ['kneekura', 'understand-anything', 'archify'];

function required(name) {
  const value = skill[name];
  if (typeof value === 'function') return value;
  return () => assert.fail(`${name} is not implemented`);
}

const composeSealedAllModeBundle = required('composeSealedAllModeBundle');

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function outcome(engineId, overrides = {}) {
  const bytes = Buffer.from(`sealed:${engineId}`, 'utf8');
  const digest = sha256(bytes);
  const kind = {
    kneekura: 'KNEEKURA_HUMAN_EXPLORER_ZIP',
    'understand-anything': 'UA_SKILL_ZIP',
    archify: 'ARCHIFY_SKILL_ZIP'
  }[engineId];
  const attemptId = `attempt-fixture-${engineId}`;
  const receipt = skill.createEngineRunReceipt({
    engineId,
    implementationOrigin: engineId === 'kneekura' ? 'first-party' : 'pinned-upstream',
    implementationVersion: 'fixture',
    orchestrationMode: 'native',
    snapshotId: overrides.snapshotId ?? SNAPSHOT,
    scopeDigest: overrides.scopeDigest ?? SCOPE,
    attemptId,
    status: overrides.status ?? 'SUCCESS',
    claimLevel: 'NATIVE',
    claimSatisfied: overrides.claimSatisfied ?? true,
    acceptance: { fixture: true },
    coverage: { files: 3, engine: engineId },
    artifacts: [{ kind, digest, bytes: bytes.length }],
    warnings: [],
    errors: []
  });
  return {
    engine_id: engineId,
    attempt_id: attemptId,
    semantic_context_id: `local-context-${engineId}`,
    receipt,
    sealed_bytes: bytes,
    sealed_artifact: { digest, bytes: bytes.length },
    error: null
  };
}

function contexts() {
  return ENGINES.map((engineId, index) => ({
    engine_id: engineId,
    host_context_id: `host-context-${index + 1}`,
    assurance_class: ASSURANCE,
    child_issue_number: 301 + index
  }));
}

test('sealed composer creates metadata-only ALL comparison from exactly three verified engine artifacts', () => {
  const result = composeSealedAllModeBundle({
    runId: 'parent-all-run',
    snapshotId: SNAPSHOT,
    scopeDigest: SCOPE,
    outcomes: ENGINES.map(engineId => outcome(engineId)),
    contextMetadata: contexts()
  });

  assert.equal(result.kind, 'ALL_MODE_BUNDLE');
  assert.equal(result.status, 'SUCCESS');
  assert.equal(result.snapshotId, SNAPSHOT);
  assert.equal(result.scopeDigest, SCOPE);
  assert.equal(result.comparison.semantic_fusion, false);
  assert.equal(result.comparison.canonical_truth_promotion, false);
  assert.equal(result.comparison.engine_substitution, false);
  assert.deepEqual(result.outcomes.map(row => row.engine_id), ENGINES);
  assert.ok(result.outcomes.every(row => row.status === 'SUCCESS' && row.claim_satisfied === true));
  assert.ok(result.outcomes.every(row => row.sealed_artifact?.digest?.startsWith('sha256:')));
  assert.deepEqual(
    result.runManifest.semantic_contexts.map(row => row.host_context_id),
    ['host-context-1', 'host-context-2', 'host-context-3']
  );
  assert.ok(Buffer.isBuffer(result.bundleZip));
  assert.match(result.bundleZipDigest, /^sha256:[0-9a-f]{64}$/);
});

test('sealed composer is deterministic for identical verified bytes and metadata', () => {
  const input = {
    runId: 'parent-all-run',
    snapshotId: SNAPSHOT,
    scopeDigest: SCOPE,
    outcomes: ENGINES.map(engineId => outcome(engineId)),
    contextMetadata: contexts()
  };
  const first = composeSealedAllModeBundle(input);
  const second = composeSealedAllModeBundle({
    ...input,
    outcomes: ENGINES.map(engineId => outcome(engineId)),
    contextMetadata: contexts()
  });
  assert.equal(first.bundleZipDigest, second.bundleZipDigest);
  assert.deepEqual(first.bundleZip, second.bundleZip);
});

test('sealed composer rejects missing or substituted engine slots', () => {
  assert.throws(
    () => composeSealedAllModeBundle({
      runId: 'parent-all-run', snapshotId: SNAPSHOT, scopeDigest: SCOPE,
      outcomes: [outcome('kneekura'), outcome('archify')]
    }),
    error => error?.code === 'ALL_MODE_ENGINE_SET_INVALID'
  );

  assert.throws(
    () => composeSealedAllModeBundle({
      runId: 'parent-all-run', snapshotId: SNAPSHOT, scopeDigest: SCOPE,
      outcomes: [outcome('kneekura'), outcome('archify'), outcome('archify')]
    }),
    error => error?.code === 'ALL_MODE_ENGINE_SET_INVALID'
  );
});

test('sealed composer rejects context collisions and receipt target drift before packaging', () => {
  const duplicateContexts = contexts();
  duplicateContexts[1] = {
    ...duplicateContexts[1],
    host_context_id: duplicateContexts[0].host_context_id
  };
  assert.throws(
    () => composeSealedAllModeBundle({
      runId: 'parent-all-run', snapshotId: SNAPSHOT, scopeDigest: SCOPE,
      outcomes: ENGINES.map(engineId => outcome(engineId)),
      contextMetadata: duplicateContexts
    }),
    error => error?.code === 'BLOCKED_SEMANTIC_CONTEXT_ISOLATION'
  );

  assert.throws(
    () => composeSealedAllModeBundle({
      runId: 'parent-all-run', snapshotId: SNAPSHOT, scopeDigest: SCOPE,
      outcomes: [
        outcome('kneekura'),
        outcome('understand-anything', { snapshotId: `snapshot:sha256:${'9'.repeat(64)}` }),
        outcome('archify')
      ]
    }),
    error => error?.code === 'ALL_MODE_OUTCOME_BINDING_MISMATCH'
  );
});