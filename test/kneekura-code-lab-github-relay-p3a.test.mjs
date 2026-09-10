import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  GITHUB_RELAY_MARKERS,
  parseRelayIssueRequest,
  parseRelayThreadComments,
  relayEnvelopeDigest,
  relaySourceResultDigests,
  relayTaskIds,
  renderRelayComment,
  runGithubRelayTurn,
  selectCanonicalRelayPlan
} from '../src/github-relay/index.mjs';
import {
  GITHUB_RELAY_SCHEMAS,
  validateRelayResponseEnvelope,
  validateRelaySourceRequest
} from '../src/github-relay/contracts.mjs';
import {
  HostTaskRequiredError,
  createHostTask
} from '../mcp/src/host-bridge-contract.mjs';

const OWNER = 'genkimorimori252525-oss';
const TARGET = `${OWNER}/KNEEKURA-LAB`;
const TARGET_REVISION = 'a'.repeat(40);
const CODE_LAB_REVISION = 'b'.repeat(40);
const ENGINE_LOCK_DIGEST = `sha256:${'c'.repeat(64)}`;

const REQUEST = Object.freeze({
  schema: GITHUB_RELAY_SCHEMAS.request,
  selection: 'kneekura',
  target: {
    repository: TARGET,
    revision: TARGET_REVISION
  },
  commonScope: {
    question: 'Explain the exact Water Tank Studio snapshot.'
  }
});

test('P3 Issue request requires an authorized real Issue and exact relay framing', () => {
  const issue = {
    number: 72,
    user: { login: OWNER },
    body: renderRelayComment(GITHUB_RELAY_MARKERS.request, REQUEST)
  };
  const parsed = parseRelayIssueRequest(issue, { allowedActors: [OWNER] });
  assert.equal(parsed.selection, 'kneekura');
  assert.equal(parsed.target.revision, TARGET_REVISION);

  assert.throws(
    () => parseRelayIssueRequest({ ...issue, pull_request: { url: 'x' } }, { allowedActors: [OWNER] }),
    error => error?.code === 'RELAY_PULL_REQUEST_THREAD_FORBIDDEN'
  );
  assert.throws(
    () => parseRelayIssueRequest({ ...issue, user: { login: 'mallory' } }, { allowedActors: [OWNER] }),
    error => error?.code === 'RELAY_ISSUE_AUTHOR_NOT_ALLOWED'
  );
});

test('P3 client comments accept only authorized response/source markers and ignore spoofed protocol text', () => {
  const task = makeStandaloneTask();
  const response = responseFor(task, { items: [] });
  const sourceRequest = validateRelaySourceRequest({
    schema: GITHUB_RELAY_SCHEMAS.sourceRequest,
    run_id: task.run_id,
    task_id: task.task_id,
    path: 'src/example.mjs',
    start_line: 1,
    end_line: 10
  });

  const thread = parseRelayThreadComments([
    {
      id: 1,
      user: { login: OWNER },
      body: renderRelayComment(GITHUB_RELAY_MARKERS.response, response)
    },
    {
      id: 2,
      user: { login: 'mallory' },
      body: renderRelayComment(GITHUB_RELAY_MARKERS.response, {
        ...response,
        response: { forged: true }
      })
    },
    {
      id: 3,
      user: { login: OWNER },
      body: renderRelayComment(GITHUB_RELAY_MARKERS.sourceRequest, sourceRequest)
    },
    {
      id: 4,
      user: { login: OWNER },
      body: 'ordinary discussion that mentions KNEEKURA_RELAY_RESPONSE_V1 later in the body'
    }
  ], { allowedActors: [OWNER] });

  assert.equal(thread.responses.length, 1);
  assert.equal(thread.responses[0].comment_id, 1);
  assert.equal(thread.sourceRequests.length, 1);
  assert.equal(thread.sourceRequests[0].comment_id, 3);
});

