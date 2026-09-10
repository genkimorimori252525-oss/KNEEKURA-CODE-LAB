import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createHostBridgeProductionBackend } from '../mcp/src/production-backend.mjs';
import {
  GITHUB_RELAY_MARKERS,
  parseRelayIssueRequest,
  parseRelayThreadComments,
  recognizedRelayClientMarker,
  relayResultRunIds,
  relaySourceResultDigests,
  relayTaskIds,
  renderRelayComment,
  selectCanonicalRelayPlan
} from '../src/github-relay/issue-transport.mjs';
import {
  runGithubRelayTurn,
  sealedArtifactBytes
} from '../src/github-relay/orchestrator.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const API_VERSION = '2026-03-10';

await main();

async function main() {
  const outputRoot = path.resolve(process.env.KNEEKURA_RELAY_OUTPUT_ROOT || path.join(ROOT, 'dist', 'github-relay'));
  await fs.rm(outputRoot, { recursive: true, force: true });
  await fs.mkdir(outputRoot, { recursive: true });

  let event = null;
  let repository = null;
  let issueNumber = null;
  let authorized = false;
  try {
    event = JSON.parse(await fs.readFile(requireEnv('GITHUB_EVENT_PATH'), 'utf8'));
    repository = requireEnv('GITHUB_REPOSITORY');
    issueNumber = Number(event?.issue?.number);
    if (!Number.isSafeInteger(issueNumber) || issueNumber < 1 || event?.issue?.pull_request) {
      return writeTurn(outputRoot, { skipped: true, reason: 'not-a-relay-issue' });
    }

    const owner = String(process.env.GITHUB_REPOSITORY_OWNER || repository.split('/')[0] || '').trim();
    const allowedActors = configuredActors(owner);
    authorized = isAuthorizedTrigger(event, allowedActors);
    if (!authorized) {
      return writeTurn(outputRoot, { skipped: true, reason: 'unrecognized-or-unauthorized-trigger' });
    }

    const request = parseRelayIssueRequest(event.issue, { allowedActors });
    if (request.selection === 'all') {
      throw codedError(
        'BLOCKED_SEMANTIC_CONTEXT_ISOLATION',
        'P3 GitHub Issue transport does not yet prove independent semantic host contexts for all-mode'
      );
    }

    const token = requireEnv('GITHUB_TOKEN');
    const comments = await fetchIssueComments(repository, issueNumber, token);
    const thread = parseRelayThreadComments(comments, { allowedActors });
    const existingPlan = selectCanonicalRelayPlan(thread.plans);

    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), `kneekura-gh-relay-${issueNumber}-`));
    let artifactPath = null;
    try {
      const targetRoot = path.join(tempRoot, 'target');
      await materializeTarget({
        targetRoot,
        repository: request.target.repository,
        revision: request.target.revision,
        currentRepository: repository,
        currentRepositoryToken: token,
        relayToken: process.env.KNEEKURA_RELAY_GITHUB_TOKEN || null
      });

      const codeLabRevision = git(ROOT, ['rev-parse', 'HEAD']).trim().toLowerCase();
      const engineLockBytes = await fs.readFile(path.join(ROOT, 'engine-lock.json'));
      const engineLockDigest = `sha256:${crypto.createHash('sha256').update(engineLockBytes).digest('hex')}`;
      const backend = createHostBridgeProductionBackend({
        env: process.env,
        tempParent: tempRoot
      });

      const turn = await runGithubRelayTurn({
        request,
        issueNumber,
        targetRoot,
        codeLabRevision,
        engineLockDigest,
        backend,
        responses: thread.responses,
        sourceRequests: thread.sourceRequests,
        existingPlan,
        existingTaskIds: relayTaskIds(thread.tasks),
        existingSourceResultDigests: relaySourceResultDigests(thread.sourceResults),
        existingResultRunIds: relayResultRunIds(thread.results),
        onComplete(execution) {
          const bytes = sealedArtifactBytes(execution);
          if (!bytes) return;
          artifactPath = path.join(outputRoot, `${sanitizeFilename(turnlessRunHint(issueNumber, request))}.zip`);
          return fs.writeFile(artifactPath, bytes);
        }
      });

      const artifactName = artifactPath == null
        ? null
        : `kneekura-relay-${turn.run_id}`;
      const workflowRunId = normalizeOptionalPositiveInteger(process.env.GITHUB_RUN_ID);
      const rendered = turn.actions.map(action => {
        const envelope = action.kind === 'RESULT' && artifactName
          ? {
              ...action.envelope,
              artifact_locator: {
                provider: 'github-actions',
                workflow_run_id: workflowRunId,
                artifact_name: artifactName
              }
            }
          : action.envelope;
        return {
          kind: action.kind,
          body: renderRelayComment(markerForAction(action.kind), envelope)
        };
      });

      return writeTurn(outputRoot, {
        schema: 'kneekura.code-lab.github-relay-publish-turn/v1',
        skipped: false,
        failed: false,
        repository,
        issue_number: issueNumber,
        run_id: turn.run_id,
        replay_state: turn.replay.state,
        comments: rendered,
        artifact_path: artifactPath,
        artifact_name: artifactName
      });
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
    }
  } catch (error) {
    const code = sanitizeDiagnostic(String(error?.code || 'RELAY_INTERNAL_ERROR'), 128);
    const message = sanitizeDiagnostic(String(error?.message || error), 2048);
    if (authorized && repository && Number.isSafeInteger(issueNumber) && issueNumber > 0) {
      const body = renderRelayComment(GITHUB_RELAY_MARKERS.error, {
        schema: 'kneekura.code-lab.github-relay-error/v1',
        code,
        message
      });
      await writeTurn(outputRoot, {
        schema: 'kneekura.code-lab.github-relay-publish-turn/v1',
        skipped: false,
        failed: true,
        repository,
        issue_number: issueNumber,
        run_id: null,
        replay_state: 'FAILED',
        comments: [{ kind: 'ERROR', body }],
        artifact_path: null,
        artifact_name: null
      });
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}

async function fetchIssueComments(repository, issueNumber, token) {
  const comments = [];
  let page = 1;
  while (page <= 50) {
    const response = await githubFetch(
      `https://api.github.com/repos/${repository}/issues/${issueNumber}/comments?per_page=100&page=${page}`,
      token
    );
    const values = await response.json();
    if (!Array.isArray(values)) throw codedError('RELAY_GITHUB_API_INVALID', 'GitHub issue comments response was not an array');
    comments.push(...values);
    if (values.length < 100) break;
    page += 1;
  }
  if (comments.length > 5000) throw codedError('BLOCKED_RELAY_THREAD_TOO_LARGE', 'relay Issue contains too many comments');
  return comments;
}

async function materializeTarget({
  targetRoot,
  repository,
  revision,
  currentRepository,
  currentRepositoryToken,
  relayToken
}) {
  await fs.mkdir(targetRoot, { recursive: true });
  git(targetRoot, ['init']);
  git(targetRoot, ['remote', 'add', 'origin', `https://github.com/${repository}.git`]);

  const token = relayToken || (repository.toLowerCase() === currentRepository.toLowerCase() ? currentRepositoryToken : null);
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'Never'
  };
  let askpassPath = null;
  if (token) {
    askpassPath = await createAskpass(targetRoot);
    env.GIT_ASKPASS = askpassPath;
    env.KNEEKURA_RELAY_FETCH_TOKEN = token;
  }

  try {
    git(targetRoot, ['-c', `core.hooksPath=${nullHooksPath()}`, 'fetch', '--depth', '1', '--no-tags', 'origin', revision], env);
  } catch {
    throw codedError(
      'BLOCKED_TARGET_REPOSITORY_UNAVAILABLE',
      'relay runner could not fetch the exact target revision; configure KNEEKURA_RELAY_GITHUB_TOKEN for cross-private-repository access if needed'
    );
  } finally {
    if (askpassPath) await fs.rm(askpassPath, { force: true }).catch(() => {});
  }

  const actual = git(targetRoot, ['rev-parse', 'FETCH_HEAD']).trim().toLowerCase();
  if (actual !== revision.toLowerCase()) {
    throw codedError('BLOCKED_TARGET_REVISION_MISMATCH', 'GitHub returned a different revision than the relay request');
  }
  const type = git(targetRoot, ['--no-replace-objects', 'cat-file', '-t', actual]).trim();
  if (type !== 'commit') throw codedError('BLOCKED_TARGET_REVISION_INVALID', 'relay target revision is not a Git commit');
}

