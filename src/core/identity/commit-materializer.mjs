import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  createCommitSnapshot
} from './snapshot.mjs';
import {
  isAnalyzableRepositoryPath
} from '../walk.mjs';

const execFileAsync = promisify(execFile);

export async function materializeCommitAnalysisRoot(
  repositoryRoot,
  repositoryIdentity,
  commitSha,
  {
    tempParent = os.tmpdir()
  } = {}
) {
  const sourceRoot = path.resolve(repositoryRoot);
  const snapshotIdentity = createCommitSnapshot(
    repositoryIdentity,
    commitSha
  );
  const commit = snapshotIdentity.base_commit;

  await assertCommitObject(sourceRoot, commit);

  const materializedRoot = await fs.mkdtemp(
    path.join(path.resolve(tempParent), 'kneekura-commit-')
  );
  let cleaned = false;

  async function cleanup() {
    if (cleaned) return;
    cleaned = true;
    await fs.rm(materializedRoot, {
      recursive: true,
      force: true
    });
  }

  try {
    const entries = await listCommitTree(sourceRoot, commit);
    const selected = entries
      .filter(entry =>
        entry.type === 'blob' &&
        entry.mode !== '120000' &&
        isAnalyzableRepositoryPath(entry.path)
      )
      .sort((a, b) => a.path.localeCompare(b.path));

    for (const entry of selected) {
      const destination = safeDestination(
        materializedRoot,
        entry.path
      );
      const bytes = await gitBuffer(
        sourceRoot,
        ['cat-file', 'blob', entry.object_id]
      );
      await fs.mkdir(path.dirname(destination), {
        recursive: true
      });
      await fs.writeFile(destination, bytes);
    }

    return {
      root: materializedRoot,
      snapshotIdentity,
      materialized_files: selected.map(entry => entry.path),
      cleanup
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

async function assertCommitObject(root, commit) {
  let type;
  try {
    type = (await gitText(
      root,
      ['cat-file', '-t', commit]
    )).trim();
  } catch (error) {
    throw codedError(
      'INVALID_REQUEST',
      'snapshot_selector commit does not exist in the target repository',
      error
    );
  }

  if (type !== 'commit') {
    throw codedError(
      'INVALID_REQUEST',
      'snapshot_selector must reference a Git commit object'
    );
  }

  const resolved = (await gitText(
    root,
    ['rev-parse', '--verify', commit]
  )).trim().toLowerCase();

  if (resolved !== commit.toLowerCase()) {
    throw codedError(
      'INVALID_REQUEST',
      'snapshot_selector commit did not resolve to the exact requested object'
    );
  }
}

async function listCommitTree(root, commit) {
  const output = await gitText(
    root,
    ['ls-tree', '-r', '-z', commit]
  );
  const records = output.split('\0').filter(Boolean);
  return records.map(parseTreeEntry);
}

function parseTreeEntry(record) {
  const tab = record.indexOf('\t');
  if (tab <= 0) {
    throw codedError(
      'INTERNAL_INVARIANT',
      'git ls-tree returned a malformed record'
    );
  }

  const metadata = record.slice(0, tab).split(' ');
  const relativePath = record.slice(tab + 1);
  if (
    metadata.length !== 3 ||
    !/^[0-9]{6}$/.test(metadata[0]) ||
    !/^[a-z]+$/.test(metadata[1]) ||
    !/^[0-9a-f]{40,64}$/i.test(metadata[2])
  ) {
    throw codedError(
      'INTERNAL_INVARIANT',
      'git ls-tree returned malformed metadata'
    );
  }

  return {
    mode: metadata[0],
    type: metadata[1],
    object_id: metadata[2].toLowerCase(),
    path: safeRelativeGitPath(relativePath)
  };
}

function safeRelativeGitPath(value) {
  if (
    typeof value !== 'string' ||
    !value ||
    value.includes('\uFFFD') ||
    value.includes('\\') ||
    value.includes('\0') ||
    path.posix.isAbsolute(value) ||
    /^[A-Za-z]:/.test(value)
  ) {
    throw codedError(
      'TRUST_BOUNDARY_VIOLATION',
      'commit tree contains an unsafe repository path'
    );
  }

  const normalized = path.posix.normalize(value);
  if (
    normalized !== value ||
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.includes('/../')
  ) {
    throw codedError(
      'TRUST_BOUNDARY_VIOLATION',
      'commit tree path escapes the materialized snapshot root'
    );
  }

  return normalized;
}

function safeDestination(root, relativePath) {
  const destination = path.resolve(
    root,
    ...relativePath.split('/')
  );
  const prefix = root.endsWith(path.sep)
    ? root
    : root + path.sep;
  if (
    destination !== root &&
    !destination.startsWith(prefix)
  ) {
    throw codedError(
      'TRUST_BOUNDARY_VIOLATION',
      'commit materialization escaped the CORE-owned snapshot root'
    );
  }
  return destination;
}

async function gitText(root, args) {
  const { stdout } = await execFileAsync(
    'git',
    ['-C', root, ...args],
    {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024
    }
  );
  return stdout;
}

async function gitBuffer(root, args) {
  const { stdout } = await execFileAsync(
    'git',
    ['-C', root, ...args],
    {
      encoding: null,
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024
    }
  );
  return Buffer.isBuffer(stdout)
    ? stdout
    : Buffer.from(stdout);
}

function codedError(code, message, cause = null) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}
