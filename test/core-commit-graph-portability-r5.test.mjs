import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  canonicalizeGraphForSnapshot
} from '../src/core/graph.mjs';
import { scanRepository } from '../src/core/scan.mjs';
import { createRepositoryIdentity } from '../src/core/identity/repository.mjs';
import { createCommitSnapshot } from '../src/core/identity/snapshot.mjs';

async function makeFixture(prefix) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await fs.writeFile(path.join(root, 'b.js'), 'export function beta() { return 2; }\n', 'utf8');
  await fs.writeFile(path.join(root, 'a.js'), 'export function alpha() { return beta(); }\n', 'utf8');
  return root;
}

test('R5 COMMIT canonical graph is portable while raw execution metadata remains available', async () => {
  const firstRoot = await makeFixture('kneekura-r5-commit-a-');
  const secondRoot = await makeFixture('kneekura-r5-commit-b-');
  try {
    const repository = createRepositoryIdentity({
      root: firstRoot,
      vcs: 'filesystem',
      fallbackIdentity: 'r5-portable-commit-fixture'
    });
    const snapshot = createCommitSnapshot(repository, 'a'.repeat(40));
    const first = await scanRepository(firstRoot, { repositoryIdentity: repository, snapshotIdentity: snapshot });
    await new Promise(resolve => setTimeout(resolve, 5));
    const second = await scanRepository(secondRoot, { repositoryIdentity: repository, snapshotIdentity: snapshot });

    assert.equal(first.root, path.resolve(firstRoot));
    assert.equal(second.root, path.resolve(secondRoot));
    assert.equal(typeof first.generatedAt, 'string');
    assert.equal(typeof second.generatedAt, 'string');

    const firstCanonical = canonicalizeGraphForSnapshot(first);
    const secondCanonical = canonicalizeGraphForSnapshot(second);
    assert.equal(Object.hasOwn(firstCanonical, 'root'), false);
    assert.equal(Object.hasOwn(firstCanonical, 'generatedAt'), false);
    assert.deepEqual(secondCanonical, firstCanonical);
  } finally {
    await fs.rm(firstRoot, { recursive: true, force: true });
    await fs.rm(secondRoot, { recursive: true, force: true });
  }
});