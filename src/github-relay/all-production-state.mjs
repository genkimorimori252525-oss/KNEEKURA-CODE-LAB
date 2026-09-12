import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  allChildRequestDigest,
  validateAllContextClaim
} from './all-mode-contracts.mjs';
import { stableRelayJson } from './contracts.mjs';
import {
  parseRelayIssueRequest,
  parseRelayThreadComments
} from './issue-transport.mjs';
import { createRelayRunId } from './orchestrator.mjs';

const API_VERSION = '2026-03-10';
const EXPECTED_ARTIFACT_FILES = Object.freeze([
  'child-result-manifest.json',
  'engine-receipt.json',
  'result.zip'
]);

export async function collectAllChildState({
  repository,
  parentIssueNumber,
  thread,
  allowedActors,
  token,
  tempRoot,
  downloadArtifact = downloadActionsArtifact
} = {}) {
  const repo = requireRepository(repository);
  const parentIssue = positiveInteger(parentIssueNumber, 'parentIssueNumber');
  if (!thread || typeof thread !== 'object' || Array.isArray(thread)) {
    throw new TypeError('parent Relay thread is required');
  }
  if (!Array.isArray(allowedActors) || allowedActors.length === 0) {
    throw new TypeError('allowedActors must contain at least one authorized actor');
  }
  const auth = requireText(token, 'token');
  const root = path.resolve(requireText(tempRoot, 'tempRoot'));
  if (typeof downloadArtifact !== 'function') throw new TypeError('downloadArtifact must be a function');

  const bindings = canonicalParentBindings(thread.allChildBindings ?? [], parentIssue);
  const contextClaims = [];
  const childResults = [];
  const childInputs = [];

  for (const binding of bindings) {
    const childIssue = await githubJson(
      `https://api.github.com/repos/${repo}/issues/${binding.child_issue_number}`,
      auth
    );
    if (childIssue?.pull_request) {
      throw bindingError('ALL child binding points to a pull request instead of an Issue');
    }
    const childRequest = parseRelayIssueRequest(childIssue, { allowedActors });
    assertChildRequestMatchesBinding(childRequest, binding);

    const comments = await fetchIssueComments(repo, binding.child_issue_number, auth);
    const childThread = parseRelayThreadComments(comments, { allowedActors });
    const claim = selectChildContextClaim(childThread.contextClaims, binding);
    if (claim) contextClaims.push(claim);

    const expectedRunId = createRelayRunId(
      binding.child_issue_number,
      binding.target.revision,
      binding.scope_digest
    );
    const relayResult = selectChildResult(childThread.results, expectedRunId, binding.engine_id);
    if (!relayResult) continue;
    if (!claim) {
      throw isolationError('terminal ALL child result exists without an accepted semantic context claim');
    }
    const locator = relayResult.artifact_locator;
    if (
      !locator ||
      locator.provider !== 'github-actions' ||
      !Number.isSafeInteger(Number(locator.workflow_run_id)) ||
      Number(locator.workflow_run_id) < 1 ||
      !String(locator.artifact_name ?? '').trim()
    ) {
      throw integrityError('terminal ALL child result does not expose a valid GitHub Actions artifact locator');
    }

    const artifactRoot = await downloadArtifact({
      repository: repo,
      locator,
      token: auth,
      tempRoot: root,
      engineId: binding.engine_id
    });
    const staged = await readChildArtifact(artifactRoot);
    childResults.push(staged.manifest);
    childInputs.push({
      ...staged,
      expectedBinding: binding,
      expectedContextClaim: claim
    });
  }

  return deepFreezeState({
    bindings,
    contextClaims,
    childResults,
    childInputs
  });
}

