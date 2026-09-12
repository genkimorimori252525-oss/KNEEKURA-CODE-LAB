import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import * as relay from '../src/github-relay/index.mjs';
import { createEngineRunReceipt } from '../src/skill/contracts.mjs';

const REVISION = 'a'.repeat(40);
const SNAPSHOT = `snapshot:sha256:${'b'.repeat(64)}`;
const SCOPE = `sha256:${'c'.repeat(64)}`;
const RUNTIME = 'd'.repeat(40);
const LOCK = `sha256:${'e'.repeat(64)}`;
const PARENT_RUN = 'ghr-220-parent';
const PARENT_ISSUE = 220;
const CHILD_ISSUE = 301;
const CHILD_RUN = `ghr-${CHILD_ISSUE}-${REVISION.slice(0, 12)}-${SCOPE.slice('sha256:'.length, 'sha256:'.length + 12)}`;

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

const createChildResultManifest = required('createChildResultManifest');
const verifyChildCompositionInput = required('verifyChildCompositionInput');

function fixture() {
  const slot = relay.createAllChildBindings({
    parentRunId: PARENT_RUN,
    parentIssueNumber: PARENT_ISSUE,
    request: parentRequest,
    relayPlan: parentPlan
  })[1];
  const binding = { ...slot, child_issue_number: CHILD_ISSUE };
  const contextClaim = relay.validateAllContextClaim({
    schema: relay.ALL_CONTEXT_CLAIM_SCHEMA,
    parent_run_id: PARENT_RUN,
    parent_issue_number: PARENT_ISSUE,
    child_issue_number: CHILD_ISSUE,
    engine_id: 'understand-anything',
    host_context_id: 'host-session-ua-1',
    assurance_class: relay.ALL_CONTEXT_ASSURANCE_CLASS
  }, binding);
  const sealedBytes = Buffer.from('sealed-child-result-v1');
  const receipt = createEngineRunReceipt({
    engineId: 'understand-anything',
    implementationOrigin: 'pinned-upstream',
    implementationVersion: '2.9.0',
    orchestrationMode: 'native',
    snapshotId: SNAPSHOT,
    scopeDigest: SCOPE,
    attemptId: 'attempt-child-ua-1',
    status: 'SUCCESS',
    claimLevel: 'NATIVE',
    claimSatisfied: true,
    acceptance: { passed: true },
    coverage: { files: 162 },
    artifacts: [{
      kind: 'UA_SKILL_ZIP',
      digest: `sha256:${crypto.createHash('sha256').update(sealedBytes).digest('hex')}`,
      bytes: sealedBytes.length
    }],
    warnings: [],
    errors: []
  });
  const relayResult = {
    schema: 'kneekura.code-lab.github-relay-result/v1',
    run_id: CHILD_RUN,
    status: 'SUCCESS',
    target: { ...parentPlan.target },
    code_lab_revision: RUNTIME,
    engine_lock_digest: LOCK,
    terminal: { status: 'SUCCESS' },
    artifacts: [],
    artifact_bytes_exposed: false
  };
  return { binding, contextClaim, sealedBytes, receipt, relayResult };
}

test('child result manifest binds exact child run, context, runtime, receipt, and sealed ZIP bytes', () => {
  const input = fixture();
  const manifest = createChildResultManifest({ ...input });

  assert.equal(manifest.schema, relay.ALL_CHILD_RESULT_MANIFEST_SCHEMA);
  assert.equal(manifest.parent_run_id, PARENT_RUN);
  assert.equal(manifest.child_run_id, CHILD_RUN);
  assert.equal(manifest.child_issue_number, CHILD_ISSUE);
  assert.equal(manifest.engine_id, 'understand-anything');
  assert.equal(manifest.host_context_id, input.contextClaim.host_context_id);
  assert.equal(manifest.scope_digest, SCOPE);
  assert.equal(manifest.code_lab_revision, RUNTIME);
  assert.equal(manifest.engine_lock_digest, LOCK);
  assert.equal(manifest.result_zip.bytes, input.sealedBytes.length);
  assert.match(manifest.result_zip.digest, /^sha256:[0-9a-f]{64}$/);
  assert.match(manifest.receipt_digest, /^sha256:[0-9a-f]{64}$/);

  const verified = verifyChildCompositionInput({
    manifest,
    receipt: input.receipt,
    sealedBytes: input.sealedBytes,
    expectedBinding: input.binding,
    parentPlan
  });
  assert.equal(verified.manifest.child_run_id, CHILD_RUN);
  assert.deepEqual(verified.sealed_bytes, input.sealedBytes);
});

test('child composition verification rejects ZIP and receipt tampering', () => {
  const input = fixture();
  const manifest = createChildResultManifest({ ...input });

  assert.throws(
    () => verifyChildCompositionInput({
      manifest,
      receipt: input.receipt,
      sealedBytes: Buffer.concat([input.sealedBytes, Buffer.from([0])]),
      expectedBinding: input.binding,
      parentPlan
    }),
    error => error?.code === 'ALL_CHILD_ARTIFACT_INTEGRITY_MISMATCH'
  );

  assert.throws(
    () => verifyChildCompositionInput({
      manifest,
      receipt: { ...input.receipt, attemptId: 'attempt-tampered' },
      sealedBytes: input.sealedBytes,
      expectedBinding: input.binding,
      parentPlan
    }),
    error => error?.code === 'ALL_CHILD_ARTIFACT_INTEGRITY_MISMATCH'
  );
});

test('child composition verification rejects wrong child run and runtime binding', () => {
  const input = fixture();
  const manifest = createChildResultManifest({ ...input });

  assert.throws(
    () => verifyChildCompositionInput({
      manifest: { ...manifest, child_run_id: 'ghr-999-aaaaaaaaaaaa-cccccccccccc' },
      receipt: input.receipt,
      sealedBytes: input.sealedBytes,
      expectedBinding: input.binding,
      parentPlan
    }),
    error => error?.code === 'ALL_CHILD_RESULT_BINDING_MISMATCH'
  );

  assert.throws(
    () => verifyChildCompositionInput({
      manifest: { ...manifest, code_lab_revision: '9'.repeat(40) },
      receipt: input.receipt,
      sealedBytes: input.sealedBytes,
      expectedBinding: input.binding,
      parentPlan
    }),
    error => error?.code === 'ALL_CHILD_RESULT_BINDING_MISMATCH'
  );
});