async function createAskpass(root) {
  if (process.platform === 'win32') {
    const file = path.join(root, '.kneekura-relay-askpass.cmd');
    await fs.writeFile(file, '@echo off\r\necho %* | findstr /I "Username" >nul && (echo x-access-token& exit /b 0)\r\necho %KNEEKURA_RELAY_FETCH_TOKEN%\r\n', 'utf8');
    return file;
  }
  const file = path.join(root, '.kneekura-relay-askpass.sh');
  await fs.writeFile(file, '#!/bin/sh\ncase "$1" in *Username*) echo x-access-token ;; *) printf "%s\\n" "$KNEEKURA_RELAY_FETCH_TOKEN" ;; esac\n', { mode: 0o700 });
  return file;
}

function markerForAction(kind) {
  if (kind === 'PLAN') return GITHUB_RELAY_MARKERS.plan;
  if (kind === 'TASK') return GITHUB_RELAY_MARKERS.task;
  if (kind === 'SOURCE_RESULT') return GITHUB_RELAY_MARKERS.sourceResult;
  if (kind === 'RESULT') return GITHUB_RELAY_MARKERS.result;
  throw new TypeError(`unsupported relay action kind: ${kind}`);
}

function configuredActors(owner) {
  const configured = String(process.env.KNEEKURA_RELAY_ALLOWED_ACTORS || owner)
    .split(',')
    .map(value => value.trim().toLowerCase())
    .filter(Boolean);
  if (!configured.length) throw new TypeError('KNEEKURA_RELAY_ALLOWED_ACTORS resolved to an empty actor set');
  return configured;
}

