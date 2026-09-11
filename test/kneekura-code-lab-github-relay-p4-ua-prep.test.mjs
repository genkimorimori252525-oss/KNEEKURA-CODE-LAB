import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const WORKFLOW = new URL('../.github/workflows/kneekura-github-relay.yml', import.meta.url);
const PREP = new URL('../scripts/prepare-kneekura-relay-ua.ps1', import.meta.url);
const PINNED_SETUP_NODE = 'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020';
const PINNED_UA_COMMIT = 'f08763d11d0202a8a8f52b5dedda6d1b2e2ebac8';
const PINNED_UA_PLUGIN_TREE = 'c79dd16babb26a39aca4a15156bc488bcfc69587';
const PINNED_UA_BLOBS = Object.freeze([
  'e06bc5863abcafdd9c4108e34cbbf5fd6448cedf',
  'fd4cf7539627856d6b166c39dc1041165fa2ce87',
  '99bede1a9a7e008e621011d6c984a6b97518946f',
  '5df102e8a2e29cdfb881ae7ec5040f2766564680'
]);

test('P4 UA preparation is request-scoped and preserves the pinned native acceptance identity', async () => {
  const [workflow, prep] = await Promise.all([
    fs.readFile(WORKFLOW, 'utf8'),
    fs.readFile(PREP, 'utf8')
  ]);

  assert.match(workflow, /id:\s*engine_prep/);
  assert.match(workflow, /name:\s*Resolve Relay engine preparation/);
  assert.match(workflow, /ConvertFrom-Json/);
  assert.match(workflow, /'understand-anything'/);

  assert.match(workflow, /name:\s*Use Node 22 for pinned Understand Anything when requested/);
  assert.match(workflow, /if:\s*steps\.engine_prep\.outputs\.selection == 'understand-anything'/);
  assert.ok(workflow.includes(PINNED_SETUP_NODE));
  assert.match(workflow, /node-version:\s*22/);

  assert.match(workflow, /name:\s*Prepare pinned Understand Anything v2\.9\.0 when requested/);
  assert.match(workflow, /scripts\/prepare-kneekura-relay-ua\.ps1/);
  assert.ok(prep.includes(PINNED_UA_COMMIT));
  assert.ok(prep.includes(PINNED_UA_PLUGIN_TREE));
  for (const blob of PINNED_UA_BLOBS) assert.ok(prep.includes(blob));

  assert.match(prep, /git -C \$sourceRoot fetch --depth 1 origin \$expectedCommit/);
  assert.match(prep, /git -C \$sourceRoot reset --hard \$expectedCommit/);
  assert.match(prep, /git -C \$sourceRoot rev-parse 'HEAD:understand-anything-plugin'/);
  assert.match(prep, /git -C \$sourceRoot hash-object \$entry\.Key/);
  assert.match(prep, /corepack prepare pnpm@10\.6\.2 --activate/);
  assert.match(prep, /pnpm install --frozen-lockfile --prefer-offline/);
  assert.match(prep, /pnpm --filter '@understand-anything\/core' build/);
  assert.doesNotMatch(prep, /pnpm --filter '@understand-anything\/dashboard' build/);
  assert.match(prep, /KNEEKURA_UA_ROOT=\$sourceRoot/);
  assert.match(prep, /KNEEKURA_UA_DASHBOARD_ROOT=\$dashboardRoot/);

  const install = workflow.indexOf('name: Install pinned Code LAB dependencies without lifecycle scripts');
  const switchNode = workflow.indexOf('name: Use Node 22 for pinned Understand Anything when requested');
  const prepareUa = workflow.indexOf('name: Prepare pinned Understand Anything v2.9.0 when requested');
  const execute = workflow.indexOf('name: Execute one disposable Relay turn');
  assert(install >= 0 && install < switchNode);
  assert(switchNode < prepareUa && prepareUa < execute);
});

test('P4 UA pin constants remain immutable Git identities', () => {
  assert.match(PINNED_UA_COMMIT, /^[0-9a-f]{40}$/);
  assert.match(PINNED_UA_PLUGIN_TREE, /^[0-9a-f]{40}$/);
  for (const blob of PINNED_UA_BLOBS) assert.match(blob, /^[0-9a-f]{40}$/);
});
