import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createHostBridgeProductionBackend } from '../mcp/src/production-backend.mjs';
import { GITHUB_RELAY_SCHEMAS, validateRelaySourceRequest } from '../src/github-relay/contracts.mjs';
import { runGithubRelayTurn } from '../src/github-relay/orchestrator.mjs';

const TARGET = 'genkimorimori252525-oss/KNEEKURA-LAB';
const CODE_LAB_REVISION = 'b'.repeat(40);
const ENGINE_LOCK_DIGEST = `sha256:${'c'.repeat(64)}`;

test('production Source Broker preserves pending task identity across fresh equivalent Relay target roots', async t => {
  const fixture = await makeFixture(t);
  const request = {
    schema: GITHUB_RELAY_SCHEMAS.request,
    selection: 'kneekura',
    target: { repository: TARGET, revision: fixture.commit },
    commonScope: { question: 'Explain the exact committed architecture across disposable Relay roots.' }
  };
  const first = await runGithubRelayTurn({
    request, issueNumber: 74, targetRoot: fixture.rootA,
    codeLabRevision: CODE_LAB_REVISION, engineLockDigest: ENGINE_LOCK_DIGEST,
    backend: createHostBridgeProductionBackend({ env: {}, tempParent: fixture.workA })
  });
  assert.deepEqual(first.actions.map(row => row.kind), ['PLAN', 'TASK']);
  const task = first.actions.find(row => row.kind === 'TASK').envelope.task;
  const existingPlan = first.actions.find(row => row.kind === 'PLAN').envelope;
  assert.equal(JSON.stringify(task.payload).includes(fixture.rootA), false);
  assert.equal(task.payload.target.repository, `git:github.com/${TARGET.toLowerCase()}`);
  const sourceRequest = validateRelaySourceRequest({
    schema: GITHUB_RELAY_SCHEMAS.sourceRequest,
    run_id: first.run_id,
    task_id: task.task_id,
    path: 'src/Main.java',
    start_line: 1,
    end_line: 2
  });
  const second = await runGithubRelayTurn({
    request, issueNumber: 74, targetRoot: fixture.rootB,
    codeLabRevision: CODE_LAB_REVISION, engineLockDigest: ENGINE_LOCK_DIGEST,
    backend: createHostBridgeProductionBackend({ env: {}, tempParent: fixture.workB }),
    existingPlan,
    existingTaskIds: new Set([task.task_id]),
    sourceRequests: [{ comment_id: 20, envelope: sourceRequest }]
  });
  assert.deepEqual(second.actions.map(row => row.kind), ['SOURCE_RESULT']);
  assert.equal(second.actions[0].envelope.task_id, task.task_id);
  assert.equal(second.actions[0].envelope.source.path, 'src/Main.java');
  assert.equal(second.actions[0].envelope.source.instruction_authority, false);
});

async function makeFixture(t) {
  const rootA = await fs.mkdtemp(path.join(os.tmpdir(), 'kneekura-relay-fresh-a-'));
  const rootBParent = await fs.mkdtemp(path.join(os.tmpdir(), 'kneekura-relay-fresh-b-'));
  const rootB = path.join(rootBParent, 'target');
  const workA = await fs.mkdtemp(path.join(os.tmpdir(), 'kneekura-relay-work-a-'));
  const workB = await fs.mkdtemp(path.join(os.tmpdir(), 'kneekura-relay-work-b-'));
  t.after(async () => {
    for (const value of [rootA, rootBParent, workA, workB]) await fs.rm(value, { recursive: true, force: true });
  });
  git(rootA, ['init']);
  git(rootA, ['config', 'user.email', 'fixture@example.invalid']);
  git(rootA, ['config', 'user.name', 'Fixture']);
  git(rootA, ['remote', 'add', 'origin', `https://github.com/${TARGET}.git`]);
  await fs.mkdir(path.join(rootA, 'src'), { recursive: true });
  await fs.writeFile(
    path.join(rootA, 'src', 'Main.java'),
    'package demo;\npublic class Main {}\n',
    'utf8'
  );
  git(rootA, ['add', '--all']);
  git(rootA, ['commit', '-m', 'fresh root fixture']);
  const commit = git(rootA, ['rev-parse', 'HEAD']);
  await fs.cp(rootA, rootB, { recursive: true });
  return { rootA, rootB, workA, workB, commit };
}

function git(cwd, args) {
  return childProcess.execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
}
