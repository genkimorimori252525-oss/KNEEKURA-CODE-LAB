import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import * as relay from '../src/github-relay/index.mjs';
import { createEngineRunReceipt } from '../src/skill/contracts.mjs';
import { createSanitizedReceipt } from '../src/skill/runtime.mjs';

const REVISION = 'a'.repeat(40);
const SNAPSHOT = `snapshot:sha256:${'b'.repeat(64)}`;
const SCOPE = `sha256:${'c'.repeat(64)}`;
const RUNTIME = 'd'.repeat(40);
const LOCK = `sha256:${'e'.repeat(64)}`;
const PARENT_RUN = 'ghr-220-parent';
const PARENT_ISSUE = 220;
const ENGINES = ['kneekura', 'understand-anything', 'archify'];
const ZIP_KIND = {
  kneekura: 'KNEEKURA_HUMAN_EXPLORER_ZIP',
  'understand-anything': 'UA_SKILL_ZIP',
  archify: 'ARCHIFY_SKILL_ZIP'
};

const parentRequest = Object.freeze({
  schema: 'kneekura.code-lab.github-relay-request/v1',
  selection: 'all',
  target: { repository: 'owner/repository', revision: REVISION },
  commonScope: { question: 'explain the exact snapshot independently' },
  engineOptions: {},
  minimumClaimLevel: {},
  semanticContextMode: 'per-engine'
});

const parentPlan = Object.freeze({
  schema: 'kneekura.code-lab.github-relay-plan/v1',
  run_id: PARENT_RUN,
  selection: 'all',
  target: {
    repository: 'owner/repository',
    revision: REVISION,
    snapshot_id: SNAPSHOT,
    scope_digest: SCOPE
  },
  semantic_context_mode: 'per-engine',
  code_lab_revision: RUNTIME,
  engine_lock_digest: LOCK
});

function required(name) {
  const value = relay[name];
  if (typeof value === 'function') return value;
  return () => assert.fail(`${name} is not implemented`);
}

const stageChildResultArtifact = required('stageChildResultArtifact');
const composeVerifiedAllChildResults = required('composeVerifiedAllChildResults');

function childFixtures() {
  const bindings = relay.createAllChildBindings({
    parentRunId: PARENT_RUN,
    parentIssueNumber: PARENT_ISSUE,
    request: parentRequest,
    relayPlan: parentPlan
  }).map((binding, index) => ({ ...binding, child_issue_number: 301 + index }));

  return bindings.map((binding, index) => {
    const engine = binding.engine_id;
    const contextClaim = relay.validateAllContextClaim({
      schema: relay.ALL_CONTEXT_CLAIM_SCHEMA,
      parent_run_id: PARENT_RUN,
      parent_issue_number: PARENT_ISSUE,
      child_issue_number: binding.child_issue_number,
      engine_id: engine,
      host_context_id: `host-session-${engine}-${index + 1}`,
      assurance_class: relay.ALL_CONTEXT_ASSURANCE_CLASS
    }, binding);
    const sealedBytes = Buffer.from(`sealed-${engine}-result-v1`);
    const receipt = createEngineRunReceipt({
      engineId: engine,
      implementationOrigin: engine === 'kneekura' ? 'first-party' : 'pinned-upstream',
      implementationVersion: engine === 'kneekura' ? '1' : engine === 'understand-anything' ? '2.9.0' : '2.16.0',
      orchestrationMode: 'native',
      snapshotId: SNAPSHOT,
      scopeDigest: SCOPE,
      attemptId: `attempt-${engine}-1`,
      status: 'SUCCESS',
      claimLevel: 'NATIVE',
      claimSatisfied: true,
      acceptance: { passed: true },
      coverage: { files: index + 1 },
      artifacts: [{
        kind: ZIP_KIND[engine],
        digest: `sha256:${crypto.createHash('sha256').update(sealedBytes).digest('hex')}`,
        bytes: sealedBytes.length
      }],
      warnings: ['api_key=supersecretvalue'],
      errors: []
    });
    const relayResult = {
      schema: 'kneekura.code-lab.github-relay-result/v1',
      run_id: relay.createRelayRunId(binding.child_issue_number, REVISION, SCOPE),
      status: 'SUCCESS',
      target: { ...parentPlan.target },
      code_lab_revision: RUNTIME,
      engine_lock_digest: LOCK,
      terminal: { status: 'SUCCESS' },
      artifacts: [],
      artifact_bytes_exposed: false
    };
    const manifest = relay.createChildResultManifest({
      binding,
      contextClaim,
      relayResult,
      receipt,
      sealedBytes
    });
    return { binding, contextClaim, sealedBytes, receipt, relayResult, manifest };
  });
}

test('child artifact staging writes exactly the sealed ZIP, sanitized receipt, and child manifest', async () => {
  const [child] = childFixtures();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kneekura-all-child-stage-'));
  try {
    const staged = await stageChildResultArtifact({
      outputRoot: root,
      binding: child.binding,
      contextClaim: child.contextClaim,
      relayResult: child.relayResult,
      receipt: child.receipt,
      sealedBytes: child.sealedBytes
    });
    assert.deepEqual((await fs.readdir(staged.artifact_root)).sort(), [
      'child-result-manifest.json',
      'engine-receipt.json',
      'result.zip'
    ]);
    assert.deepEqual(await fs.readFile(path.join(staged.artifact_root, 'result.zip')), child.sealedBytes);
    assert.deepEqual(
      JSON.parse(await fs.readFile(path.join(staged.artifact_root, 'engine-receipt.json'), 'utf8')),
      createSanitizedReceipt(child.receipt)
    );
    assert.deepEqual(
      JSON.parse(await fs.readFile(path.join(staged.artifact_root, 'child-result-manifest.json'), 'utf8')),
      child.manifest
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('parent composition verifies all three stored sanitized receipts before delegating to sealed-only composer', () => {
  const children = childFixtures();
  const composed = composeVerifiedAllChildResults({
    parentPlan,
    childInputs: children.map(child => ({
      manifest: child.manifest,
      receipt: createSanitizedReceipt(child.receipt),
      sealedBytes: child.sealedBytes,
      expectedBinding: child.binding,
      expectedContextClaim: child.contextClaim
    }))
  });

  assert.equal(composed.kind, 'ALL_MODE_BUNDLE');
  assert.equal(composed.runId, PARENT_RUN);
  assert.equal(composed.snapshotId, SNAPSHOT);
  assert.equal(composed.scopeDigest, SCOPE);
  assert.equal(composed.comparison.semantic_fusion, false);
  assert.equal(composed.comparison.canonical_truth_promotion, false);
  assert.equal(composed.comparison.engine_substitution, false);
  assert.deepEqual(composed.runManifest.semantic_contexts.map(row => row.engine_id), ENGINES);
  assert.equal(new Set(composed.runManifest.semantic_contexts.map(row => row.host_context_id)).size, 3);
});