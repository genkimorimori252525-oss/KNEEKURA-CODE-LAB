import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const WORKFLOW = new URL('../.github/workflows/kneekura-github-relay.yml', import.meta.url);
const PINNED_RUNTIME = '83114564180761f83c2279ce4055723365a566cb';
const PINNED_ACTIONS = Object.freeze([
  'actions/checkout@11d5960a326750d5838078e36cf38b85af677262',
  'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020',
  'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02'
]);

test('P3b live workflow is fail-closed and pins the exact P3a runtime', async () => {
  const text = await fs.readFile(WORKFLOW, 'utf8');

  assert.match(text, /issues:\s*\n\s*types:\s*\[opened\]/);
  assert.match(text, /issue_comment:\s*\n\s*types:\s*\[created\]/);
  assert.match(text, /contents:\s*read/);
  assert.match(text, /issues:\s*write/);
  assert.doesNotMatch(text, /contents:\s*write/);
  assert.doesNotMatch(text, /pull_request_target/);

  assert.match(text, /runs-on:\s*ubuntu-latest/);
  assert.match(text, /runs-on:\s*\[self-hosted, Windows, X64, kneekura-code-lab\]/);
  assert.match(text, /KNEEKURA_RELAY_REQUEST_V1/);
  assert.match(text, /KNEEKURA_RELAY_RESPONSE_V1/);
  assert.match(text, /KNEEKURA_RELAY_SOURCE_REQUEST_V1/);
  assert.match(text, /cancel-in-progress:\s*false/);

  assert.match(text, new RegExp(`ref:\\s*${PINNED_RUNTIME}`));
  assert.match(text, /persist-credentials:\s*false/);
  assert.match(text, /npm ci --ignore-scripts --no-audit --no-fund/);
  assert.match(text, /steps\.relay\.outputs\.has_artifact == 'true'/);
  assert.match(text, /steps\.artifact\.outcome == 'success'/);
  assert.match(text, /if-no-files-found:\s*error/);
  assert.match(text, /KNEEKURA_RELAY_TURN_FILE/);

  for (const pinned of PINNED_ACTIONS) assert.ok(text.includes(pinned));
  assert.doesNotMatch(text, /uses:\s*actions\/(?:checkout|setup-node|upload-artifact)@v\d+/);
});

test('P3b private target credential fallback is explicit, noninteractive, masked, and same-owner only', async () => {
  const text = await fs.readFile(WORKFLOW, 'utf8');

  assert.match(text, /KNEEKURA_RELAY_EXPLICIT_TOKEN:\s*\$\{\{ secrets\.KNEEKURA_RELAY_GITHUB_TOKEN \}\}/);
  assert.match(text, /KNEEKURA_RELAY_REPOSITORY_OWNER:\s*\$\{\{ github\.repository_owner \}\}/);
  assert.match(text, /KNEEKURA_RELAY_CURRENT_REPOSITORY:\s*\$\{\{ github\.repository \}\}/);
  assert.match(text, /\$parts\[0\]\.ToLowerInvariant\(\) -ne \$env:KNEEKURA_RELAY_REPOSITORY_OWNER\.ToLowerInvariant\(\)/);
  assert.match(text, /GIT_TERMINAL_PROMPT = '0'/);
  assert.match(text, /GCM_INTERACTIVE = 'Never'/);
  assert.match(text, /git credential fill/);
  assert.match(text, /::add-mask::\$password/);
  assert.match(text, /KNEEKURA_RELAY_GITHUB_TOKEN=\$password/);
  assert.doesNotMatch(text, /Write-Host\s+['"]?\$credentialLines/);
});

test('P3b runtime and action pins are immutable full Git SHAs', () => {
  assert.match(PINNED_RUNTIME, /^[0-9a-f]{40}$/);
  for (const value of PINNED_ACTIONS) {
    const sha = value.split('@')[1];
    assert.match(sha, /^[0-9a-f]{40}$/);
  }
});