export async function downloadActionsArtifact({
  repository,
  locator,
  token,
  tempRoot,
  engineId = 'child'
} = {}) {
  const repo = requireRepository(repository);
  const auth = requireText(token, 'token');
  const runId = positiveInteger(locator?.workflow_run_id, 'artifact workflow_run_id');
  const artifactName = requireText(locator?.artifact_name, 'artifact_name');
  const root = path.resolve(requireText(tempRoot, 'tempRoot'));

  const listing = await githubJson(
    `https://api.github.com/repos/${repo}/actions/runs/${runId}/artifacts?per_page=100`,
    auth
  );
  const matches = (listing?.artifacts ?? []).filter(value =>
    value?.expired !== true && String(value?.name ?? '') === artifactName
  );
  if (matches.length !== 1) {
    throw integrityError(`expected exactly one live Actions artifact named ${artifactName}`);
  }
  const artifactId = positiveInteger(matches[0].id, 'artifact id');
  const response = await githubFetch(
    `https://api.github.com/repos/${repo}/actions/artifacts/${artifactId}/zip`,
    auth
  );
  const archive = Buffer.from(await response.arrayBuffer());
  if (archive.length === 0) throw integrityError('downloaded child Actions artifact is empty');

  const safeEngine = String(engineId).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'child';
  const artifactRoot = path.join(root, `all-child-${safeEngine}-${runId}-${artifactId}`);
  await fs.rm(artifactRoot, { recursive: true, force: true });
  await fs.mkdir(artifactRoot, { recursive: true });
  const archivePath = `${artifactRoot}.zip`;
  await fs.writeFile(archivePath, archive);
  try {
    extractZip(archivePath, artifactRoot);
  } finally {
    await fs.rm(archivePath, { force: true }).catch(() => {});
  }
  return artifactRoot;
}

function canonicalParentBindings(entries, parentIssueNumber) {
  if (!Array.isArray(entries)) throw new TypeError('ALL child binding entries must be an array');
  const byEngine = new Map();
  for (const entry of entries) {
    const binding = entry?.envelope ?? entry;
    if (!binding || typeof binding !== 'object' || Array.isArray(binding)) {
      throw bindingError('ALL child binding entry is invalid');
    }
    if (Number(binding.parent_issue_number) !== parentIssueNumber) {
      throw bindingError('ALL child binding parent Issue does not match this parent thread');
    }
    const engineId = String(binding.engine_id ?? '');
    const existing = byEngine.get(engineId);
    if (existing && stableRelayJson(existing) !== stableRelayJson(binding)) {
      throw bindingError('ALL parent thread contains conflicting child bindings for one engine');
    }
    if (!existing) byEngine.set(engineId, binding);
  }
  return [...byEngine.values()].sort((a, b) => Number(a.child_slot) - Number(b.child_slot));
}

function assertChildRequestMatchesBinding(request, binding) {
  if (request.selection !== binding.engine_id || request.semanticContextMode !== 'single-context') {
    throw bindingError('ALL child Issue request does not match its bound standalone engine/context mode');
  }
  if (
    request.target.repository !== binding.target.repository ||
    request.target.revision !== binding.target.revision
  ) {
    throw bindingError('ALL child Issue request target does not match the immutable binding');
  }
  const engineKeys = Object.keys(request.engineOptions ?? {});
  const claimKeys = Object.keys(request.minimumClaimLevel ?? {});
  if (engineKeys.some(key => key !== binding.engine_id) || claimKeys.some(key => key !== binding.engine_id)) {
    throw bindingError('ALL child Issue request contains a sibling engine projection');
  }
  const expectedDigest = allChildRequestDigest({
    ...binding,
    common_scope: request.commonScope,
    engine_options: request.engineOptions?.[binding.engine_id] ?? {},
    minimum_claim_level: request.minimumClaimLevel?.[binding.engine_id] ?? null
  });
  if (expectedDigest !== binding.child_request_digest) {
    throw bindingError('ALL child Issue request digest does not match the parent-authorized projection');
  }
}

function selectChildContextClaim(entries, binding) {
  const candidates = (entries ?? []).filter(entry => {
    const claim = entry?.envelope ?? entry;
    return Number(claim?.child_issue_number) === Number(binding.child_issue_number) &&
      String(claim?.engine_id ?? '') === binding.engine_id;
  });
  if (candidates.length === 0) return null;
  const first = validateAllContextClaim(candidates[0].envelope ?? candidates[0], binding);
  const canonical = stableRelayJson(first);
  for (const row of candidates.slice(1)) {
    const current = validateAllContextClaim(row.envelope ?? row, binding);
    if (stableRelayJson(current) !== canonical) {
      throw isolationError('ALL child Issue contains conflicting semantic context claims');
    }
  }
  return first;
}

