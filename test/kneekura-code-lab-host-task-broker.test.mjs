import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HostTaskRequiredError
} from '../mcp/src/host-bridge-contract.mjs';
import {
  acceptHostResponseForPendingTask,
  createHostReplayBroker,
  createHostResponseLedger
} from '../mcp/src/host-task-broker.mjs';

const BINDING = Object.freeze({
  runId: 'broker-run',
  engineId: 'archify',
  attemptId: 'attempt-broker-1-archify',
  snapshotId: `snapshot:sha256:${'1'.repeat(64)}`,
  scopeDigest: `sha256:${'2'.repeat(64)}`
});

function broker(ledger, projectPayload) {
  return createHostReplayBroker({
    ...BINDING,
    ledger,
    projectPayload
  });
}

async function requireTask(operation) {
  try {
    await operation();
  } catch (error) {
    assert(error instanceof HostTaskRequiredError);
    return error.task;
  }
  assert.fail('expected HOST_TASK_REQUIRED');
}

test('broker emits one deterministic pending task and replays accepted response', async () => {
  const ledger = createHostResponseLedger();
  const first = broker(ledger);
  const task = await requireTask(() => first.request('archify:typed-ir', {
    schema: 'archify-envelope', diagram: 'architecture'
  }));
  assert.equal(first.pendingTask().task_id, task.task_id);

  const accepted = acceptHostResponseForPendingTask({
    pendingTask: task,
    taskId: task.task_id,
    response: { schema_version: 1, diagram_type: 'architecture' },
    ledger
  });
  assert.equal(accepted.task_id, task.task_id);
  assert.equal(ledger.summary().accepted_response_count, 1);

  const replay = broker(ledger);
  const value = await replay.request('archify:typed-ir', {
    schema: 'archify-envelope', diagram: 'architecture'
  });
  assert.deepEqual(value, {
    schema_version: 1,
    diagram_type: 'architecture'
  });
  assert.equal(replay.pendingTask(), null);
});

test('task ordinal is stable across deterministic replay and advances only by callback order', async () => {
  const ledger = createHostResponseLedger();
  const first = broker(ledger);
  const task1 = await requireTask(() => first.request('archify:typed-ir', { round: 1 }));
  ledger.accept(task1, { accepted: 1 });

  const replay = broker(ledger);
  assert.deepEqual(await replay.request('archify:typed-ir', { round: 1 }), { accepted: 1 });
  const task2 = await requireTask(() => replay.request('archify:typed-ir', { round: 2 }));
  assert.equal(task1.ordinal, 1);
  assert.equal(task2.ordinal, 2);
  assert.notEqual(task1.task_id, task2.task_id);
});

test('ledger rejects stale task reuse and conflicting second answers', async () => {
  const ledger = createHostResponseLedger();
  const first = broker(ledger);
  const pending = await requireTask(() => first.request('archify:typed-ir', { target: 'A' }));
  ledger.accept(pending, { answer: 'A' });
  assert.throws(
    () => ledger.accept(pending, { answer: 'B' }),
    error => error?.code === 'HOST_RESPONSE_CONFLICT'
  );

  const foreign = broker(ledger);
  const different = await requireTask(() => foreign.request('archify:typed-ir', { target: 'B' }));
  assert.notEqual(different.task_id, pending.task_id);
  assert.throws(
    () => acceptHostResponseForPendingTask({
      pendingTask: different,
      taskId: pending.task_id,
      response: { answer: 'stale' },
      ledger
    }),
    error => error?.code === 'HOST_TASK_NOT_PENDING'
  );
});

test('public task projection can remove private local paths without changing private engine input', async () => {
  const ledger = createHostResponseLedger();
  let privateSeen = null;
  const replay = broker(ledger, (_kind, payload) => {
    privateSeen = structuredClone(payload);
    return {
      ...payload,
      projectRoot: '$TARGET'
    };
  });
  const task = await requireTask(() => replay.request('archify:typed-ir', {
    projectRoot: 'C:/private/work/repo',
    diagram: 'architecture'
  }));
  assert.equal(privateSeen.projectRoot, 'C:/private/work/repo');
  assert.equal(task.payload.projectRoot, '$TARGET');
  assert.equal(JSON.stringify(task).includes('C:/private/work/repo'), false);
});