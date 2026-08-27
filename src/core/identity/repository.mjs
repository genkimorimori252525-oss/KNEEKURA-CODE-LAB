import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const REPOSITORY_IDENTITY_SCHEMA = 'core.repository-identity/v1';

export function normalizeGitRemote(remote) {
  if (typeof remote !== 'string' || !remote.trim()) throw new TypeError('git remote must be a non-empty string');
  let value = remote.trim().replace(/\\/g, '/');

  if (/^[A-Za-z]:\//.test(value)) {
    const local = value
      .replace(/^([A-Z]):/, (_, drive) => `${drive.toLowerCase()}:`)
      .replace(/\.git$/i, '')
      .replace(/\/+$/g, '');
    if (!local) throw new TypeError('git remote is malformed');
    return `local:${local}`;
  }

  if (!value.includes('://')) {
    const scp = value.match(/^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/);
    if (scp) value = `ssh://${scp[1]}/${scp[2]}`;
  }

  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    let repoPath = decodeURIComponent(url.pathname).replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
    if (!repoPath) throw new TypeError('git remote is missing a repository path');
    if (host === 'github.com') repoPath = repoPath.toLowerCase();
    const port = url.port ? `:${url.port}` : '';
    return `${host}${port}/${repoPath}`;
  } catch (error) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^[A-Za-z]:\//.test(value)) throw error;
    const local = value.replace(/\.git$/i, '').replace(/\/+$/g, '');
    if (!local) throw new TypeError('git remote is malformed');
    return `local:${local}`;
  }
}

export function normalizeLocalRoot(root) {
  if (typeof root !== 'string' || !root.trim()) throw new TypeError('repository root must be a non-empty string');
  let normalized = path.resolve(root).replace(/\\/g, '/');
  normalized = normalized.replace(/^([A-Z]):/, (_, drive) => `${drive.toLowerCase()}:`);
  return normalized.replace(/\/+$/g, '') || '/';
}

export function createRepositoryIdentity({ root = '.', remote = null, vcs = null, objectFormat = null, fallbackIdentity = null } = {}) {
  const canonicalRoot = normalizeLocalRoot(root);
  const normalizedRemote = remote == null ? null : normalizeGitRemote(remote);
  const effectiveVcs = vcs ?? (normalizedRemote ? 'git' : 'filesystem');
  if (!['git', 'filesystem'].includes(effectiveVcs)) throw new TypeError(`unsupported vcs: ${effectiveVcs}`);

  const fallback = fallbackIdentity == null ? null : String(fallbackIdentity).trim();
  const canonicalIdentity = normalizedRemote
    ? `git:${normalizedRemote}`
    : fallback
      ? `${effectiveVcs}:fallback:${fallback}`
      : `${effectiveVcs}:root:${canonicalRoot}`;
  const repositoryId = `repo:sha256:${sha256(canonicalIdentity)}`;

  const identity = {
    schema: REPOSITORY_IDENTITY_SCHEMA,
    vcs: effectiveVcs,
    canonical_identity: canonicalIdentity,
    repository_id: repositoryId
  };
  if (objectFormat) identity.object_format = String(objectFormat).trim().toLowerCase();
  return identity;
}

export async function resolveRepositoryIdentity(root, opts = {}) {
  const absoluteRoot = path.resolve(root);
  const gitMetadata = opts.gitMetadata ?? await hasGitMetadata(absoluteRoot);
  let remote = opts.remote ?? null;
  let objectFormat = opts.objectFormat ?? null;
  let fallbackIdentity = opts.fallbackIdentity ?? null;

  if (gitMetadata) {
    if (!remote) remote = await gitOutput(absoluteRoot, ['config', '--get', 'remote.origin.url']);
    if (!objectFormat) objectFormat = await gitOutput(absoluteRoot, ['rev-parse', '--show-object-format']);
    if (!remote && !fallbackIdentity) {
      const roots = await gitOutput(absoluteRoot, ['rev-list', '--max-parents=0', 'HEAD']);
      if (roots) fallbackIdentity = roots.split(/\s+/).filter(Boolean).sort().join(',');
    }
  }

  return createRepositoryIdentity({
    root: absoluteRoot,
    remote,
    vcs: gitMetadata ? 'git' : 'filesystem',
    objectFormat,
    fallbackIdentity
  });
}

async function hasGitMetadata(root) {
  try {
    await fs.lstat(path.join(root, '.git'));
    return true;
  } catch {
    return false;
  }
}

async function gitOutput(root, args) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024
    });
    const value = stdout.trim();
    return value || null;
  } catch {
    return null;
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}
