import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';

import {
  HARDENED_GIT_READ_POLICY,
  materializeCommitAnalysisRoot
} from '../src/core/identity/commit-materializer.mjs';
import {
  createRepositoryIdentity
} from '../src/core/identity/repository.mjs';

const execFileAsync = promisify(execFile);

async function git(root, args) {
  const { stdout } = await execFileAsync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024
  });
  return stdout.trim();
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kneekura-replace-fixture-'));
  const tempParent = await fs.mkdtemp(path.join(os.tmpdir(), 'kneekura-replace-out-'));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(tempParent, { recursive: true, force: true });
  });
  await git(root, ['init']);
  await git(root, ['config', 'user.email', 'fixture@example.invalid']);
  await git(root, ['config', 'user.name', 'Fixture']);
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'src', 'Identity.java'), 'class OriginalIdentity {}\n');
  await git(root, ['add', '.']);
  await git(root, ['commit', '-m', 'original']);
  const original = await git(root, ['rev-parse', 'HEAD']);
  await fs.writeFile(path.join(root, 'src', 'Identity.java'), 'class ReplacementIdentity {}\n');
  await git(root, ['add', '.']);
  await git(root, ['commit', '-m', 'replacement']);
  const replacement = await git(root, ['rev-parse', 'HEAD']);
  return { root, tempParent, original, replacement };
}

test('canonical commit materializer ignores refs/replace and rehashes commit/tree/blob bytes', async t => {
  const f = await fixture(t);
  await git(f.root, ['replace', f.original, f.replacement]);
  assert.equal(await git(f.root, ['rev-parse', `${f.original}^{tree}`]), await git(f.root, ['rev-parse', `${f.replacement}^{tree}`]));

  const repositoryIdentity = createRepositoryIdentity({
    root: f.root,
    vcs: 'git',
    fallbackIdentity: 'replace-fixture'
  });
  const materialized = await materializeCommitAnalysisRoot(
    f.root,
    repositoryIdentity,
    f.original,
    { tempParent: f.tempParent }
  );
  t.after(() => materialized.cleanup());

  const source = await fs.readFile(path.join(materialized.root, 'src', 'Identity.java'), 'utf8');
  assert.equal(source, 'class OriginalIdentity {}\n');
  assert.equal(materialized.snapshotIdentity.base_commit, f.original);
  assert.equal(materialized.integrity.replace_objects_disabled, true);
  assert.equal(materialized.integrity.lazy_fetch_disabled, true);
  assert.equal(materialized.integrity.commit_object_verified, true);
  assert.equal(materialized.integrity.tree_object_verified, true);
  assert.equal(materialized.integrity.blobs_verified, 1);
});

test('canonical Git-read policy mechanically disables replacement objects and lazy fetch', () => {
  assert.deepEqual(HARDENED_GIT_READ_POLICY.global_args, ['--no-replace-objects']);
  assert.equal(HARDENED_GIT_READ_POLICY.environment.GIT_NO_REPLACE_OBJECTS, '1');
  assert.equal(HARDENED_GIT_READ_POLICY.environment.GIT_NO_LAZY_FETCH, '1');
});