test('P3 canonical plan rejects conflicting runner-authored plans', () => {
  const base = {
    schema: GITHUB_RELAY_SCHEMAS.plan,
    run_id: 'ghr-72-aaaaaaaaaaaa-dddddddddddd',
    selection: 'kneekura',
    target: {
      repository: TARGET,
      revision: TARGET_REVISION,
      snapshot_id: `snapshot:sha256:${'e'.repeat(64)}`,
      scope_digest: `sha256:${'d'.repeat(64)}`
    },
    semantic_context_mode: 'single-context',
    code_lab_revision: CODE_LAB_REVISION,
    engine_lock_digest: ENGINE_LOCK_DIGEST
  };
  const comments = [
    { id: 10, user: { login: 'github-actions[bot]' }, body: renderRelayComment(GITHUB_RELAY_MARKERS.plan, base) },
    { id: 11, user: { login: 'github-actions[bot]' }, body: renderRelayComment(GITHUB_RELAY_MARKERS.plan, base) }
  ];
  const thread = parseRelayThreadComments(comments, { allowedActors: [OWNER] });
  assert.equal(selectCanonicalRelayPlan(thread.plans).run_id, base.run_id);

  const conflict = {
    ...base,
    target: { ...base.target, scope_digest: `sha256:${'f'.repeat(64)}` }
  };
  const bad = parseRelayThreadComments([
    comments[0],
    { id: 12, user: { login: 'github-actions[bot]' }, body: renderRelayComment(GITHUB_RELAY_MARKERS.plan, conflict) }
  ], { allowedActors: [OWNER] });
  assert.throws(
    () => selectCanonicalRelayPlan(bad.plans),
    error => error?.code === 'RELAY_PLAN_CONFLICT'
  );
});

test('P3 turn emits PLAN+TASK once, services bounded source request, then reaches RESULT by replay', async () => {
  const fixture = await makeTargetFixture();
  try {
    const firstBackend = createTurnBackend();
    const first = await runGithubRelayTurn({
      request: REQUEST,
      issueNumber: 72,
      targetRoot: fixture.root,
      codeLabRevision: CODE_LAB_REVISION,
      engineLockDigest: ENGINE_LOCK_DIGEST,
      backend: firstBackend
    });
    assert.deepEqual(first.actions.map(row => row.kind), ['PLAN', 'TASK']);
    const task = first.actions.find(row => row.kind === 'TASK').envelope.task;
    const existingPlan = first.actions.find(row => row.kind === 'PLAN').envelope;

    const sourceRequest = validateRelaySourceRequest({
      schema: GITHUB_RELAY_SCHEMAS.sourceRequest,
      run_id: first.run_id,
      task_id: task.task_id,
      path: 'src/example.mjs',
      start_line: 1,
      end_line: 2
    });
    const second = await runGithubRelayTurn({
      request: REQUEST,
      issueNumber: 72,
      targetRoot: fixture.root,
      codeLabRevision: CODE_LAB_REVISION,
      engineLockDigest: ENGINE_LOCK_DIGEST,
      backend: createTurnBackend(),
      existingPlan,
      existingTaskIds: new Set([task.task_id]),
      sourceRequests: [{ comment_id: 20, envelope: sourceRequest }]
    });
    assert.deepEqual(second.actions.map(row => row.kind), ['SOURCE_RESULT']);
    const sourceResult = second.actions[0].envelope;
    assert.equal(sourceResult.source.instruction_authority, false);
    assert.equal(sourceResult.source.trust_class, 'UNTRUSTED_REPOSITORY_DATA');
    assert.equal(sourceResult.source_request_digest, relayEnvelopeDigest(sourceRequest));

    const response = responseFor(task, { items: [{ title: 'Bound semantic answer' }] });
    let artifactBytesSeen = null;
    const third = await runGithubRelayTurn({
      request: REQUEST,
      issueNumber: 72,
      targetRoot: fixture.root,
      codeLabRevision: CODE_LAB_REVISION,
      engineLockDigest: ENGINE_LOCK_DIGEST,
      backend: createTurnBackend(),
      existingPlan,
      existingTaskIds: new Set([task.task_id]),
      existingSourceResultDigests: relaySourceResultDigests([{
        envelope: sourceResult
      }]),
      responses: [{ comment_id: 21, envelope: response }],
      onComplete(execution) {
        artifactBytesSeen = execution.result.deliveryZip;
      }
    });
    assert.deepEqual(third.actions.map(row => row.kind), ['RESULT']);
    assert(Buffer.isBuffer(artifactBytesSeen));
    assert.equal(third.actions[0].envelope.artifact_bytes_exposed, false);
    assert.equal(JSON.stringify(third.actions[0].envelope).includes('deliveryZip'), false);
  } finally {
    await fixture.cleanup();
  }
});

