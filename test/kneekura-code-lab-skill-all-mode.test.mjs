import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import {
  createEngineRunReceipt,
  executeKneekuraCodeLabRequest,
  KNEEKURA_CODE_LAB_COMPARISON_SCHEMA
} from '../src/skill/index.mjs';

const SNAPSHOT = 'snapshot:sha256:all-mode-fixture';
const SCOPE = 'sha256:all-mode-scope';

function makeRunner(engineId, { status = 'SUCCESS', claimSatisfied = true, seen = [] } = {}) {
  return async envelope => {
    seen.push(structuredClone(envelope));
    const bytes = Buffer.from(`sealed:${engineId}`, 'utf8');
    const digest = `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
    const zipKind = {
      kneekura: 'KNEEKURA_HUMAN_EXPLORER_ZIP',
      'understand-anything': 'UA_SKILL_ZIP',
      archify: 'ARCHIFY_SKILL_ZIP'
    }[engineId];
    const receipt = createEngineRunReceipt({
      engineId,
      implementationOrigin: engineId === 'kneekura' ? 'first-party' : 'pinned-upstream',
      implementationVersion: engineId === 'kneekura' ? 'human-explorer-v2' : 'fixture',
      orchestrationMode: 'native',
      snapshotId: envelope.targetSnapshotId,
      scopeDigest: envelope.scopeDigest,
      attemptId: envelope.attemptId,
      status,
      claimLevel: 'NATIVE',
      claimSatisfied,
      acceptance: { fixture: true },
      coverage: { files: 4, note: 'operational metadata only' },
      artifacts: [{ kind: zipKind, digest, bytes: bytes.length }],
      warnings: status === 'PARTIAL' ? ['fixture partial'] : [],
      errors: []
    });
    if (engineId === 'kneekura') return { engineId, receipt, artifact: { zip_bytes: bytes, zip_digest: digest } };
    return { engineId, receipt, deliveryZip: bytes, deliveryZipDigest: digest };
  };
}

test('ambiguous umbrella request exposes choices and executes no engine', async () => {
  let calls = 0;
  const result = await executeKneekuraCodeLabRequest({
    request: {},
    engineRunners: { kneekura: async () => { calls += 1; } }
  });
  assert.equal(result.kind, 'SELECTION_REQUIRED');
  assert.deepEqual(result.choices, ['kneekura', 'understand-anything', 'archify']);
  assert.equal(calls, 0);
});

test('explicit engine request routes directly and never invokes other engines', async () => {
  const seen = { kneekura: 0, ua: 0, archify: [] };
  const result = await executeKneekuraCodeLabRequest({
    request: { selection: 'archify' },
    engineRunners: {
      kneekura: async () => { seen.kneekura += 1; },
      'understand-anything': async () => { seen.ua += 1; },
      archify: makeRunner('archify', { seen: seen.archify })
    },
    targetSnapshotId: SNAPSHOT,
    scopeDigest: SCOPE,
    runId: 'direct-run'
  });
  assert.equal(result.kind, 'ENGINE_RESULT');
  assert.equal(result.requestedEngine, 'archify');
  assert.equal(result.result.engineId, 'archify');
  assert.equal(seen.kneekura, 0);
  assert.equal(seen.ua, 0);
  assert.equal(seen.archify.length, 1);
  assert.equal(seen.archify[0].freshSemanticContextRequired, true);
});

test('all mode runs three sealed engines against one snapshot with fresh attempts and no semantic fusion', async () => {
  const seen = { kneekura: [], ua: [], archify: [] };
  const runners = {
    kneekura: makeRunner('kneekura', { seen: seen.kneekura }),
    'understand-anything': makeRunner('understand-anything', { seen: seen.ua }),
    archify: makeRunner('archify', { seen: seen.archify })
  };
  const first = await executeKneekuraCodeLabRequest({
    request: { selection: 'all' }, engineRunners: runners,
    targetSnapshotId: SNAPSHOT, scopeDigest: SCOPE, runId: 'all-run'
  });
  assert.equal(first.kind, 'ALL_MODE_BUNDLE');
  assert.equal(first.status, 'SUCCESS');
  assert.equal(first.comparison.schema, KNEEKURA_CODE_LAB_COMPARISON_SCHEMA);
  assert.equal(first.comparison.semantic_fusion, false);
  assert.equal(first.comparison.canonical_truth_promotion, false);
  assert.equal(first.comparison.engine_substitution, false);
  assert.deepEqual(first.outcomes.map(row => row.engine_id), ['kneekura', 'understand-anything', 'archify']);
  assert.ok(first.outcomes.every(row => row.status === 'SUCCESS' && row.claim_satisfied === true));
  assert.ok(first.outcomes.every(row => row.sealed_artifact?.digest?.startsWith('sha256:')));
  const contexts = [...seen.kneekura, ...seen.ua, ...seen.archify];
  assert.equal(new Set(contexts.map(row => row.attemptId)).size, 3);
  assert.equal(new Set(contexts.map(row => row.semanticContextId)).size, 3);
  assert.ok(contexts.every(row => row.targetSnapshotId === SNAPSHOT && row.scopeDigest === SCOPE));
  assert.ok(contexts.every(row => row.freshSemanticContextRequired === true));
  assert.equal(JSON.stringify(first.comparison).includes('summary'), false);

  const second = await executeKneekuraCodeLabRequest({
    request: { selection: 'all' },
    engineRunners: {
      kneekura: makeRunner('kneekura'),
      'understand-anything': makeRunner('understand-anything'),
      archify: makeRunner('archify')
    },
    targetSnapshotId: SNAPSHOT, scopeDigest: SCOPE, runId: 'all-run'
  });
  assert.equal(first.bundleZipDigest, second.bundleZipDigest);
  assert.deepEqual(first.bundleZip, second.bundleZip);
});

test('all mode makes a failed requested engine visible without substituting another engine', async () => {
  const result = await executeKneekuraCodeLabRequest({
    request: { selection: 'all' },
    engineRunners: {
      kneekura: makeRunner('kneekura'),
      'understand-anything': async () => { const error = new Error('UA fixture failed'); error.code = 'UA_FIXTURE_FAILED'; throw error; },
      archify: makeRunner('archify')
    },
    targetSnapshotId: SNAPSHOT, scopeDigest: SCOPE, runId: 'failure-run'
  });
  assert.equal(result.status, 'PARTIAL');
  const ua = result.outcomes.find(row => row.engine_id === 'understand-anything');
  assert.equal(ua.status, 'FAILED');
  assert.equal(ua.error.code, 'UA_FIXTURE_FAILED');
  assert.equal(ua.sealed_artifact, null);
  assert.equal(result.comparison.engines.find(row => row.engine_id === 'understand-anything').status, 'FAILED');
  assert.equal(result.outcomes.filter(row => row.engine_id === 'understand-anything').length, 1);
});

test('all mode surfaces PARTIAL receipts and engine identity violations', async () => {
  const partial = await executeKneekuraCodeLabRequest({
    request: { selection: 'all' },
    engineRunners: {
      kneekura: makeRunner('kneekura'),
      'understand-anything': makeRunner('understand-anything', { status: 'PARTIAL', claimSatisfied: false }),
      archify: makeRunner('archify')
    },
    targetSnapshotId: SNAPSHOT, scopeDigest: SCOPE, runId: 'partial-run'
  });
  assert.equal(partial.status, 'PARTIAL');
  assert.equal(partial.outcomes.find(row => row.engine_id === 'understand-anything').status, 'PARTIAL');
  assert.equal(partial.outcomes.find(row => row.engine_id === 'understand-anything').claim_satisfied, false);

  const mismatch = await executeKneekuraCodeLabRequest({
    request: { selection: 'all' },
    engineRunners: {
      kneekura: makeRunner('kneekura'),
      'understand-anything': makeRunner('archify'),
      archify: makeRunner('archify')
    },
    targetSnapshotId: SNAPSHOT, scopeDigest: SCOPE, runId: 'mismatch-run'
  });
  const ua = mismatch.outcomes.find(row => row.engine_id === 'understand-anything');
  assert.equal(ua.status, 'FAILED');
  assert.equal(ua.error.code, 'ENGINE_SUBSTITUTION_FORBIDDEN');
});