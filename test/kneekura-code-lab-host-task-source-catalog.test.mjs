import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { planKneekuraCodeLabMcpRequest } from '../mcp/src/adapter.mjs';
import { createHostBridgeProductionBackend } from '../mcp/src/production-backend.mjs';
import { resolveRepositoryIdentity } from '../src/core/identity/repository.mjs';
import { createCommitSnapshot } from '../src/core/identity/snapshot.mjs';

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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kneekura-host-catalog-target-'));
  const tempParent = await fs.mkdtemp(path.join(os.tmpdir(), 'kneekura-host-catalog-work-'));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(tempParent, { recursive: true, force: true });
  });

  git(root, ['init']);
  git(root, ['config', 'user.email', 'fixture@example.invalid']);
  git(root, ['config', 'user.name', 'Fixture']);

  const relative = 'src/Main.java';
  const source = ['package demo;', 'public class Main {}'].join('\n');
  const file = path.join(root, ...relative.split('/'));
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, source, 'utf8');
  await fs.writeFile(path.join(root, 'README.md'), 'must stay outside analyzable source catalog', 'utf8');

  git(root, ['add', '--all']);
  git(root, ['commit', '-m', 'catalog fixture']);
  const commit = git(root, ['rev-parse', 'HEAD']);
  const identity = await resolveRepositoryIdentity(root);
  const snapshot = createCommitSnapshot(identity, commit);
  return { root, tempParent, relative, source, commit, snapshot };
}

function makePlan(f) {
  return planKneekuraCodeLabMcpRequest({
    selection: 'kneekura',
    runId: 'host-public-source-catalog',
    target: {
      repository: f.root,
      revision: f.commit,
      snapshotId: f.snapshot.snapshot_id,
      scopeDigest: sha256('scope:host-public-source-catalog')
    },
    commonScope: { question: 'Explain this exact committed architecture.' },
    engineOptions: {},
    minimumClaimLevel: {}
  });
}

async function pendingArchitectureTask(backend, plan) {
  let task = null;
  await assert.rejects(
    () => backend.execute(plan),
    error => {
      if (error?.code !== 'HOST_TASK_REQUIRED') return false;
      task = error.task;
      return task?.kind === 'kneekura:ARCHITECTURE';
    }
  );
  assert(task);
  return task;
}

test('public Host Task exposes exact bounded Source Catalog metadata without repository text', async t => {
  const f = await fixture(t);
  const backend = createHostBridgeProductionBackend({ env: {}, tempParent: f.tempParent });
  const plan = makePlan(f);
  const task = await pendingArchitectureTask(backend, plan);

  assert.deepEqual(task.payload.source_catalog, {
    entry_count: 1,
    browse_via_host_bridge: true,
    direct_repository_text_embedded: false,
    entries: [{
      path: f.relative,
      content_digest: sha256(f.source),
      line_count: 2,
      bytes: Buffer.byteLength(f.source, 'utf8')
    }]
  });
  assert.equal(JSON.stringify(task.payload.source_catalog).includes('public class Main'), false);
  assert.equal(JSON.stringify(task.payload.source_catalog).includes('README.md'), false);
});