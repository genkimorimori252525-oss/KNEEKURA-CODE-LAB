import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const RUNTIME = new URL('../scripts/run-kneekura-github-relay.mjs', import.meta.url);

test('target Git child drops repository-scoped Actions token before explicit Relay askpass auth', async () => {
  const text = await fs.readFile(RUNTIME, 'utf8');
  const start = text.indexOf('async function materializeTarget({');
  const end = text.indexOf('\nasync function createAskpass(', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const body = text.slice(start, end);

  assert.match(body, /const env = \{[\s\S]*?GIT_TERMINAL_PROMPT: '0',[\s\S]*?GCM_INTERACTIVE: 'Never'[\s\S]*?\};/);
  assert.match(body, /delete env\.GITHUB_TOKEN;/);
  assert.match(body, /env\.GIT_ASKPASS = askpassPath;/);
  assert.match(body, /env\.KNEEKURA_RELAY_FETCH_TOKEN = token;/);
  assert.ok(body.indexOf('delete env.GITHUB_TOKEN;') < body.indexOf("'fetch', '--depth'"));
});
