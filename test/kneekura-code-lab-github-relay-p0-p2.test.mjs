import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GITHUB_RELAY_SCHEMAS,
  assertRelayResponseMatchesTask,
  replayGithubRelayRun,
  validateRelayRequest,
  validateRelayResponseEnvelope,
  validateRelaySourceRequest
} from '../src/github-relay/index.mjs';
import {
  HostTaskRequiredError,
  createHostTask
} from '../mcp/src/host-bridge-contract.mjs';

const RUN_ID = 'relay-test-001';
const SNAPSHOT_ID = `snapshot:sha256:${'b'.repeat(64)}`;
const SCOPE_DIGEST = `sha256:${'c'.repeat(64)}`;
const REVISION = 'a'.repeat(40);

test('P0 relay request requires exact Git revision and isolates all-mode', () => {
  const request = validateRelayRequest({
    schema: GITHUB_RELAY_SCHEMAS.request,
    selection: 'kneekura',
    target: {
      repository: 'genkimorimori252525-oss/KNEEKURA-LAB',
      revision: REVISION
    },
    commonScope: { question: 'Explain the exact Water Tank Studio snapshot.' }
  });
  assert.equal(request.target.revision, REVISION);
  assert.equal(request.semanticContextMode, 'single-context');

  assert.throws(
    () => validateRelayRequest({
      schema: GITHUB_RELAY_SCHEMAS.request,
      selection: 'kneekura',
      target: {
        repository: 'genkimorimori252525-oss/KNEEKURA-LAB',
        revision: 'main'
      }
    }),
    /exact 40- or 64-hex/
  );

  assert.throws(
    () => validateRelayRequest({
      schema: GITHUB_RELAY_SCHEMAS.request,
      selection: 'all',
      target: {
        repository: 'genkimorimori252525-oss/KNEEKURA-LAB',
        revision: REVISION
      }
    }),
    error => error?.code === 'BLOCKED_SEMANTIC_CONTEXT_ISOLATION'
  );

  const all = validateRelayRequest({
    schema: GITHUB_RELAY_SCHEMAS.request,
    selection: 'all',
    semanticContextMode: 'per-engine',
    target: {
      repository: 'genkimorimori252525-oss/KNEEKURA-LAB',
      revision: REVISION
    }
  });
  assert.equal(all.semanticContextMode, 'per-engine');
});

test('P0 relay source requests reject path traversal', () => {
  assert.throws(
    () => validateRelaySourceRequest({
      schema: GITHUB_RELAY_SCHEMAS.sourceRequest,
      run_id: RUN_ID,
      task_id: `task:sha256:${'d'.repeat(64)}`,
      path: '../secrets.txt',
      start_line: 1,
      end_line: 10
    }),
    error => error?.code === 'RELAY_SOURCE_PATH_UNSAFE'
  );
});

test('P0 relay response binding is exact across run, engine, attempt, snapshot and payload', () => {
  const task = makeTask();
  const response = responseFor(task, { items: [] });
  const normalized = assertRelayResponseMatchesTask(response, task);
  assert.deepEqual(normalized.response, { items: [] });

  assert.throws(
    () => assertRelayResponseMatchesTask({
      ...response,
      scope_digest: `sha256:${'e'.repeat(64)}`
    }, task),
    error => error?.code === 'RELAY_RESPONSE_BINDING_MISMATCH'
  );
});

test('P2 replay returns TASK_REQUIRED without inventing a semantic response', async () => {
  const task = makeTask();
  const backend = createFakeBackend(task);
  const result = await replayGithubRelayRun({
    plan: makePlan(),
    backend,
    responses: []
  });

  assert.equal(result.state, 'TASK_REQUIRED');
  assert.equal(result.pending_task.task.task_id, task.task_id);
  assert.equal(result.consumed_response_count, 0);
  assert.equal(backend.acceptCalls.length, 0);
});

test('P2 replay deterministically replays stored response and reaches COMPLETE', async () => {
  const task = makeTask();
  const backend = createFakeBackend(task);
  const response = responseFor(task, { items: [{ title: 'Bound answer' }] });
  let completedExecution = null;
  const result = await replayGithubRelayRun({
    plan: makePlan(),
    backend,
    responses: [response, structuredClone(response)],
    onComplete(execution) {
      completedExecution = execution;
      assert(Buffer.isBuffer(execution.result.deliveryZip));
    }
  });

  assert.equal(result.state, 'COMPLETE');
  assert.equal(result.consumed_response_count, 1);
  assert.equal(result.artifact_bytes_exposed, false);
  assert.equal('execution' in result, false);
  assert.equal(result.terminal.kind, 'ENGINE_RESULT');
  assert.equal(result.terminal.status, 'SUCCESS');
  assert(completedExecution);
  assert.equal(backend.acceptCalls.length, 1);
  assert.deepEqual(
    backend.acceptCalls[0].response,
    { items: [{ title: 'Bound answer' }] }
  );
});