test('P3 plan continuity fails closed if Issue request/runtime binding changes', async () => {
  const fixture = await makeTargetFixture();
  try {
    const first = await runGithubRelayTurn({
      request: REQUEST,
      issueNumber: 73,
      targetRoot: fixture.root,
      codeLabRevision: CODE_LAB_REVISION,
      engineLockDigest: ENGINE_LOCK_DIGEST,
      backend: createTurnBackend()
    });
    const plan = first.actions.find(row => row.kind === 'PLAN').envelope;
    await assert.rejects(
      runGithubRelayTurn({
        request: {
          ...REQUEST,
          commonScope: { question: 'Edited request must not silently rebind the run.' }
        },
        issueNumber: 73,
        targetRoot: fixture.root,
        codeLabRevision: CODE_LAB_REVISION,
        engineLockDigest: ENGINE_LOCK_DIGEST,
        backend: createTurnBackend(),
        existingPlan: plan
      }),
      error => error?.code === 'RELAY_PLAN_CONFLICT'
    );
  } finally {
    await fixture.cleanup();
  }
});

test('P3 comment renderer blocks oversized task/source payloads instead of splitting semantics implicitly', () => {
  assert.throws(
    () => renderRelayComment(GITHUB_RELAY_MARKERS.task, {
      schema: GITHUB_RELAY_SCHEMAS.task,
      task: { payload: 'x'.repeat(70 * 1024) }
    }),
    error => error?.code === 'BLOCKED_RELAY_COMMENT_BUDGET'
  );
});

async function makeTargetFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kneekura-relay-p3-'));
  git(root, ['init']);
  git(root, ['remote', 'add', 'origin', `https://github.com/${TARGET}.git`]);
  return {
    root,
    cleanup: () => fs.rm(root, { recursive: true, force: true })
  };
}

function createTurnBackend() {
  let task = null;
  let accepted = false;
  return {
    async execute(plan) {
      if (!task) {
        task = createHostTask({
          runId: plan.runId,
          engineId: 'kneekura',
          attemptId: 'attempt-relay-p3',
          snapshotId: plan.target.snapshotId,
          scopeDigest: plan.target.scopeDigest,
          ordinal: 1,
          kind: 'kneekura:ARCHITECTURE',
          payload: { prompt: 'Explain exact architecture.' }
        });
      }
      if (!accepted) throw new HostTaskRequiredError(task);
      return {
        kind: 'ENGINE_RESULT',
        requestedEngine: 'kneekura',
        result: {
          receipt: { status: 'SUCCESS' },
          deliveryZip: Buffer.from([7, 8, 9])
        }
      };
    },
    async acceptHostResponse(runId, taskId) {
      assert.equal(runId, task.run_id);
      assert.equal(taskId, task.task_id);
      accepted = true;
    },
    async readSource(runId, taskId, request) {
      assert.equal(runId, task.run_id);
      assert.equal(taskId, task.task_id);
      return {
        path: request.path,
        start_line: request.startLine,
        end_line: request.endLine,
        content_digest: `sha256:${'1'.repeat(64)}`,
        text: 'export const value = 1;',
        instruction_authority: false,
        trust_class: 'UNTRUSTED_REPOSITORY_DATA',
        canonical_source_bytes: 23,
        task_source_bytes_used: 23,
        task_source_bytes_limit: 65536
      };
    },
    async status() {
      return { phase: accepted ? 'COMPLETE' : 'PENDING', pending_task_id: accepted ? null : task?.task_id ?? null };
    },
    async artifactInfo() {
      return [{ id: 'kneekura:result.zip', digest: `sha256:${'2'.repeat(64)}`, bytes: 3 }];
    }
  };
}

function makeStandaloneTask() {
  return createHostTask({
    runId: 'ghr-72-aaaaaaaaaaaa-dddddddddddd',
    engineId: 'kneekura',
    attemptId: 'attempt-standalone',
    snapshotId: `snapshot:sha256:${'e'.repeat(64)}`,
    scopeDigest: `sha256:${'d'.repeat(64)}`,
    ordinal: 1,
    kind: 'kneekura:ARCHITECTURE',
    payload: { prompt: 'task' }
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

function git(cwd, args) {
  return childProcess.execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
}
