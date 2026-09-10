import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  relayEnvelopeDigest,
  relaySourceResultDigests,
  runGithubRelayTurn
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

test('P3f a corrected source request supersedes an older poisoned request and stale requests do not block the next Host Task', async () => {
  const fixture = await makeTargetFixture();
  try {
    const first = await runGithubRelayTurn({
      request: REQUEST,
      issueNumber: 97,
      targetRoot: fixture.root,
      codeLabRevision: CODE_LAB_REVISION,
      engineLockDigest: ENGINE_LOCK_DIGEST,
      backend: createTwoTaskBackend()
    });
    assert.deepEqual(first.actions.map(row => row.kind), ['PLAN', 'TASK']);
    const plan = first.actions.find(row => row.kind === 'PLAN').envelope;
    const task1 = first.actions.find(row => row.kind === 'TASK').envelope.task;

    const poisoned = sourceRequestFor(task1, 'README.md');
    const corrected = sourceRequestFor(task1, 'src/example.mjs');

    const second = await runGithubRelayTurn({
      request: REQUEST,
      issueNumber: 97,
      targetRoot: fixture.root,
      codeLabRevision: CODE_LAB_REVISION,
      engineLockDigest: ENGINE_LOCK_DIGEST,
      backend: createTwoTaskBackend(),
      existingPlan: plan,
      existingTaskIds: new Set([task1.task_id]),
      sourceRequests: [
        { comment_id: 100, envelope: poisoned },
        { comment_id: 101, envelope: corrected }
      ]
    });

    assert.deepEqual(second.actions.map(row => row.kind), ['SOURCE_RESULT']);
    const sourceResult = second.actions[0].envelope;
    assert.equal(sourceResult.source.path, 'src/example.mjs');
    assert.equal(sourceResult.source_request_digest, relayEnvelopeDigest(corrected));
    assert.notEqual(sourceResult.source_request_digest, relayEnvelopeDigest(poisoned));

    const third = await runGithubRelayTurn({
      request: REQUEST,
      issueNumber: 97,
      targetRoot: fixture.root,
      codeLabRevision: CODE_LAB_REVISION,
      engineLockDigest: ENGINE_LOCK_DIGEST,
      backend: createTwoTaskBackend(),
      existingPlan: plan,
      existingTaskIds: new Set([task1.task_id]),
      existingSourceResultDigests: relaySourceResultDigests([{ envelope: sourceResult }]),
      sourceRequests: [
        { comment_id: 100, envelope: poisoned },
        { comment_id: 101, envelope: corrected }
      ],
      responses: [{
        comment_id: 102,
        envelope: responseFor(task1, { items: [{ title: 'Architecture answer' }] })
      }]
    });

    assert.deepEqual(third.actions.map(row => row.kind), ['TASK']);
    const task2 = third.actions[0].envelope.task;
    assert.equal(task2.ordinal, 2);
    assert.equal(task2.kind, 'kneekura:DOMAIN');
    assert.notEqual(task2.task_id, task1.task_id);
  } finally {
    await fixture.cleanup();
  }
});

async function makeTargetFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kneekura-relay-p3f-'));
  git(root, ['init']);
  git(root, ['remote', 'add', 'origin', `https://github.com/${TARGET}.git`]);
  return {
    root,
    cleanup: () => fs.rm(root, { recursive: true, force: true })
  };
}

function createTwoTaskBackend() {
  let tasks = null;
  const accepted = new Set();
  return {
    async execute(plan) {
      if (!tasks) {
        tasks = [
          createHostTask({
            runId: plan.runId,
            engineId: 'kneekura',
            attemptId: 'attempt-relay-p3f',
            snapshotId: plan.target.snapshotId,
            scopeDigest: plan.target.scopeDigest,
            ordinal: 1,
            kind: 'kneekura:ARCHITECTURE',
            payload: { prompt: 'Explain exact architecture.' }
          }),
          createHostTask({
            runId: plan.runId,
            engineId: 'kneekura',
            attemptId: 'attempt-relay-p3f',
            snapshotId: plan.target.snapshotId,
            scopeDigest: plan.target.scopeDigest,
            ordinal: 2,
            kind: 'kneekura:DOMAIN',
            payload: { prompt: 'Explain exact domains.' }
          })
        ];
      }
      for (const task of tasks) {
        if (!accepted.has(task.task_id)) throw new HostTaskRequiredError(task);
      }
      return {
        kind: 'ENGINE_RESULT',
        requestedEngine: 'kneekura',
        result: {
          receipt: { status: 'SUCCESS' },
          deliveryZip: Buffer.from([3, 1, 4])
        }
      };
    },
    async acceptHostResponse(runId, taskId) {
      const task = tasks.find(candidate => candidate.task_id === taskId);
      assert(task, `unexpected Host Task response ${taskId}`);
      assert.equal(runId, task.run_id);
      accepted.add(taskId);
    },
    async readSource(runId, taskId, request) {
      const task = tasks.find(candidate => candidate.task_id === taskId);
      assert(task, `unexpected Host Task source read ${taskId}`);
      assert.equal(runId, task.run_id);
      if (request.path === 'README.md') {
        const error = new Error('requested source path is outside the exact Target Snapshot catalog');
        error.code = 'HOST_SOURCE_OUTSIDE_CATALOG';
        throw error;
      }
      assert.equal(request.path, 'src/example.mjs');
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
      return { phase: 'PENDING' };
    },
    async artifactInfo() {
      return [];
    }
  };
}

function sourceRequestFor(task, sourcePath) {
  return validateRelaySourceRequest({
    schema: GITHUB_RELAY_SCHEMAS.sourceRequest,
    run_id: task.run_id,
    task_id: task.task_id,
    path: sourcePath,
    start_line: 1,
    end_line: 2
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