test('P3g replay uses the latest semantic response when the exact task binding is unchanged', async () => {
  const task = makeTask();
  const backend = createFakeBackend(task);
  const first = responseFor(task, { decisions: [] });
  const corrected = responseFor(task, {
    decisions: [{ item_id: 'candidate-1', status: 'ACCEPT', reason: 'corrected reviewer response' }]
  });

  const result = await replayGithubRelayRun({
    plan: makePlan(),
    backend,
    responses: [first, corrected]
  });

  assert.equal(result.state, 'COMPLETE');
  assert.equal(result.consumed_response_count, 1);
  assert.equal(backend.acceptCalls.length, 1);
  assert.deepEqual(backend.acceptCalls[0].response, corrected.response);
});

test('P3g replay still fails closed when duplicate task responses disagree on binding', async () => {
  const task = makeTask();
  const first = responseFor(task, { items: [] });
  const second = {
    ...responseFor(task, { items: [{ title: 'different' }] }),
    scope_digest: `sha256:${'e'.repeat(64)}`
  };

  await assert.rejects(
    replayGithubRelayRun({
      plan: makePlan(),
      backend: createFakeBackend(task),
      responses: [first, second]
    }),
    error => error?.code === 'RELAY_RESPONSE_CONFLICT'
  );
});

test('P2 replay rejects out-of-order or forged task responses', async () => {
  const pending = makeTask();
  const foreign = createHostTask({
    runId: RUN_ID,
    engineId: 'kneekura',
    attemptId: 'attempt-1',
    snapshotId: SNAPSHOT_ID,
    scopeDigest: SCOPE_DIGEST,
    ordinal: 2,
    kind: 'kneekura:DOMAIN',
    payload: { prompt: 'later task' }
  });

  await assert.rejects(
    replayGithubRelayRun({
      plan: makePlan(),
      backend: createFakeBackend(pending),
      responses: [responseFor(foreign, { items: [] })]
    }),
    error => error?.code === 'RELAY_RESPONSE_OUT_OF_ORDER'
  );
});

function makePlan() {
  return {
    schema: 'kneekura.code-lab.mcp-plan/v1',
    kind: 'RUN',
    runId: RUN_ID,
    target: {
      repository: 'C:/exact/target',
      revision: REVISION,
      snapshotId: SNAPSHOT_ID,
      scopeDigest: SCOPE_DIGEST
    },
    requestedEngines: ['kneekura'],
    runtimeRequest: {
      selection: 'kneekura',
      commonScope: { question: 'Explain exact snapshot.' },
      engineOptions: {},
      minimumClaimLevel: {}
    }
  };
}

function makeTask() {
  return createHostTask({
    runId: RUN_ID,
    engineId: 'kneekura',
    attemptId: 'attempt-1',
    snapshotId: SNAPSHOT_ID,
    scopeDigest: SCOPE_DIGEST,
    ordinal: 1,
    kind: 'kneekura:ARCHITECTURE',
    payload: { prompt: 'exact-bound semantic task' }
  });
}

function responseFor(task, response) {
  return validateRelayResponseEnvelope({
    schema: GITHUB_RELAY_SCHEMAS.response,
    run_id: task.run_id,
    task_id: task.task_id,
    engine_id: task.engine_id,
    attempt_id: task.attempt_id,
    snapshot_id: task.snapshot_id,
    scope_digest: task.scope_digest,
    ordinal: task.ordinal,
    kind: task.kind,
    payload_digest: task.payload_digest,
    response
  });
}

function createFakeBackend(task) {
  let accepted = false;
  const acceptCalls = [];
  return {
    acceptCalls,
    async execute(plan) {
      assert.equal(plan.runId, RUN_ID);
      if (!accepted) throw new HostTaskRequiredError(task);
      return {
        kind: 'ENGINE_RESULT',
        requestedEngine: 'kneekura',
        result: {
          receipt: { status: 'SUCCESS' },
          deliveryZip: Buffer.from([1, 2, 3])
        }
      };
    },
    async acceptHostResponse(runId, taskId, response) {
      assert.equal(runId, RUN_ID);
      assert.equal(taskId, task.task_id);
      acceptCalls.push({ runId, taskId, response: structuredClone(response) });
      accepted = true;
      return { accepted: true };
    },
    async status(runId) {
      return {
        phase: accepted ? 'COMPLETE' : 'PENDING',
        pending_task_id: accepted ? null : task.task_id
      };
    },
    async artifactInfo() {
      return [{
        id: 'kneekura:result.zip',
        digest: `sha256:${'f'.repeat(64)}`,
        bytes: 123
      }];
    }
  };
}
