import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const WORKFLOW = new URL('../.github/workflows/kneekura-github-relay.yml', import.meta.url);
const PINNED_UA_COMMIT = 'f08763d11d0202a8a8f52b5dedda6d1b2e2ebac8';

test('P4 UA cache is exact-pin keyed, fail-closed, and rebuilt from verified source', async () => {
  const text = await fs.readFile(WORKFLOW, 'utf8');

  assert.ok(text.includes('understand-anything-v2.9.0-$expectedCommit'));
  assert.ok(text.includes(PINNED_UA_COMMIT));
  assert.match(text, /function Test-PinnedUaCache/);
  assert.match(text, /git -C \$root rev-parse HEAD/);
  assert.match(text, /git -C \$root rev-parse 'HEAD:understand-anything-plugin'/);
  assert.match(text, /git -C \$root hash-object \$entry\.Key/);
  assert.match(text, /status --porcelain --untracked-files=no/);
  assert.ok(text.includes("node_modules\\.pnpm"));
  assert.match(text, /if \(-not \(Test-PinnedUaCache \$cacheRoot\)\)/);
  assert.match(text, /Remove-Item -LiteralPath \$cacheRoot -Recurse -Force/);
  assert.match(text, /\$tmpRoot = "\$cacheRoot\.\$env:GITHUB_RUN_ID\.tmp"/);
  assert.match(text, /Move-Item -LiteralPath \$tmpRoot -Destination \$cacheRoot/);
  assert.match(text, /throw 'Pinned UA cache failed exact identity verification'/);
});

test('P4 UA cache never trusts stale generated output without rebuilding on reuse', async () => {
  const text = await fs.readFile(WORKFLOW, 'utf8');

  const verify = text.indexOf("if (-not (Test-PinnedUaCache $cacheRoot)) { throw 'Pinned UA cache failed exact identity verification' }");
  const reuse = text.indexOf('if (-not $freshBuild)');
  const coreBuild = text.indexOf("pnpm --filter '@understand-anything/core' build", reuse);
  const dashboardBuild = text.indexOf("pnpm --filter '@understand-anything/dashboard' build", reuse);
  const exportRoot = text.indexOf('KNEEKURA_UA_ROOT=$cacheRoot');

  assert(verify >= 0);
  assert(reuse > verify);
  assert(coreBuild > reuse);
  assert(dashboardBuild > coreBuild);
  assert(exportRoot > dashboardBuild);
  assert.match(text, /cached dashboard build missing index\.html/);
});
