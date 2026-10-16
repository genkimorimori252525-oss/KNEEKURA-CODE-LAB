import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

test('ordinary CI uses hosted Windows while explicit local-live profiles retain their environment',async()=>{
 const ci=await fs.readFile('.github/workflows/ci.yml','utf8');
 assert.match(ci,/windows-latest/);
 assert.match(ci,/github.event_name == 'push'/);
 assert.match(ci,/fromJSON\('\["self-hosted","Windows","X64","kneekura-code-lab"\]'\)/);
 for(const name of ['npm test','npm run plugin:package','smoke-kneekura-code-lab-plugin.mjs','validate-human-explorer-file-browser.mjs','npm run presentation:guard'])assert.ok(ci.includes(name));
});
test('Relay Foundation test job uses hosted Windows without changing privileged relay execution',async()=>{
 const foundation=await fs.readFile('.github/workflows/github-relay-foundation.yml','utf8');
 assert.match(foundation,/runs-on: windows-latest/);assert.match(foundation,/shell: powershell/);assert.doesNotMatch(foundation,/secrets\./);
 const executor=await fs.readFile('.github/workflows/kneekura-github-relay.yml','utf8');assert.match(executor,/runs-on: \[self-hosted, Windows, X64, kneekura-code-lab\]/);
});
