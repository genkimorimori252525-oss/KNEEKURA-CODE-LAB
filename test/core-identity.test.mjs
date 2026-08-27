import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  createRepositoryIdentity,
  normalizeGitRemote,
  resolveRepositoryIdentity
} from '../src/core/identity/repository.mjs';
import {
  assertWorkspaceSnapshotUnchanged,
  captureWorkspaceSnapshot,
  createCommitSnapshot,
  createMultiRepoSnapshot,
  createWorkspaceSnapshot
} from '../src/core/identity/snapshot.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const identityFixture = JSON.parse(await fs.readFile(path.join(ROOT, 'fixtures/core/pr-a/identity.json'), 'utf8'));
const workspaceFixture = JSON.parse(await fs.readFile(path.join(ROOT, 'fixtures/core/pr-a/workspace-states.json'), 'utf8'));
const execFileAsync = promisify(execFile);

test('RepositoryIdentity canonicalizes common GitHub remote spellings without local path influence', () => {
  const ids = identityFixture.equivalentRemotes.map((remote, index) => createRepositoryIdentity({
    root: index === 0 ? 'C:\\Users\\one\\repo' : `/tmp/checkout-${index}`,
    remote,
    vcs: 'git',
    objectFormat: 'sha1'
  }));
  assert.equal(new Set(ids.map(identity => identity.repository_id)).size, 1);
  assert.equal(normalizeGitRemote(identityFixture.equivalentRemotes[0]), 'github.com/genkimorimori252525-oss/kneekura-code-lab');
});

test('RepositoryIdentity preserves Windows drive local remotes without dropping drive identity', () => {
  assert.equal(normalizeGitRemote('C:\\Users\\one\\repo.git'), 'local:c:/Users/one/repo');
  assert.equal(normalizeGitRemote('c:/Users/one/repo.git'), 'local:c:/Users/one/repo');
  assert.notEqual(
    createRepositoryIdentity({ root: '/tmp/a', remote: 'C:\\repos\\same.git', vcs: 'git' }).repository_id,
    createRepositoryIdentity({ root: '/tmp/b', remote: 'D:\\repos\\same.git', vcs: 'git' }).repository_id
  );
});

test('RepositoryIdentity avoids lossy path-replacement collisions and remains stable', () => {
  const [leftRoot, rightRoot] = identityFixture.localCollisionRoots;
  const left = createRepositoryIdentity({ root: path.join(ROOT, leftRoot) });
  const right = createRepositoryIdentity({ root: path.join(ROOT, rightRoot) });
  const repeated = createRepositoryIdentity({ root: path.join(ROOT, leftRoot) });
  assert.notEqual(left.repository_id, right.repository_id);
  assert.equal(left.repository_id, repeated.repository_id);
});

test('RepositoryIdentity no-remote fallback can use stable initial Git identity', () => {
  const a = createRepositoryIdentity({ root: '/tmp/checkout-a', vcs: 'git', fallbackIdentity: 'root-commit-1', objectFormat: 'sha1' });
  const b = createRepositoryIdentity({ root: 'C:\\checkout-b', vcs: 'git', fallbackIdentity: 'root-commit-1', objectFormat: 'sha1' });
  assert.equal(a.repository_id, b.repository_id);
});

test('Malformed Git metadata falls back safely without mutating the repository', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kneekura-invalid-git-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, '.git'));
  await fs.writeFile(path.join(dir, '.git', 'HEAD'), 'not a valid ref\n');
  const identity = await resolveRepositoryIdentity(dir);
  assert.equal(identity.vcs, 'git');
  assert.match(identity.repository_id, /^repo:sha256:[0-9a-f]{64}$/);
});

test('COMMIT SnapshotIdentity is stable for repository + SHA and separates repositories or commits', () => {
  const repoA = createRepositoryIdentity({ root: '/tmp/repo-a' });
  const repoB = createRepositoryIdentity({ root: '/tmp/repo-b' });
  const sameA = createCommitSnapshot(repoA, 'a'.repeat(40));
  const sameB = createCommitSnapshot(repoA, 'a'.repeat(40));
  const changedSha = createCommitSnapshot(repoA, 'b'.repeat(40));
  const changedRepo = createCommitSnapshot(repoB, 'a'.repeat(40));
  assert.equal(sameA.snapshot_id, sameB.snapshot_id);
  assert.notEqual(sameA.snapshot_id, changedSha.snapshot_id);
  assert.notEqual(sameA.snapshot_id, changedRepo.snapshot_id);
});

