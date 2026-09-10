import fs from 'node:fs/promises';

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

for (const row of turn.comments) {
  const body = String(row?.body ?? '');
  if (!body || Buffer.byteLength(body, 'utf8') > 60 * 1024) {
    throw new Error('relay publish comment exceeds the bounded transport surface');
  }
  const response = await fetch(
    `https://api.github.com/repos/${repository}/issues/${issueNumber}/comments`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': API_VERSION,
        'User-Agent': 'kneekura-code-lab-github-relay'
      },
      body: JSON.stringify({ body })
    }
  );
  if (!response.ok) {
    throw new Error(`GitHub relay comment publish failed with HTTP ${response.status}`);
  }
}

function requireEnv(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
