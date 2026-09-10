import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const WORKFLOW = new URL('../.github/workflows/kneekura-github-relay.yml', import.meta.url);

test('same-owner Relay credential fallback captures GitHub CLI token without exposing it', async () => {
  const text = await fs.readFile(WORKFLOW, 'utf8');

  assert.match(text, /name: Resolve same-owner credential from GitHub CLI/);
  assert.match(text, /Get-Command gh -ErrorAction SilentlyContinue/);
  assert.match(text, /New-Object System\.Diagnostics\.ProcessStartInfo/);
  assert.match(text, /\$tokenProcessInfo\.FileName = \$ghCommand\.Source/);
  assert.match(text, /\$tokenProcessInfo\.Arguments = 'auth token --hostname github\.com'/);
  assert.match(text, /\$tokenProcessInfo\.UseShellExecute = \$false/);
  assert.match(text, /\$tokenProcessInfo\.CreateNoWindow = \$true/);
  assert.match(text, /\$tokenProcessInfo\.RedirectStandardOutput = \$true/);
  assert.match(text, /\$tokenProcessInfo\.RedirectStandardError = \$true/);
  assert.match(text, /\$ghToken = \$ghToken\.Trim\(\)/);
  assert.match(text, /::add-mask::\$ghToken/);
  assert.match(text, /KNEEKURA_RELAY_GITHUB_TOKEN=\$ghToken/);
  assert.doesNotMatch(text, /git credential fill/);
  assert.doesNotMatch(text, /StandardInput\.WriteLine\('protocol=https'\)/);
  assert.doesNotMatch(text, /Write-Host\s+['"]?\$tokenOutput/);
  assert.doesNotMatch(text, /Write-Host\s+['"]?\$ghToken/);
});
