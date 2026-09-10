import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import test from 'node:test';

import { resolveRepositoryIdentity } from '../src/core/identity/repository.mjs';
import { createCommitSnapshot } from '../src/core/identity/snapshot.mjs';
import { planKneekuraCodeLabMcpRequest } from '../mcp/src/adapter.mjs';
import { createHostBridgeProductionBackend } from '../mcp/src/production-backend.mjs';

function git(cwd, args) {
  return childProcess.execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
}

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kneekura-host-bridge-target-'));
  const tempParent = await fs.mkdtemp(path.join(os.tmpdir(), 'kneekura-host-bridge-work-'));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(tempParent, { recursive: true, force: true });
  });
  git(root, ['init']);
  git(root, ['config', 'user.email', 'fixture@example.invalid']);
  git(root, ['config', 'user.name', 'Fixture']);
  const relative = 'src/Main.java';
  const file = path.join(root, 'src', 'Main.java');
  await fs.mkdir(path.dirname(file), { recursive: true });
  const secret = 'ghp_abcdefghijklmnopqrstuvwxyz1234567890';
  const committed = [
    'package demo;',
    'public class ExactVersion {',
    `  String token = "${secret}";`,
    '}',
    ''
  ].join('\n');
  await fs.writeFile(file, committed, 'utf8');
  git(root, ['add', '--all']);
  git(root, ['commit', '-m', 'exact version']);
  const commit = git(root, ['rev-parse', 'HEAD']);
  const identity = await resolveRepositoryIdentity(root);
  const snapshot = createCommitSnapshot(identity, commit);
  const dirty = [
    'package demo;',
    'public class DirtyVersion {',
    '  String value = "workspace-only";',
    '}',
    ''
  ].join('\n');
  await fs.writeFile(file, dirty, 'utf8');
  return { root, tempParent, relative, committed, dirty, secret, commit, snapshot };
}

function makePlan(f, selection, runId, snapshotId = f.snapshot.snapshot_id) {
  return planKneekuraCodeLabMcpRequest({
    selection,
    runId,
    target: {
      repository: f.root,
      revision: f.commit,
      snapshotId,
      scopeDigest: sha256(`scope:${runId}`)
    },
    commonScope: { question: 'Explain the exact committed architecture.' },
    engineOptions: {},
    minimumClaimLevel: {}
  });
}

async function expectPending(backend, plan, kind) {
  let task = null;
  await assert.rejects(
    () => backend.execute(plan),
    error => {
      if (error?.code !== 'HOST_TASK_REQUIRED') return false;
      task = error.task;
      return task?.kind === kind;
    }
  );
  assert(task);
  assert.equal(task.snapshot_id, plan.target.snapshotId);
  assert.equal(task.scope_digest, plan.target.scopeDigest);
  return task;
}

