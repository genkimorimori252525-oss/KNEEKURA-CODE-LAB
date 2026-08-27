import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const SNAPSHOT_IDENTITY_SCHEMA = 'core.snapshot-identity/v1';
export const WORKSPACE_STATES = Object.freeze(['TRACKED', 'MODIFIED', 'UNTRACKED', 'DELETED']);
const WORKSPACE_STATE_SET = new Set(WORKSPACE_STATES);
const RELEVANT_EXTENSIONS = new Set(['.java','.json','.toml','.gradle','.kts','.properties','.mcmeta']);

export class SnapshotChangedError extends Error {
  constructor(message = 'workspace changed after snapshot freeze', data = {}) {
    super(message);
    this.name = 'SnapshotChangedError';
    this.code = 'SNAPSHOT_CHANGED';
    Object.assign(this, data);
  }
}

export function createCommitSnapshot(repositoryIdentity, commitSha) {
  const repositoryId = requireRepositoryId(repositoryIdentity);
  const baseCommit = normalizeCommitSha(commitSha);
  const payload = { kind: 'COMMIT', repository_id: repositoryId, base_commit: baseCommit };
  return {
    schema: SNAPSHOT_IDENTITY_SCHEMA,
    kind: 'COMMIT',
    repository_id: repositoryId,
    base_commit: baseCommit,
    snapshot_id: snapshotId(payload)
  };
}

export function createWorkspaceSnapshot(repositoryIdentity, { baseCommit = null, entries = [], indexDigest = null } = {}) {
  const repositoryId = requireRepositoryId(repositoryIdentity);
  const normalizedEntries = normalizeManifest(entries);
  const contentManifestDigest = digestObject(normalizedEntries);
  const normalizedBase = baseCommit == null ? null : normalizeCommitSha(baseCommit);
  const normalizedIndex = indexDigest == null ? null : normalizeDigest(indexDigest, 'index digest');
  const payload = {
    kind: 'WORKSPACE',
    repository_id: repositoryId,
    base_commit: normalizedBase,
    content_manifest_digest: contentManifestDigest,
    index_digest: normalizedIndex
  };
  return {
    schema: SNAPSHOT_IDENTITY_SCHEMA,
    kind: 'WORKSPACE',
    repository_id: repositoryId,
    base_commit: normalizedBase,
    content_manifest_digest: contentManifestDigest,
    content_manifest: normalizedEntries,
    ...(normalizedIndex ? { index_digest: normalizedIndex } : {}),
    snapshot_id: snapshotId(payload)
  };
}

export function createMultiRepoSnapshot(constituents) {
  if (!Array.isArray(constituents) || constituents.length < 2) {
    throw new TypeError('MULTI_REPO snapshot requires at least two constituents');
  }
  const normalized = constituents.map(snapshot => {
    if (!snapshot?.repository_id || !snapshot?.snapshot_id) throw new TypeError('invalid MULTI_REPO constituent');
    return { repository_id: snapshot.repository_id, snapshot_id: snapshot.snapshot_id, kind: snapshot.kind };
  }).sort((a, b) => `${a.repository_id}\0${a.snapshot_id}`.localeCompare(`${b.repository_id}\0${b.snapshot_id}`));
  const digest = digestObject(normalized);
  return {
    schema: SNAPSHOT_IDENTITY_SCHEMA,
    kind: 'MULTI_REPO',
    repository_id: null,
    constituents: normalized,
    content_manifest_digest: digest,
    snapshot_id: snapshotId({ kind: 'MULTI_REPO', constituents: normalized })
  };
}

export function createArchiveSnapshot(repositoryIdentity, archiveDigest) {
  const repositoryId = requireRepositoryId(repositoryIdentity);
  const digest = normalizeDigest(archiveDigest, 'archive digest');
  return {
    schema: SNAPSHOT_IDENTITY_SCHEMA,
    kind: 'ARCHIVE',
    repository_id: repositoryId,
    archive_digest: digest,
    snapshot_id: snapshotId({ kind: 'ARCHIVE', repository_id: repository_id: repositoryId, archive_digest: digest })
  };
}

export async function captureWorkspaceSnapshot(root, repositoryIdentity, opts = {}) {
  const absoluteRoot = path.resolve(root);
  const gitMetadata = opts.gitMetadata ?? await hasGitMetadata(absoluteRoot);
  const status = gitMetadata ? await readGitStatus(absoluteRoot) : new Map();
  const baseCommit = opts.baseCommit ?? (gitMetadata ? await gitOutput(absoluteRoot, ['rev-parse', 'HEAD']) : null);
  const indexDigest = opts.indexDigest ?? (gitMetadata ? await readIndexDigest(absoluteRoot) : null);
  const files = opts.files ?? await listRelevantFiles(absoluteRoot);
  const entries = [];
  const seen = new Set();

  for (const file of files) {
    const relative = normalizeRelativePath(path.relative(absoluteRoot, file));
    if (!relative || seen.has(relative)) continue;
    seen.add(relative);
    const state = gitMetadata ? (status.get(relative) ?? 'TRACKED') : 'UNTRACKED';
    if (state === 'DELETED') {
      entries.push({ path: relative, state: 'DELETED', digest: null });
      continue;
    }
    try {
      const bytes = await fs.readFile(file);
      entries.push({ path: relative, state, digest: `sha256:${sha256(bytes)}` });
    } catch (error) {
      throw new SnapshotChangedError(`workspace file changed while freezing: ${relative}`, { path: relative, cause: error });
    }
  }

  if (gitMetadata) {
    for (const [relative, state] of status) {
      if (state !== 'DELETED' || seen.has(relative) || !isRelevantPath(relative)) continue;
      entries.push({ path: relative, state: 'DELETED', digest: null });
    }
  }

  return createWorkspaceSnapshot(repositoryIdentity, { baseCommit, entries, indexDigest });
}

