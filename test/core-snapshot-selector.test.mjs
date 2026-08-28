import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  analyzeInternal
} from '../src/core/api/analyze.mjs';

const execFileAsync = promisify(execFile);

async function git(root, args) {
  const { stdout } = await execFileAsync(
    'git',
    ['-C', root, ...args],
    {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024
    }
  );
  return stdout.trim();
}

async function createVersionedRepository(t) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'kneekura-commit-selector-repo-')
  );
  const tempParent = await fs.mkdtemp(
    path.join(os.tmpdir(), 'kneekura-commit-selector-temp-')
  );
  t.after(async () => {
    await fs.rm(root, {
      recursive: true,
      force: true
    });
    await fs.rm(tempParent, {
      recursive: true,
      force: true
    });
  });

  await git(root, ['init']);
  await git(root, [
    'config',
    'user.email',
    'fixture@example.invalid'
  ]);
  await git(root, [
    'config',
    'user.name',
    'Fixture'
  ]);

  const source = path.join(root, 'src', 'Versioned.java');
  await fs.mkdir(path.dirname(source), {
    recursive: true
  });
  await fs.writeFile(
    source,
    [
      'package demo;',
      'public class OldVersion {',
      '  void oldPath() {}',
      '}',
      ''
    ].join('\n'),
    'utf8'
  );
  await git(root, ['add', 'src/Versioned.java']);
  await git(root, ['commit', '-m', 'old version']);
  const oldCommit = await git(root, ['rev-parse', 'HEAD']);

  await fs.writeFile(
    source,
    [
      'package demo;',
      'public class NewVersion {',
      '  void newPath() {}',
      '}',
      ''
    ].join('\n'),
    'utf8'
  );
  await git(root, ['add', 'src/Versioned.java']);
  await git(root, ['commit', '-m', 'new version']);
  const currentCommit = await git(root, ['rev-parse', 'HEAD']);

  const dirtySource = [
    'package demo;',
    'public class DirtyVersion {',
    '  void dirtyPath() {}',
    '}',
    ''
  ].join('\n');
  await fs.writeFile(source, dirtySource, 'utf8');

  return {
    root,
    tempParent,
    source,
    dirtySource,
    oldCommit,
    currentCommit
  };
}

function request(root, snapshotSelector) {
  return {
    schema: 'core.analysis-request/v1',
    repository: root,
    snapshot_selector: snapshotSelector,
    mode: 'UNDERSTAND',
    question: 'Inspect the selected source snapshot.',
    scope: {
      paths: ['src/Versioned.java']
    },
    policy: 'precision',
    output_profile: 'compact'
  };
}

test('COMMIT snapshot_selector analyzes exact Git blobs without mutating the target workspace', async t => {
  const fixture = await createVersionedRepository(t);
  const statusBefore = await git(
    fixture.root,
    ['status', '--porcelain=v1']
  );
  const headBefore = await git(
    fixture.root,
    ['rev-parse', 'HEAD']
  );

  const execution = await analyzeInternal(
    request(fixture.root, {
      kind: 'COMMIT',
      commit: fixture.oldCommit
    }),
    {
      commitMaterialization: {
        tempParent: fixture.tempParent
      }
    }
  );

  assert.equal(
    execution.result.snapshot.kind,
    'COMMIT'
  );
  assert.equal(
    execution.result.snapshot.base_commit,
    fixture.oldCommit
  );
  assert.equal(
    execution.state.graph.root,
    path.resolve(fixture.root)
  );

  const classKeys = execution.state.graph.nodes
    .filter(node => node.kind === 'class')
    .map(node => node.key);
  assert.equal(
    classKeys.includes('demo.OldVersion'),
    true
  );
  assert.equal(
    classKeys.includes('demo.NewVersion'),
    false
  );
  assert.equal(
    classKeys.includes('demo.DirtyVersion'),
    false
  );

  for (const evidence of execution.result.evidence) {
    assert.equal(
      evidence.provenance.repository_id,
      execution.result.repository.repository_id
    );
    assert.equal(
      evidence.provenance.snapshot_id,
      execution.result.snapshot.snapshot_id
    );
  }

  assert.equal(
    await fs.readFile(fixture.source, 'utf8'),
    fixture.dirtySource
  );
  assert.equal(
    await git(fixture.root, ['rev-parse', 'HEAD']),
    headBefore
  );
  assert.equal(
    await git(fixture.root, ['status', '--porcelain=v1']),
    statusBefore
  );
  assert.equal(headBefore, fixture.currentCommit);

  assert.deepEqual(
    await fs.readdir(fixture.tempParent),
    []
  );
});

test('same COMMIT selector is deterministic across different temporary materializations', async t => {
  const fixture = await createVersionedRepository(t);

  const first = await analyzeInternal(
    request(fixture.root, {
      kind: 'COMMIT',
      commit: fixture.oldCommit
    }),
    {
      commitMaterialization: {
        tempParent: fixture.tempParent
      }
    }
  );
  const second = await analyzeInternal(
    request(fixture.root, {
      kind: 'COMMIT',
      commit: fixture.oldCommit
    }),
    {
      commitMaterialization: {
        tempParent: fixture.tempParent
      }
    }
  );

  assert.equal(
    first.result.snapshot.snapshot_id,
    second.result.snapshot.snapshot_id
  );
  assert.equal(
    first.result.analysis_id,
    second.result.analysis_id
  );
  assert.deepEqual(
    first.result.evidence.map(item => item.id),
    second.result.evidence.map(item => item.id)
  );
  assert.deepEqual(
    await fs.readdir(fixture.tempParent),
    []
  );
});

test('WORKSPACE snapshot_selector explicitly keeps current frozen workspace semantics', async t => {
  const fixture = await createVersionedRepository(t);

  const execution = await analyzeInternal(
    request(fixture.root, {
      kind: 'WORKSPACE'
    })
  );

  assert.equal(
    execution.result.snapshot.kind,
    'WORKSPACE'
  );
  assert.equal(
    execution.result.snapshot.base_commit,
    fixture.currentCommit
  );

  const classKeys = execution.state.graph.nodes
    .filter(node => node.kind === 'class')
    .map(node => node.key);
  assert.equal(
    classKeys.includes('demo.DirtyVersion'),
    true
  );
  assert.equal(
    classKeys.includes('demo.OldVersion'),
    false
  );
});

test('COMMIT snapshot_selector rejects a missing commit instead of falling back to the workspace', async t => {
  const fixture = await createVersionedRepository(t);

  await assert.rejects(
    () => analyzeInternal(
      request(fixture.root, {
        kind: 'COMMIT',
        commit: 'f'.repeat(40)
      })
    ),
    error =>
      error?.code === 'INVALID_REQUEST' &&
      /does not exist/.test(error.message)
  );

  assert.equal(
    await fs.readFile(fixture.source, 'utf8'),
    fixture.dirtySource
  );
});

test('unsupported snapshot_selector kinds fail instead of being silently ignored', async t => {
  const fixture = await createVersionedRepository(t);

  await assert.rejects(
    () => analyzeInternal(
      request(fixture.root, {
        kind: 'ARCHIVE'
      })
    ),
    error =>
      error?.code === 'INVALID_REQUEST' &&
      /not supported/.test(error.message)
  );
});