function selectChildResult(entries, expectedRunId, engineId) {
  const candidates = (entries ?? []).map(entry => entry?.envelope ?? entry).filter(result =>
    String(result?.run_id ?? '') === expectedRunId &&
    String(result?.terminal?.requested_engine ?? '') === engineId
  );
  if (candidates.length === 0) return null;
  const first = candidates[0];
  const canonical = stableRelayJson(first);
  for (const result of candidates.slice(1)) {
    if (stableRelayJson(result) !== canonical) {
      throw bindingError('ALL child Issue contains conflicting terminal Relay results');
    }
  }
  return first;
}

async function readChildArtifact(artifactRoot) {
  const entries = await fs.readdir(artifactRoot, { withFileTypes: true });
  const names = entries.map(entry => entry.name).sort();
  if (
    entries.some(entry => !entry.isFile()) ||
    stableRelayJson(names) !== stableRelayJson(EXPECTED_ARTIFACT_FILES)
  ) {
    throw integrityError('child Actions artifact must contain exactly result.zip, engine-receipt.json, and child-result-manifest.json');
  }
  const [manifestText, receiptText, sealedBytes] = await Promise.all([
    fs.readFile(path.join(artifactRoot, 'child-result-manifest.json'), 'utf8'),
    fs.readFile(path.join(artifactRoot, 'engine-receipt.json'), 'utf8'),
    fs.readFile(path.join(artifactRoot, 'result.zip'))
  ]);
  let manifest;
  let receipt;
  try {
    manifest = JSON.parse(manifestText);
    receipt = JSON.parse(receiptText);
  } catch (error) {
    throw integrityError(`child Actions artifact JSON is invalid: ${error.message}`);
  }
  return { manifest, receipt, sealedBytes };
}

async function fetchIssueComments(repository, issueNumber, token) {
  const comments = [];
  for (let page = 1; page <= 50; page += 1) {
    const values = await githubJson(
      `https://api.github.com/repos/${repository}/issues/${issueNumber}/comments?per_page=100&page=${page}`,
      token
    );
    if (!Array.isArray(values)) throw bindingError('GitHub child Issue comments response is invalid');
    comments.push(...values);
    if (values.length < 100) break;
  }
  if (comments.length > 5000) throw bindingError('ALL child Issue contains too many comments');
  return comments;
}

async function githubJson(url, token) {
  const response = await githubFetch(url, token);
  try {
    return await response.json();
  } catch (error) {
    throw bindingError(`GitHub API JSON response is invalid: ${error.message}`);
  }
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
    throw bindingError(`GitHub ALL child state request failed with HTTP ${response.status}`);
  }
  return response;
}

function extractZip(archivePath, destination) {
  if (process.platform === 'win32') {
    const quote = value => `'${String(value).replaceAll("'", "''")}'`;
    childProcess.execFileSync('powershell', [
      '-NoProfile',
      '-Command',
      `Expand-Archive -LiteralPath ${quote(archivePath)} -DestinationPath ${quote(destination)} -Force`
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    return;
  }
  childProcess.execFileSync('unzip', ['-q', archivePath, '-d', destination], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

function requireRepository(value) {
  const repository = String(value ?? '').trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new TypeError('repository is invalid');
  return repository;
}

function requireText(value, label) {
  const text = String(value ?? '').trim();
  if (!text) throw new TypeError(`${label} is required`);
  return text;
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new TypeError(`${label} must be a positive safe integer`);
  return number;
}

function bindingError(message) {
  const error = new Error(message);
  error.code = 'ALL_CHILD_BINDING_MISMATCH';
  return error;
}

function isolationError(message) {
  const error = new Error(message);
  error.code = 'BLOCKED_SEMANTIC_CONTEXT_ISOLATION';
  return error;
}

function integrityError(message) {
  const error = new Error(message);
  error.code = 'ALL_CHILD_ARTIFACT_INTEGRITY_MISMATCH';
  return error;
}

function deepFreezeState(value) {
  return Object.freeze({
    bindings: Object.freeze(value.bindings.map(row => Object.freeze(structuredClone(row)))),
    contextClaims: Object.freeze(value.contextClaims.map(row => Object.freeze(structuredClone(row)))),
    childResults: Object.freeze(value.childResults.map(row => Object.freeze(structuredClone(row)))),
    childInputs: value.childInputs
  });
}