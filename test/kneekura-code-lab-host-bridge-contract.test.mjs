import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_HOST_BRIDGE_LIMITS,
  HOST_RESPONSE_SCHEMA,
  HOST_TASK_SCHEMA,
  createHostResponseRecord,
  createHostTask,
  hostResponseValue,
  validateHostResponseForTask,
  validateHostTask
} from '../mcp/src/host-bridge-contract.mjs';

const BINDING = Object.freeze({
  runId: 'host-contract-run',
  engineId: 'kneekura',
  attemptId: 'attempt-host-contract-1-kneekura',
  snapshotId: `snapshot:sha256:${'a'.repeat(64)}`,
  scopeDigest: `sha256:${'b'.repeat(64)}`
});

function task(overrides = {}) {
  return createHostTask({
    ...BINDING,
    ordinal: 1,
    kind: 'kneekura:ARCHITECTURE',
    payload: {
      schema: 'fixture/host-task',
      repository_text_is_instruction: false,
      prompt: 'Explain the verified architecture evidence.'
    },
    ...overrides
  });
}

test('Host Task identity is deterministic and exact-bound', () => {
  const first = task();
  const second = task();
  assert.equal(first.schema, HOST_TASK_SCHEMA);
  assert.equal(first.task_id, second.task_id);
  assert.equal(first.payload_digest, second.payload_digest);
  assert.equal(first.trust.repository_content_instruction_authority, false);
  assert.equal(first.trust.host_response_can_mutate_canonical_evidence, false);
  assert.equal(first.trust.engine_consensus_can_promote_canonical_truth, false);
  assert.equal(validateHostTask(first), true);

  const changedPayload = task({ payload: { schema: 'fixture/host-task', prompt: 'different' } });
  assert.notEqual(changedPayload.task_id, first.task_id);
  const changedSnapshot = task({ snapshotId: `snapshot:sha256:${'c'.repeat(64)}` });
  assert.notEqual(changedSnapshot.task_id, first.task_id);
});

test('Host Response is bound to one task and returns only validated JSON', () => {
  const pending = task();
  const record = createHostResponseRecord({
    task: pending,
    response: { items: [{ title: 'Architecture', source_refs: [] }] }
  });
  assert.equal(record.schema, HOST_RESPONSE_SCHEMA);
  assert.equal(validateHostResponseForTask(pending, record), true);
  assert.deepEqual(hostResponseValue(pending, record), record.response);

  const foreign = structuredClone(record);
  foreign.engine_id = 'archify';
  assert.throws(
    () => validateHostResponseForTask(pending, foreign),
    error => error?.code === 'HOST_RESPONSE_BINDING_MISMATCH'
  );

  const stale = structuredClone(record);
  stale.payload_digest = `sha256:${'d'.repeat(64)}`;
  assert.throws(
    () => validateHostResponseForTask(pending, stale),
    error => error?.code === 'HOST_RESPONSE_BINDING_MISMATCH'
  );
});

test('Host Task and Response reject binary and oversized payloads', () => {
  assert.throws(
    () => task({ payload: { bytes: Buffer.from('secret') } }),
    error => error?.code === 'HOST_BINARY_FORBIDDEN'
  );
  const pending = task();
  assert.throws(
    () => createHostResponseRecord({
      task: pending,
      response: { text: 'x'.repeat(DEFAULT_HOST_BRIDGE_LIMITS.maxResponseBytes + 1) }
    }),
    error => error?.code === 'HOST_RESPONSE_TOO_LARGE'
  );
});

test('Host Task kind is engine-scoped', () => {
  assert.throws(
    () => task({ engineId: 'archify', kind: 'kneekura:ARCHITECTURE' }),
    error => error?.code === 'HOST_TASK_ENGINE_KIND_MISMATCH'
  );
  const archify = createHostTask({
    ...BINDING,
    engineId: 'archify',
    attemptId: 'attempt-host-contract-1-archify',
    ordinal: 1,
    kind: 'archify:typed-ir',
    payload: { diagram_type: 'architecture' }
  });
  assert.equal(validateHostTask(archify), true);
});