export function assertWorkspaceSnapshotUnchanged(expected, current) {
  if (!expected || expected.kind !== 'WORKSPACE' || !current || current.kind !== 'WORKSPACE') {
    throw new TypeError('workspace snapshot comparison requires WORKSPACE identities');
  }
  if (expected.repository_id !== current.repository_id || expected.snapshot_id !== current.snapshot_id) {
    throw new SnapshotChangedError('workspace changed after snapshot freeze', {
      expected_snapshot_id: expected.snapshot_id,
      current_snapshot_id: current.snapshot_id
    });
  }
  return true;
}

function normalizeManifest(entries) {
  if (!Array.isArray(entries)) throw new TypeError('workspace entries must be an array');
  const seen = new Set();
  return entries.map(entry => {
    if (!entry || typeof entry !== 'object') throw new TypeError('workspace entry must be an object');
    const relative = normalizeRelativePath(entry.path);
    if (!relative) throw new TypeError('workspace entry path must be non-empty');
    if (seen.has(relative)) throw new TypeError(`duplicate workspace path: ${relative}`);
    seen.add(relative);
    const state = String(entry.state ?? '').toUpperCase();
    if (!WORKSPACE_STATE_SET.has(state)) throw new TypeError(`invalid workspace state: ${entry.state}`);
    if (state === 'DELETED') return { path: relative, state, digest: null };
    return { path: relative, state, digest: normalizeDigest(entry.digest, `digest for ${relative}`) };
  }).sort((a, b) => a.path.localeCompare(b.path));
}

function normalizeRelativePath(value) {
  if (typeof value !== 'string') throw new TypeError('workspace path must be a string');
  return value.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/^\/+/, '').replace(/\/+$/g, '');
}

function isRelevantPath(relative) {
  const name = path.posix.basename(relative);
  return RELEVANT_EXTENSIONS.has(path.posix.extname(name)) || name === 'mods.toml';
}

async function listRelevantFiles(root) {
  const out = [];
  const ignore = new Set(['.git','build','out','target','node_modules','.gradle','.idea','.vscode','run']);
  async function rec(dir) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      if (entry.isDirectory() && ignore.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await rec(full);
      else if (entry.isFile() && isRelevantPath(normalizeRelativePath(path.relative(root, full)))) out.push(full);
    }
  }
  await rec(root);
  return out;
}

async function readGitStatus(root) {
  const output = await gitOutput(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], false);
  const map = new Map();
  if (!output) return map;
  const records = output.split('\0').filter(Boolean);
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (record.length < 4) continue;
    const xy = record.slice(0, 2);
    const relative = normalizeRelativePath(record.slice(3));
    let state = 'MODIFIED';
    if (xy === '??') state = 'UNTRACKED';
    else if (xy.includes('D')) state = 'DELETED';
    map.set(relative, state);
    if ((xy.includes('R') || xy.includes('C')) && i + 1 < records.length) i += 1;
  }
  return map;
}

async function readIndexDigest(root) {
  const output = await gitOutput(root, ['diff', '--cached', '--binary', '--no-ext-diff'], false);
  return `sha256:${sha256(output ?? '')}`;
}

async function hasGitMetadata(root) {
  try {
    await fs.lstat(path.join(root, '.git'));
    return true;
  } catch {
    return false;
  }
}

async function gitOutput(root, args, trim = true) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024
    });
    return trim ? (stdout.trim() || null) : stdout;
  } catch {
    return null;
  }
}

function requireRepositoryId(identity) {
  const value = identity?.repository_id;
  if (typeof value !== 'string' || !/^repo:sha256:[0-9a-f]{64}$/.test(value)) throw new TypeError('invalid repository identity');
  return value;
}

function normalizeCommitSha(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$|^[0-9a-f]{64}$/i.test(value.trim())) throw new TypeError('commit SHA must be a full SHA-1 or SHA-256 hexadecimal id');
  return value.trim().toLowerCase();
}

function normalizeDigest(value, label) {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a sha256 digest`);
  const raw = value.toLowerCase();
  const normalized = raw.startsWith('sha256:') ? raw : `sha256:${raw}`;
  if (!/^sha256:[0-9a-f]{64}$/.test(normalized)) throw new TypeError(`${label} must be a sha256 digest`);
  return normalized;
}

function snapshotId(payload) {
  return `snapshot:sha256:${sha256(stableStringify(payload))}`;
}

function digestObject(value) {
  return `sha256:${sha256(stableStringify(value))}`;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}
