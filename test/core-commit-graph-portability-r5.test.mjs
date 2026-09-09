import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { scanRepository } from '../src/core/scan.mjs';
import {
  createRepositoryIdentity
} from '../src/core/identity/repository.mjs';
import {
  createCommitSnapshot
} from '../src/core/identity/snapshot.mjs';

async function makeFixture(prefix) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await fs.writeFile(
    path.join(root, 'b.js'),
    'export function beta() { return 2; }\n',
    'utf8'
  );
  await fs.writeFile(
    path.join(root, 'a.js'),
    'export function alpha() { return beta(); }\n',
    'utf8'
  );
  return root;
}

test('R5 COMMIT scan graph is portable across fresh checkout roots', async () => {
  const firstRoot = await makeFixture('kneekura-r5-commit-a-');
  const secondRoot = await makeFixture('kneekura-r5-commit-b-');
  try {
    const repository = createRepositoryIdentity({
      root: firstRoot,
      vcs: 'filesystem',
      fallbackIdentity: 'r5-portable-commit-fixture'
    });
    const snapshot = createCommitSnapshot(
      repository,
      'a'.repeat(40)
    );

    const first = await scanRepository(firstRoot, {
      repositoryIdentity: repository,
      snapshotIdentity: snapshot
    });
    await new Promise(resolve => setTimeout(resolve, 5));
    const second = await scanRepository(secondRoot, {
      repositoryIdentity: repository,
      snapshotIdentity: snapshot
    });

    assert.equal(Object.hasOwn(first, 'generatedAt'), false);
    assert.equal(Object.hasOwn(first, 'root'), false);
    assert.equal(Object.hasOwn(second, 'generatedAt'), false);
    assert.equal(Object.hasOwn(second, 'root'), false);
    assert.deepEqual(second, first);
    assert.deepEqual(
      first.nodes.map(node => node.id),
      [...first.nodes.map(node => node.id)].sort()
    );
    assert.deepEqual(
      first.edges.map(edge => edge.id),
      [...first.edges.map(edge => edge.id)].sort()
    );
  } finally {
    await fs.rm(firstRoot, { recursive: true, force: true });
    await fs.rm(secondRoot, { recursive: true, force: true });
  }
});