function isAuthorizedTrigger(event, allowedActors) {
  const allowed = new Set(allowedActors.map(value => value.toLowerCase()));
  const sender = String(event?.sender?.login ?? '').toLowerCase();
  if (!allowed.has(sender)) return false;
  if (event?.action === 'opened' && event?.issue) {
    return String(event.issue.body ?? '').trimStart().startsWith(`${GITHUB_RELAY_MARKERS.request}\n`);
  }
  if (event?.action === 'created' && event?.comment) {
    return recognizedRelayClientMarker(event.comment.body) != null;
  }
  return false;
}

async function writeTurn(outputRoot, value) {
  const file = path.join(outputRoot, 'turn.json');
  await fs.writeFile(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
  await appendGithubOutput('turn_file', file);
  await appendGithubOutput('skipped', value.skipped === true ? 'true' : 'false');
  await appendGithubOutput('failed', value.failed === true ? 'true' : 'false');
  await appendGithubOutput('has_artifact', value.artifact_path ? 'true' : 'false');
  if (value.artifact_path) await appendGithubOutput('artifact_path', value.artifact_path);
  if (value.artifact_name) await appendGithubOutput('artifact_name', value.artifact_name);
}

async function appendGithubOutput(key, value) {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) return;
  const text = String(value).replace(/[\r\n]/g, '');
  await fs.appendFile(output, `${key}=${text}\n`, 'utf8');
}

async function githubFetch(url, token, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': API_VERSION,
      'User-Agent': 'kneekura-code-lab-github-relay',
      ...(init.headers || {})
    }
  });
  if (!response.ok) {
    throw codedError('RELAY_GITHUB_API_FAILED', `GitHub API request failed with HTTP ${response.status}`);
  }
  return response;
}

function git(cwd, args, env = process.env) {
  return childProcess.execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env
  });
}

function nullHooksPath() {
  return process.platform === 'win32' ? 'NUL' : '/dev/null';
}

function turnlessRunHint(issueNumber, request) {
  return `ghr-${issueNumber}-${request.target.revision.slice(0, 12)}`;
}

function sanitizeFilename(value) {
  return String(value).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 180);
}

function normalizeOptionalPositiveInteger(value) {
  if (value == null || String(value).trim() === '') return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new TypeError('GITHUB_RUN_ID must be a positive safe integer');
  return number;
}

function sanitizeDiagnostic(value, maxBytes) {
  const text = String(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let out = '';
  for (const character of text) {
    if (Buffer.byteLength(out + character, 'utf8') > maxBytes) break;
    out += character;
  }
  return out;
}

function requireEnv(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
