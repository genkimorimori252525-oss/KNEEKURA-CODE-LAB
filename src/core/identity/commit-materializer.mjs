import crypto from 'node:crypto';
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

export const HARDENED_GIT_READ_POLICY = Object.freeze({
  global_args: Object.freeze(['--no-replace-objects']),
  environment: Object.freeze({
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_NO_LAZY_FETCH: '1'
  })
});

export async function materializeCommitAnalysisRoot(
  repositoryRoot,
  repositoryIdentity,
  commitSha,
  {
    tempParent = os.tmpdir()
  } = {}
) {
  const sourceRoot = path.resolve(repositoryRoot);
  const materializationParent =
    await assertMaterializationOutsideTarget(
      sourceRoot,
      tempParent
    );
  const snapshotIdentity = createCommitSnapshot(
    repositoryIdentity,
    commitSha
  );
  const commit = snapshotIdentity.base_commit;

  const commitIntegrity = await assertCommitObject(sourceRoot, commit);

  const materializedRoot = await fs.mkdtemp(
    path.join(materializationParent, 'kneekura-commit-')
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
      .sort((a, b) => compareText(a.path, b.path));
    assertPortablePathSet(selected.map(entry => entry.path));

    let verifiedBlobs = 0;
    for (const entry of selected) {
      const destination = safeDestination(
        materializedRoot,
        entry.path
      );
      const bytes = await gitBuffer(
        sourceRoot,
        ['cat-file', 'blob', entry.object_id]
      );
      assertGitObjectDigest('blob', bytes, entry.object_id);
      verifiedBlobs += 1;
      await fs.mkdir(path.dirname(destination), {
        recursive: true
      });
      await fs.writeFile(destination, bytes);
    }

    return {
      root: materializedRoot,
      snapshotIdentity,
      materialized_files: selected.map(entry => entry.path),
      integrity: Object.freeze({
        replace_objects_disabled: true,
        lazy_fetch_disabled: true,
        commit_object_verified: true,
        tree_object_verified: true,
        commit_object_id: commitIntegrity.commit_object_id,
        tree_object_id: commitIntegrity.tree_object_id,
        blobs_verified: verifiedBlobs
      }),
      cleanup
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

async function assertMaterializationOutsideTarget(
  sourceRoot,
  tempParent
) {
  const realSource = await fs.realpath(sourceRoot);

  let resolvedParent;
  let realParent;
  let parentStat;
  try {
    resolvedParent = path.resolve(tempParent);
    realParent = await fs.realpath(resolvedParent);
    parentStat = await fs.stat(realParent);
  } catch (error) {
    throw codedError(
      'INVALID_REQUEST',
      'commit materialization tempParent must be an existing directory',
      error
    );
  }

  if (!parentStat.isDirectory()) {
    throw codedError(
      'INVALID_REQUEST',
      'commit materialization tempParent must be an existing directory'
    );
  }

  const sourcePrefix = realSource.endsWith(path.sep)
    ? realSource
    : realSource + path.sep;

  if (
    realParent === realSource ||
    realParent.startsWith(sourcePrefix)
  ) {
    throw codedError(
      'TRUST_BOUNDARY_VIOLATION',
      'commit materialization storage must be outside the target repository'
    );
  }

  return realParent;
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

  const commitBytes = await gitBuffer(
    root,
    ['cat-file', 'commit', commit]
  );
  assertGitObjectDigest('commit', commitBytes, commit);
  const treeMatch = commitBytes.toString('utf8').match(/^tree ([0-9a-f]{40,64})\n/);
  if (!treeMatch) {
    throw codedError(
      'GIT_OBJECT_INTEGRITY_FAILURE',
      'commit object does not contain a valid tree object id'
    );
  }
  const treeObjectId = treeMatch[1].toLowerCase();
  const treeBytes = await gitBuffer(
    root,
    ['cat-file', 'tree', treeObjectId]
  );
  assertGitObjectDigest('tree', treeBytes, treeObjectId);

  return Object.freeze({
    commit_object_id: commit.toLowerCase(),
    tree_object_id: treeObjectId
  });
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
    /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(value) ||
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

function assertPortablePathSet(paths) {
  const seen = new Map();
  for (const repoPath of paths) {
    const portable = repoPath
      .split('/')
      .map(segment => portableSegment(segment))
      .join('/');
    const previous = seen.get(portable);
    if (previous && previous !== repoPath) {
      throw codedError(
        'TRUST_BOUNDARY_VIOLATION',
        `commit tree contains a portable path collision: ${previous} <> ${repoPath}`
      );
    }
    seen.set(portable, repoPath);
  }
}

function portableSegment(segment) {
  const normalized = segment.normalize('NFC').replace(/[ .]+$/g, '').toLowerCase();
  const base = normalized.split('.')[0];
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(base)) {
    throw codedError(
      'TRUST_BOUNDARY_VIOLATION',
      `commit tree contains a Windows-reserved path segment: ${segment}`
    );
  }
  if (!normalized) {
    throw codedError(
      'TRUST_BOUNDARY_VIOLATION',
      `commit tree contains a non-portable path segment: ${segment}`
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

function assertGitObjectDigest(type, bytes, expectedObjectId) {
  const algorithm = expectedObjectId.length === 40
    ? 'sha1'
    : expectedObjectId.length === 64
      ? 'sha256'
      : null;
  if (!algorithm) {
    throw codedError(
      'GIT_OBJECT_INTEGRITY_FAILURE',
      `unsupported Git object id length: ${expectedObjectId.length}`
    );
  }
  const header = Buffer.from(`${type} ${bytes.length}\0`, 'utf8');
  const actual = crypto
    .createHash(algorithm)
    .update(header)
    .update(bytes)
    .digest('hex');
  if (actual !== expectedObjectId.toLowerCase()) {
    throw codedError(
      'GIT_OBJECT_INTEGRITY_FAILURE',
      `Git ${type} object hash mismatch: expected ${expectedObjectId}, got ${actual}`
    );
  }
  return true;
}

async function gitText(root, args) {
  const { stdout } = await execFileAsync(
    'git',
    [...HARDENED_GIT_READ_POLICY.global_args, '-C', root, ...args],
    {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
      env: hardenedGitEnvironment()
    }
  );
  return stdout;
}

async function gitBuffer(root, args) {
  const { stdout } = await execFileAsync(
    'git',
    [...HARDENED_GIT_READ_POLICY.global_args, '-C', root, ...args],
    {
      encoding: null,
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
      env: hardenedGitEnvironment()
    }
  );
  return Buffer.isBuffer(stdout)
    ? stdout
    : Buffer.from(stdout);
}

function hardenedGitEnvironment() {
  return {
    ...process.env,
    ...HARDENED_GIT_READ_POLICY.environment
  };
}

function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function codedError(code, message, cause = null) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}