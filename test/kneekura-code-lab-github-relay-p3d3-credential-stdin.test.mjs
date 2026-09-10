import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const WORKFLOW = new URL('../.github/workflows/kneekura-github-relay.yml', import.meta.url);

test('same-owner Git credential request writes the Git protocol directly to child-process stdin', async () => {
  const text = await fs.readFile(WORKFLOW, 'utf8');

  assert.match(text, /New-Object System\.Diagnostics\.ProcessStartInfo/);
  assert.match(text, /\$credentialProcessInfo\.FileName = 'git'/);
  assert.match(text, /\$credentialProcessInfo\.Arguments = 'credential fill'/);
  assert.match(text, /\$credentialProcessInfo\.RedirectStandardInput = \$true/);
  assert.match(text, /\$credentialProcess\.StandardInput\.WriteLine\('protocol=https'\)/);
  assert.match(text, /\$credentialProcess\.StandardInput\.WriteLine\('host=github\.com'\)/);
  assert.match(text, /\$credentialProcess\.StandardInput\.WriteLine\(''\)/);
  assert.match(text, /\$credentialProcess\.StandardInput\.Close\(\)/);
  assert.doesNotMatch(
    text,
    /\$credentialLines = @\('protocol=https', 'host=github\.com', ''\) \| & git credential fill 2>\$null/
  );
  assert.doesNotMatch(text, /\$credentialInput\s*=\s*"protocol=https/);
  assert.match(text, /GIT_TERMINAL_PROMPT = '0'/);
  assert.match(text, /GCM_INTERACTIVE = 'Never'/);
  assert.match(text, /::add-mask::\$password/);
});