test('production Host Bridge replays KNEEKURA over the exact commit and delivers a sealed result', async t => {
  const f = await fixture(t);
  const backend = createHostBridgeProductionBackend({ env: {}, tempParent: f.tempParent });
  const plan = makePlan(f, 'kneekura', 'host-kneekura-exact');

  const architecture = await expectPending(backend, plan, 'kneekura:ARCHITECTURE');
  const catalog = await backend.sourceCatalog(plan.runId, architecture.task_id, { limit: 20 });
  assert(catalog.entries.some(row => row.path === f.relative));

  const source = await backend.readSource(plan.runId, architecture.task_id, {
    path: f.relative,
    startLine: 1,
    endLine: 4
  });
  assert.match(source.text, /ExactVersion/);
  assert.doesNotMatch(source.text, /DirtyVersion/);
  assert.equal(source.text.includes(f.secret), false);
  assert.match(source.text, /\[REDACTED_GITHUB_TOKEN\]/);
  assert.equal(source.instruction_authority, false);
  assert.equal(source.trust_class, 'UNTRUSTED_REPOSITORY_DATA');
  assert.equal(source.content_digest, sha256(f.committed));

  await backend.acceptHostResponse(plan.runId, architecture.task_id, {
    items: [{
      kind: 'ARCHITECTURE_COMPONENT',
      semantic_class: 'AI_INTERPRETATION',
      title: 'Exact committed entrypoint',
      body: 'The committed Java source is the evidence-bound entrypoint for this fixture.',
      source_refs: [{
        kind: 'FILE_RANGE',
        path: f.relative,
        start_line: 1,
        end_line: 4,
        content_digest: source.content_digest
      }]
    }]
  });

  for (const stage of ['DOMAIN', 'FLOW', 'TOUR']) {
    const task = await expectPending(backend, plan, `kneekura:${stage}`);
    await backend.acceptHostResponse(plan.runId, task.task_id, { items: [] });
  }

  const reviewer = await expectPending(backend, plan, 'kneekura:REVIEWER');
  const candidates = reviewer.payload.semantic_input.candidate_items;
  assert.equal(candidates.length, 1);
  await backend.acceptHostResponse(plan.runId, reviewer.task_id, {
    decisions: candidates.map(item => ({
      item_id: item.id,
      status: 'ACCEPT',
      reason: 'Exact-source-linked Host Bridge fixture item.'
    }))
  });

  const execution = await backend.execute(plan);
  assert.equal(execution.kind, 'ENGINE_RESULT');
  assert.equal(execution.requestedEngine, 'kneekura');
  assert.equal(execution.result.receipt.status, 'SUCCESS');
  assert.equal(execution.result.receipt.snapshotId, f.snapshot.snapshot_id);
  assert.equal(execution.result.receipt.scopeDigest, plan.target.scopeDigest);
  assert(Buffer.isBuffer(execution.result.artifact.zip_bytes));

  const status = await backend.status(plan.runId);
  assert.equal(status.phase, 'COMPLETE');
  assert.equal(status.pending_task_id, null);
  assert.equal(status.host_bridge.accepted_response_count, 5);
  assert.equal(status.artifacts.length, 1);
  assert.equal(status.artifacts[0].id, 'kneekura:result.zip');
  assert.equal('bytes_buffer' in status.artifacts[0], false);

  const artifacts = await backend.artifactInfo(plan.runId);
  assert.equal(artifacts.length, 1);
  assert.match(artifacts[0].digest, /^sha256:[0-9a-f]{64}$/);
});

test('production Host Bridge rejects a supplied snapshot identity that does not match the exact Git commit', async t => {
  const f = await fixture(t);
  const backend = createHostBridgeProductionBackend({ env: {}, tempParent: f.tempParent });
  const plan = makePlan(
    f,
    'kneekura',
    'host-snapshot-mismatch',
    `snapshot:sha256:${'0'.repeat(64)}`
  );
  await assert.rejects(
    () => backend.execute(plan),
    error => error?.code === 'BLOCKED_TARGET_SNAPSHOT_MISMATCH'
  );
});

test('direct UA and Archify use direct attempt ordinal 1 before reporting missing pinned upstreams', async t => {
  const f = await fixture(t);
  for (const [selection, expectedCode] of [
    ['understand-anything', 'BLOCKED_UA_ROOT_UNAVAILABLE'],
    ['archify', 'BLOCKED_ARCHIFY_ROOT_UNAVAILABLE']
  ]) {
    const backend = createHostBridgeProductionBackend({ env: {}, tempParent: f.tempParent });
    const plan = makePlan(f, selection, `host-direct-${selection.replaceAll('-', '')}`);
    await assert.rejects(
      () => backend.execute(plan),
      error => error?.code === expectedCode
    );
  }
});

test('all-mode propagates HOST_TASK_REQUIRED instead of mislabeling pending host work as engine failure', async t => {
  const f = await fixture(t);
  const backend = createHostBridgeProductionBackend({ env: {}, tempParent: f.tempParent });
  const plan = makePlan(f, 'all', 'host-all-pending');
  const task = await expectPending(backend, plan, 'kneekura:ARCHITECTURE');
  assert.equal(task.engine_id, 'kneekura');
  assert.match(task.attempt_id, /-1-kneekura$/);
  const status = await backend.status(plan.runId);
  assert.equal(status.phase, 'PENDING');
  assert.equal(status.error, null);
});