test('WORKSPACE SnapshotIdentity distinguishes tracked, modified, untracked and deleted state on the same HEAD', () => {
  const repo = createRepositoryIdentity({ root: '/tmp/repo' });
  const base = workspaceFixture.baseCommit;
  const tracked = createWorkspaceSnapshot(repo, { baseCommit: base, entries: [
    { path: 'src/A.java', state: 'TRACKED', digest: workspaceFixture.trackedDigest }
  ]});
  const modified = createWorkspaceSnapshot(repo, { baseCommit: base, entries: [
    { path: 'src/A.java', state: 'MODIFIED', digest: workspaceFixture.modifiedDigest }
  ]});
  const untracked = createWorkspaceSnapshot(repo, { baseCommit: base, entries: [
    { path: 'src/A.java', state: 'TRACKED', digest: workspaceFixture.trackedDigest },
    { path: 'src/New.java', state: 'UNTRACKED', digest: workspaceFixture.untrackedDigest }
  ]});
  const deleted = createWorkspaceSnapshot(repo, { baseCommit: base, entries: [
    { path: 'src/A.java', state: 'DELETED', digest: null }
  ]});
  assert.equal(new Set([tracked, modified, untracked, deleted].map(snapshot => snapshot.snapshot_id)).size, 4);
  assert.equal(createWorkspaceSnapshot(repo, { baseCommit: base, entries: [
    { path: 'src/A.java', state: 'TRACKED', digest: workspaceFixture.trackedDigest }
  ]}).snapshot_id, tracked.snapshot_id);
});

test('WORKSPACE SnapshotIdentity represents a porcelain -z rename as modified destination plus deleted source', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kneekura-snapshot-rename-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  await execFileAsync('git', ['-C', dir, 'init']);
  await execFileAsync('git', ['-C', dir, 'config', 'user.email', 'fixture@example.invalid']);
  await execFileAsync('git', ['-C', dir, 'config', 'user.name', 'Fixture']);
  await fs.writeFile(path.join(dir, 'Old.java'), 'class Old {}\n');
  await execFileAsync('git', ['-C', dir, 'add', 'Old.java']);
  await execFileAsync('git', ['-C', dir, 'commit', '-m', 'fixture']);
  await execFileAsync('git', ['-C', dir, 'mv', 'Old.java', 'Renamed.java']);

  const repository = await resolveRepositoryIdentity(dir);
  const snapshot = await captureWorkspaceSnapshot(dir, repository);
  const byPath = new Map(snapshot.content_manifest.map(entry => [entry.path, entry]));

  assert.equal(byPath.get('Renamed.java')?.state, 'MODIFIED');
  assert.equal(byPath.get('Old.java')?.state, 'DELETED');
  assert.equal(byPath.get('Old.java')?.digest, null);
});

test('MULTI_REPO SnapshotIdentity changes when one constituent changes', () => {
  const repoA = createRepositoryIdentity({ root: '/tmp/a' });
  const repoB = createRepositoryIdentity({ root: '/tmp/b' });
  const a1 = createCommitSnapshot(repoA, 'a'.repeat(40));
  const a2 = createCommitSnapshot(repoA, 'b'.repeat(40));
  const b1 = createCommitSnapshot(repoB, 'c'.repeat(40));
  assert.notEqual(createMultiRepoSnapshot([a1, b1]).snapshot_id, createMultiRepoSnapshot([a2, b1]).snapshot_id);
});

test('workspace mutation after freeze is rejected as SNAPSHOT_CHANGED', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kneekura-snapshot-race-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'Race.java');
  await fs.writeFile(source, 'class Race {}\n');
  const repository = createRepositoryIdentity({ root: dir });
  const before = await captureWorkspaceSnapshot(dir, repository);
  await fs.writeFile(source, 'class Race { int changed; }\n');
  const after = await captureWorkspaceSnapshot(dir, repository);
  assert.throws(
    () => assertWorkspaceSnapshotUnchanged(before, after),
    error => error?.code === 'SNAPSHOT_CHANGED' && error.expected_snapshot_id === before.snapshot_id
  );
});
