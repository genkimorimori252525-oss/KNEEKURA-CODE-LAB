import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GITHUB_RELAY_COMMENT_MAX_BYTES,
  GITHUB_RELAY_MARKERS,
  GITHUB_RELAY_TASK_PAYLOAD_SCHEMA,
  prepareRelayTaskTransport,
  renderRelayComment,
  verifyRelayTaskPayloadArtifact
} from '../src/github-relay/index.mjs';
import { createRelayTaskEnvelope } from '../src/github-relay/contracts.mjs';
import { createHostTask } from '../mcp/src/host-bridge-contract.mjs';

function makeTask(promptBytes = 32) {
  return createHostTask({
    runId: 'ghr-76-4381de6ee874-aaaaaaaaaaaa',
    engineId: 'kneekura',
    attemptId: 'attempt-p3c',
    snapshotId: `snapshot:sha256:${'b'.repeat(64)}`,
    scopeDigest: `sha256:${'c'.repeat(64)}`,
    ordinal: 1,
    kind: 'kneekura:ARCHITECTURE',
    payload: { prompt: 'x'.repeat(promptBytes) }
  });
}

test('P3c keeps small Host Tasks inline', () => {
  const envelope = createRelayTaskEnvelope(makeTask());
  const prepared = prepareRelayTaskTransport(envelope, {
    workflowRunId: 123456,
    artifactName: 'kneekura-relay-task-small'
  });
  assert.equal(prepared.mode, 'inline');
  assert.equal(prepared.artifact_bytes, null);
  assert.deepEqual(prepared.envelope, envelope);
  assert(Buffer.byteLength(prepared.comment_body, 'utf8') <= GITHUB_RELAY_COMMENT_MAX_BYTES);
});

test('P3c externalizes a legitimate 180KiB Host Task without relaxing the 60KiB Issue budget', () => {
  const envelope = createRelayTaskEnvelope(makeTask(180 * 1024));
  assert.throws(
    () => renderRelayComment(GITHUB_RELAY_MARKERS.task, envelope),
    error => error?.code === 'BLOCKED_RELAY_COMMENT_BUDGET'
  );

  const prepared = prepareRelayTaskTransport(envelope, {
    workflowRunId: 987654321,
    artifactName: 'kneekura-relay-task-ghr-76-001'
  });
  assert.equal(prepared.mode, 'github-actions-artifact');
  assert(Buffer.isBuffer(prepared.artifact_bytes));
  assert(Buffer.byteLength(prepared.comment_body, 'utf8') <= GITHUB_RELAY_COMMENT_MAX_BYTES);
  assert.equal(Object.prototype.hasOwnProperty.call(prepared.envelope.task, 'payload'), false);
  assert.equal(prepared.envelope.payload_externalized, true);
  assert.equal(prepared.envelope.payload_locator.workflow_run_id, 987654321);
  assert.equal(prepared.envelope.payload_locator.artifact_name, 'kneekura-relay-task-ghr-76-001');
  assert.equal(prepared.envelope.payload_locator.path, 'task-payload.json');
  assert.equal(prepared.envelope.payload_locator.payload_digest, envelope.task.payload_digest);
  assert.equal(prepared.envelope.payload_locator.payload_bytes, envelope.task.payload_bytes);
  assert.equal(prepared.comment_body.includes('x'.repeat(1024)), false);

  const parsed = JSON.parse(prepared.artifact_bytes.toString('utf8'));
  assert.equal(parsed.schema, GITHUB_RELAY_TASK_PAYLOAD_SCHEMA);
  assert.equal(parsed.task_binding.task_id, envelope.task.task_id);
  assert.deepEqual(
    verifyRelayTaskPayloadArtifact(prepared.artifact_bytes, prepared.envelope),
    envelope.task.payload
  );
});

test('P3c task payload artifact verification fails closed on tampering or descriptor rebinding', () => {
  const envelope = createRelayTaskEnvelope(makeTask(180 * 1024));
  const prepared = prepareRelayTaskTransport(envelope, {
    workflowRunId: 987654322,
    artifactName: 'kneekura-relay-task-ghr-76-002'
  });

  const tampered = Buffer.from(prepared.artifact_bytes);
  tampered[tampered.length - 2] ^= 1;
  assert.throws(
    () => verifyRelayTaskPayloadArtifact(tampered, prepared.envelope),
    error => error?.code === 'RELAY_TASK_PAYLOAD_ARTIFACT_DIGEST_MISMATCH'
  );

  const rebound = structuredClone(prepared.envelope);
  rebound.payload_locator.content_sha256 = `sha256:${'d'.repeat(64)}`;
  assert.throws(
    () => verifyRelayTaskPayloadArtifact(prepared.artifact_bytes, rebound),
    error => error?.code === 'RELAY_TASK_PAYLOAD_ARTIFACT_DIGEST_MISMATCH'
  );
});

test('P3c refuses a full task whose payload no longer matches its Host Task binding', () => {
  const envelope = structuredClone(createRelayTaskEnvelope(makeTask()));
  envelope.task.payload.prompt = 'tampered';
  assert.throws(
    () => prepareRelayTaskTransport(envelope, {
      workflowRunId: 123,
      artifactName: 'kneekura-relay-task-tampered'
    }),
    error => error?.code === 'RELAY_TASK_PAYLOAD_SIZE_MISMATCH' || error?.code === 'RELAY_TASK_PAYLOAD_DIGEST_MISMATCH'
  );
});
