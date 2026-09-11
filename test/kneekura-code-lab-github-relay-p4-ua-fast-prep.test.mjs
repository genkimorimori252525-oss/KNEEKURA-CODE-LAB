import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const WORKFLOW = new URL('../.github/workflows/kneekura-github-relay.yml', import.meta.url);
const SCRIPT = new URL('../scripts/prepare-kneekura-relay-ua.ps1', import.meta.url);

const COMMIT = 'f08763d11d0202a8a8f52b5dedda6d1b2e2ebac8';
const TREE = 'c79dd16babb26a39aca4a15156bc488bcfc69587';
const VIEWER_SHA = 'a8626ff3ad90041e807bfdb8994eefdd986e891593c4759d08222667e5405330';

test('P4 UA fast prep stays exact-pinned while caching only transport inputs', async () => {
  const [workflow, script] = await Promise.all([
    fs.readFile(WORKFLOW, 'utf8'),
    fs.readFile(SCRIPT, 'utf8')
  ]);

  assert.match(workflow, /name:\s*Prepare pinned Understand Anything v2\.9\.0 when requested/);
  assert.match(workflow, /if:\s*steps\.engine_prep\.outputs\.selection == 'understand-anything'/);
  assert.match(workflow, /scripts\/prepare-kneekura-relay-ua\.ps1/);
  assert.doesNotMatch(workflow, /pnpm --filter '@understand-anything\/dashboard' build/);

  assert.ok(script.includes(COMMIT));
  assert.ok(script.includes(TREE));
  assert.ok(script.includes(VIEWER_SHA));
  assert.match(script, /git -C \$sourceRoot fetch --depth 1 origin \$expectedCommit/);
  assert.match(script, /git -C \$sourceRoot reset --hard \$expectedCommit/);
  assert.match(script, /rev-parse 'HEAD:understand-anything-plugin'/);
  assert.match(script, /hash-object \$entry\.Key/);
  assert.match(script, /pnpm install --frozen-lockfile --prefer-offline/);
  assert.match(script, /pnpm --filter '@understand-anything\/core' build/);
  assert.doesNotMatch(script, /@understand-anything\/dashboard' build/);
  assert.match(script, /releases\/download\/v2\.9\.0\/understand-anything-viewer\.tgz/);
  assert.match(script, /Get-FileHash -Algorithm SHA256 \$viewerTgz/);
  assert.match(script, /Get-FileHash -Algorithm SHA256 \$tmpViewer/);
  assert.match(script, /KNEEKURA_UA_ROOT=\$sourceRoot/);
  assert.match(script, /KNEEKURA_UA_DASHBOARD_ROOT=\$dashboardRoot/);
});
