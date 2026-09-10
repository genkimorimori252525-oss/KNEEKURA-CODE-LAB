import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';

import {
  ANALYSIS_REQUEST_SCHEMA,
  ENGINE_IDS,
  ENGINE_RUN_RECEIPT_SCHEMA,
  createEngineRunReceipt,
  routeKneekuraCodeLabRequest
} from '../src/skill/index.mjs';
import { readEngineLock } from '../src/skill/engine-lock.mjs';

test('umbrella router exposes exactly three engines and has no hidden default', () => {
  assert.deepEqual(ENGINE_IDS, ['kneekura', 'understand-anything', 'archify']);
  const decision = routeKneekuraCodeLabRequest({});
  assert.equal(decision.kind, 'SELECTION_REQUIRED');
  assert.equal(decision.request.schema, ANALYSIS_REQUEST_SCHEMA);
  assert.deepEqual(decision.choices, ENGINE_IDS);
});

test('explicit selection and all mode never expand silently', () => {
  assert.deepEqual(routeKneekuraCodeLabRequest({ selection: 'archify' }).requestedEngines, ['archify']);
  assert.deepEqual(routeKneekuraCodeLabRequest({ selection: 'understand-anything' }).requestedEngines, ['understand-anything']);
  assert.deepEqual(routeKneekuraCodeLabRequest({ selection: 'kneekura' }).requestedEngines, ['kneekura']);
  assert.deepEqual(routeKneekuraCodeLabRequest({ selection: 'all' }).requestedEngines, ENGINE_IDS);
  assert.throws(() => routeKneekuraCodeLabRequest({ selection: 'other-engine' }));
});

test('engine receipt keeps origin, orchestration, status, claim and coverage independent', () => {
  const receipt = createEngineRunReceipt({
    engineId: 'archify',
    implementationOrigin: 'pinned-upstream',
    implementationVersion: '2.16.0',
    orchestrationMode: 'native',
    snapshotId: 'snapshot:sha256:abc',
    scopeDigest: 'sha256:def',
    attemptId: 'attempt-1',
    status: 'PARTIAL',
    claimLevel: 'NATIVE',
    minimumClaimLevel: 'NATIVE',
    claimSatisfied: false,
    acceptance: { deliver: true, browserSecurity: false },
    coverage: { completeness: 'PARTIAL' }
  });
  assert.equal(receipt.schema, ENGINE_RUN_RECEIPT_SCHEMA);
  assert.equal(receipt.implementationOrigin, 'pinned-upstream');
  assert.equal(receipt.orchestrationMode, 'native');
  assert.equal(receipt.status, 'PARTIAL');
  assert.equal(receipt.claimLevel, 'NATIVE');
  assert.equal(receipt.claimSatisfied, false);
  assert.deepEqual(receipt.acceptance, { deliver: true, browserSecurity: false });
  assert.deepEqual(receipt.coverage, { completeness: 'PARTIAL' });
});

test('engine lock is production-owned and pins stable immutable upstream identities', async () => {
  const lock = await readEngineLock();
  assert.equal(lock.product.authorityRepository, 'genkimorimori252525-oss/KNEEKURA-CODE-LAB');

  const ua = lock.engines['understand-anything'];
  assert.equal(ua.release, 'v2.9.0');
  assert.equal(ua.version, '2.9.0');
  assert.equal(ua.commit, 'f08763d11d0202a8a8f52b5dedda6d1b2e2ebac8');
  assert.equal(ua.packageManifest.value, 'e06bc5863abcafdd9c4108e34cbbf5fd6448cedf');
  assert.equal(ua.lockfile.value, 'fd4cf7539627856d6b166c39dc1041165fa2ce87');
  assert.equal(ua.license.value, '5df102e8a2e29cdfb881ae7ec5040f2766564680');
  assert.match(ua.viewerReleaseArtifact.value, /^[0-9a-f]{64}$/);

  const archify = lock.engines.archify;
  assert.equal(archify.release, 'v2.16.0');
  assert.equal(archify.version, '2.16.0');
  assert.equal(archify.commit, 'c826e6c3a7abad19c0f3cd1ca57207d54b1ad8de');
  assert.equal(archify.skillTree.value, 'a198a3e0d03cd08eb582062a52dc4b0bd5b0aa4f');
  assert.equal(archify.packageManifest.value, 'f727bdb17214de090d5ba6b1100ad135b8491585');
  assert.equal(archify.lockfile.value, 'fe4d05f9c3f1c9ff0fb81e5a46653015cd48e081');
  assert.equal(archify.license.value, '4c27b7152c7e4593dfdd153761ce178177d30464');
  assert.equal(archify.releaseArtifact.value, '4c59fa6557a2385beaaef8c7219cc414573acc9f0c30a932d5053b0b20689a46');
});

test('distribution currently exposes only the umbrella Skill contract', async () => {
  const skill = await fs.readFile(new URL('../skills/kneekura-code-lab/SKILL.md', import.meta.url), 'utf8');
  assert.match(skill, /name: kneekura-code-lab/);
  assert.match(skill, /three evidence-isolated engines/);
  assert.match(skill, /no hidden default/i);
  assert.match(skill, /BLOCKED_UNSAFE_HOST/);
});