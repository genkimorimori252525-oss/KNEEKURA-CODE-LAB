import fs from 'node:fs/promises';

import {
  GITHUB_RELAY_MARKERS,
  renderRelayComment
} from '../src/github-relay/issue-transport.mjs';

const API_VERSION = '2026-03-10';

const turnFile = requireEnv('KNEEKURA_RELAY_TURN_FILE');
const token = requireEnv('GITHUB_TOKEN');
const turn = JSON.parse(await fs.readFile(turnFile, 'utf8'));

if (turn.skipped === true) process.exit(0);
if (turn.schema !== 'kneekura.code-lab.github-relay-publish-turn/v1') {
  throw new Error('relay publish turn schema is invalid');
}
const repository = String(turn.repository ?? '').trim();
const issueNumber = Number(turn.issue_number);
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
  throw new Error('relay publish repository is invalid');
}
if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) {
  throw new Error('relay publish issue number is invalid');
}
if (!Array.isArray(turn.comments) || turn.comments.length > 8) {
  throw new Error('relay publish comment set is invalid');
}
if (!Array.isArray(turn.control_actions ?? []) || (turn.control_actions ?? []).length > 16) {
  throw new Error('relay publish control action set is invalid');
}

for (const row of turn.comments) {
  const body = boundedBody(row?.body);
  await postCommentIfAbsent(repository, issueNumber, body, token);
}

for (const action of turn.control_actions ?? []) {
  if (action?.kind !== 'ALL_CHILD_CREATE') continue;
  const childIssue = await findOrCreateChildIssue({
    repository,
    parentIssueNumber: issueNumber,
    parentRunId: turn.run_id,
    action,
    token: requireOwnerControlToken()
  });
  const binding = {
    ...action.binding,
    child_issue_number: childIssue.number
  };
  const bindingBody = renderRelayComment(GITHUB_RELAY_MARKERS.allChildBinding, binding);
  await postCommentIfAbsent(repository, issueNumber, bindingBody, token);
  await postCommentIfAbsent(repository, childIssue.number, bindingBody, token);
}

async function findOrCreateChildIssue({
  repository,
  parentIssueNumber,
  parentRunId,
  action,
  token
}) {
  if (!action?.binding || !action?.child_request) {
    throw new Error('ALL_CHILD_CREATE action is missing its binding/request');
  }
  if (String(action.binding.parent_run_id ?? '') !== String(parentRunId ?? '')) {
    throw new Error('ALL child binding parent_run_id does not match the publishing parent run');
  }
  if (Number(action.binding.parent_issue_number) !== Number(parentIssueNumber)) {
    throw new Error('ALL child binding parent_issue_number does not match the publishing parent Issue');
  }
  const slot = Number(action.binding.child_slot);
  if (!Number.isSafeInteger(slot) || slot < 1 || slot > 3) {
    throw new Error('ALL child slot is invalid');
  }
  const engineId = String(action.binding.engine_id ?? '');
  const title = `[KNEEKURA ALL child ${slot}/3] ${parentRunId} :: ${engineId}`;
  const body = renderRelayComment(GITHUB_RELAY_MARKERS.request, action.child_request);
  const existing = [];
  for (let page = 1; page <= 50; page += 1) {
    const values = await githubJson(
      `https://api.github.com/repos/${repository}/issues?state=all&per_page=100&sort=created&direction=desc&page=${page}`,
      token
    );
    if (!Array.isArray(values)) throw new Error('GitHub Issue listing response is invalid');
    for (const issue of values) {
      if (!issue?.pull_request && String(issue?.title ?? '') === title) existing.push(issue);
    }
    if (values.length < 100) break;
  }
  if (existing.length > 1) throw new Error('deterministic ALL child title resolves to multiple Issues');
  if (existing.length === 1) {
    if (String(existing[0].body ?? '').trim() !== body.trim()) {
      throw new Error('existing ALL child Issue body drifted from the immutable child request');
    }
    return existing[0];
  }

  const created = await githubJson(
    `https://api.github.com/repos/${repository}/issues`,
    token,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title,
        body,
        labels: []
      })
    }
  );
  const number = Number(created?.number);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error('GitHub did not return a valid ALL child Issue number');
  }
  if (number === parentIssueNumber) throw new Error('ALL child Issue unexpectedly equals its parent Issue');
  return created;
}

async function postCommentIfAbsent(repository, issueNumber, body, token) {
  const comments = [];
  for (let page = 1; page <= 50; page += 1) {
    const values = await githubJson(
      `https://api.github.com/repos/${repository}/issues/${issueNumber}/comments?per_page=100&page=${page}`,
      token
    );
    if (!Array.isArray(values)) throw new Error('GitHub Issue comments response is invalid');
    comments.push(...values);
    if (values.length < 100) break;
  }
  if (comments.some(comment => String(comment?.body ?? '').trim() === body.trim())) return false;
  await githubJson(
    `https://api.github.com/repos/${repository}/issues/${issueNumber}/comments`,
    token,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body })
    }
  );
  return true;
}

function boundedBody(value) {
  const body = String(value ?? '');
  if (!body || Buffer.byteLength(body, 'utf8') > 60 * 1024) {
    throw new Error('relay publish comment exceeds the bounded transport surface');
  }
  return body;
}

function requireOwnerControlToken() {
  const value = String(process.env.KNEEKURA_RELAY_GITHUB_TOKEN ?? '').trim();
  if (!value) {
    const error = new Error('ALL child Issue creation requires KNEEKURA_RELAY_GITHUB_TOKEN so the child request has an authorized owner author');
    error.code = 'BLOCKED_ALL_CHILD_OWNER_CREDENTIAL_UNAVAILABLE';
    throw error;
  }
  return value;
}

async function githubJson(url, token, init = {}) {
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
    throw new Error(`GitHub relay publish request failed with HTTP ${response.status}`);
  }
  return response.json();
}

function requireEnv(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}