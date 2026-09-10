import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const WORKFLOW = new URL('../.github/workflows/kneekura-github-relay.yml', import.meta.url);

test('same-owner Git credential request is emitted as native stdin line records on Windows PowerShell', async () => {
  const text = await fs.readFile(WORKFLOW, 'utf8');

  assert.match(
    text,
    /\$credentialLines = @\('protocol=https', 'host=github\.com', ''\) \| & git credential fill 2>\$null/
  );
  assert.doesNotMatch(text, /\$credentialInput\s*=\s*"protocol=https/);
  assert.match(text, /GIT_TERMINAL_PROMPT = '0'/);
  assert.match(text, /GCM_INTERACTIVE = 'Never'/);
  assert.match(text, /::add-mask::\$password/);
});
