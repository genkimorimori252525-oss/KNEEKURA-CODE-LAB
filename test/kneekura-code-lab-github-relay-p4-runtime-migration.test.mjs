import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  GITHUB_RELAY_SCHEMAS,
  validateRelayResponseEnvelope
} from '../src/github-relay/contracts.mjs';
import { runGithubRelayTurn } from '../src/github-relay/orchestrator.mjs';
import {
  HostTaskRequiredError,
  createHostTask
} from '../mcp/src/host-bridge-contract.mjs';

const TARGET = 'genkimorimori252525-oss/KNEEKURA-LAB';
const OLD_RUNTIME = '1'.repeat(40);
const NEW_RUNTIME = '2'.repeat(40);
const ENGINE_LOCK_DIGEST = `sha256:${'3'.repeat(64)}`;

function requestFor(revision) {
  return {
    schema: GITHUB_RELAY_SCHEMAS.request,
    selection: 'understand-anything',
    target: { repository: TARGET, revision },
    commonScope: { question: 'Explain the exact snapshot.' }
  };
}

test('approved runtime migration can supersede a previously published stale task response without rebinding it', async t => {
  const fixture = await makeFixture(t);
  const request = requestFor(fixture.commit);
  const first = await runGithubRelayTurn({
    request,
    issueNumber: 108,
    targetRoot: fixture.root,
    codeLabRevision: OLD_RUNTIME,
    engineLockDigest: ENGINE_LOCK_DIGEST,
    backend: createBackend({ prompt: 'old disposable-root payload' })
  });
  const plan = first.actions.find(row => row.kind === 'PLAN').envelope;
  const oldTask = first.actions.find(row => row.kind === 'TASK').envelope.task;
  const oldResponse = responseFor(oldTask, { name: 'KNEEKURA-LAB' });

  const migrated = await runGithubRelayTurn({
    request,
    issueNumber: 108,
    targetRoot: fixture.root,
    codeLabRevision: NEW_RUNTIME,
    engineLockDigest: ENGINE_LOCK_DIGEST,
    backend: createBackend({ prompt: 'new canonical-root payload' }),
    existingPlan: plan,
    existingTaskIds: new Set([oldTask.task_id]),
    responses: [oldResponse],
    compatiblePlanCodeLabRevisions: new Set([OLD_RUNTIME])
  });

  assert.equal(migrated.replay.state, 'TASK_REQUIRED');
  assert.deepEqual(migrated.actions.map(row => row.kind), ['TASK']);
  const currentTask = migrated.actions[0].envelope.task;
  assert.notEqual(currentTask.task_id, oldTask.task_id);
  assert.notEqual(currentTask.payload_digest, oldTask.payload_digest);
});

test('runtime migration stays fail-closed unless the old plan revision is explicitly compatible', async t => {
  const fixture = await makeFixture(t);
  const request = requestFor(fixture.commit);
  const first = await runGithubRelayTurn({
    request,
    issueNumber: 109,
    targetRoot: fixture.root,
    codeLabRevision: OLD_RUNTIME,
    engineLockDigest: ENGINE_LOCK_DIGEST,
    backend: createBackend({ prompt: 'old' })
  });
  const plan = first.actions.find(row => row.kind === 'PLAN').envelope;

  await assert.rejects(
    runGithubRelayTurn({
      request,
      issueNumber: 109,
      targetRoot: fixture.root,
      codeLabRevision: NEW_RUNTIME,
      engineLockDigest: ENGINE_LOCK_DIGEST,
      backend: createBackend({ prompt: 'new' }),
      existingPlan: plan
    }),
    error => error?.code === 'RELAY_PLAN_CONFLICT'
  );
});

test('approved runtime migration still rejects engine-lock drift', async t => {
  const fixture = await makeFixture(t);
  const request = requestFor(fixture.commit);
  const first = await runGithubRelayTurn({
    request,
    issueNumber: 110,
    targetRoot: fixture.root,
    codeLabRevision: OLD_RUNTIME,
    engineLockDigest: ENGINE_LOCK_DIGEST,
    backend: createBackend({ prompt: 'old' })
  });
  const plan = first.actions.find(row => row.kind === 'PLAN').envelope;

  await assert.rejects(
    runGithubRelayTurn({
      request,
      issueNumber: 110,
      targetRoot: fixture.root,
      codeLabRevision: NEW_RUNTIME,
      engineLockDigest: `sha256:${'4'.repeat(64)}`,
      backend: createBackend({ prompt: 'new' }),
      existingPlan: plan,
      compatiblePlanCodeLabRevisions: new Set([OLD_RUNTIME])
    }),
    error => error?.code === 'RELAY_PLAN_CONFLICT'
  );
});

test('approved runtime migration does not ignore an unpublished foreign response', async t => {
  const fixture = await makeFixture(t);
  const request = requestFor(fixture.commit);
  const first = await runGithubRelayTurn({
    request,
    issueNumber: 111,
    targetRoot: fixture.root,
    codeLabRevision: OLD_RUNTIME,
    engineLockDigest: ENGINE_LOCK_DIGEST,
    backend: createBackend({ prompt: 'old' })
  });
  const plan = first.actions.find(row => row.kind === 'PLAN').envelope;
  const oldTask = first.actions.find(row => row.kind === 'TASK').envelope.task;
  const unpublished = createHostTask({
    runId: oldTask.run_id,
    engineId: oldTask.engine_id,
    attemptId: oldTask.attempt_id,
    snapshotId: oldTask.snapshot_id,
    scopeDigest: oldTask.scope_digest,
    ordinal: oldTask.ordinal,
    kind: oldTask.kind,
    payload: { prompt: 'never published by Relay' }
  });

  await assert.rejects(
    runGithubRelayTurn({
      request,
      issueNumber: 111,
      targetRoot: fixture.root,
      codeLabRevision: NEW_RUNTIME,
      engineLockDigest: ENGINE_LOCK_DIGEST,
      backend: createBackend({ prompt: 'new canonical task' }),
      existingPlan: plan,
      existingTaskIds: new Set([oldTask.task_id]),
      responses: [responseFor(unpublished, { forged: true })],
      compatiblePlanCodeLabRevisions: new Set([OLD_RUNTIME])
    }),
    error => error?.code === 'RELAY_RESPONSE_OUT_OF_ORDER'
  );
});

function createBackend({ prompt }) {
  let task = null;
  return {
    async execute(plan) {
      if (!task) {
        task = createHostTask({
          runId: plan.runId,
          engineId: 'understand-anything',
          attemptId: 'attempt-runtime-migration-1-understand-anything',
          snapshotId: plan.target.snapshotId,
          scopeDigest: plan.target.scopeDigest,
          ordinal: 1,
          kind: 'ua:project-scanner',
          payload: { prompt }
        });
      }
      throw new HostTaskRequiredError(task);
    },
    async acceptHostResponse() {
      throw new Error('no response should be rebound to the current task in this fixture');
    }
  };
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

async function makeFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kneekura-relay-runtime-migration-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  git(root, ['init']);
  git(root, ['config', 'user.email', 'fixture@example.invalid']);
  git(root, ['config', 'user.name', 'Fixture']);
  git(root, ['remote', 'add', 'origin', `https://github.com/${TARGET}.git`]);
  await fs.writeFile(path.join(root, 'README.md'), '# fixture\n', 'utf8');
  git(root, ['add', '--all']);
  git(root, ['commit', '-m', 'runtime migration fixture']);
  return { root, commit: git(root, ['rev-parse', 'HEAD']) };
}

function git(cwd, args) {
  return childProcess.execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
}
