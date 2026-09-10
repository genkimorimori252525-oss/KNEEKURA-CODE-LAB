import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const WORKFLOW = new URL('../.github/workflows/kneekura-github-relay.yml', import.meta.url);
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
  const text = await fs.readFile(WORKFLOW, 'utf8');

  assert.match(text, /id:\s*engine_prep/);
  assert.match(text, /name:\s*Resolve Relay engine preparation/);
  assert.match(text, /ConvertFrom-Json/);
  assert.match(text, /'understand-anything'/);

  assert.match(text, /name:\s*Use Node 22 for pinned Understand Anything when requested/);
  assert.match(text, /if:\s*steps\.engine_prep\.outputs\.selection == 'understand-anything'/);
  assert.ok(text.includes(PINNED_SETUP_NODE));
  assert.match(text, /node-version:\s*22/);

  assert.match(text, /name:\s*Prepare pinned Understand Anything v2\.9\.0 when requested/);
  assert.ok(text.includes(PINNED_UA_COMMIT));
  assert.ok(text.includes(PINNED_UA_PLUGIN_TREE));
  for (const blob of PINNED_UA_BLOBS) assert.ok(text.includes(blob));

  assert.match(text, /git -C \$dest fetch --depth 1 origin \$expectedCommit/);
  assert.match(text, /git -C \$dest checkout --detach FETCH_HEAD/);
  assert.match(text, /git -C \$dest rev-parse 'HEAD:understand-anything-plugin'/);
  assert.match(text, /git -C \$dest hash-object \$entry\.Key/);
  assert.match(text, /corepack prepare pnpm@10\.6\.2 --activate/);
  assert.match(text, /pnpm install --frozen-lockfile/);
  assert.match(text, /pnpm --filter '@understand-anything\/core' build/);
  assert.match(text, /pnpm --filter '@understand-anything\/dashboard' build/);
  assert.match(text, /KNEEKURA_UA_ROOT=\$dest/);
  assert.match(text, /KNEEKURA_UA_DASHBOARD_ROOT=\$dashboard/);

  const install = text.indexOf('name: Install pinned Code LAB dependencies without lifecycle scripts');
  const switchNode = text.indexOf('name: Use Node 22 for pinned Understand Anything when requested');
  const prepareUa = text.indexOf('name: Prepare pinned Understand Anything v2.9.0 when requested');
  const execute = text.indexOf('name: Execute one disposable Relay turn');
  assert(install >= 0 && install < switchNode);
  assert(switchNode < prepareUa && prepareUa < execute);
});

test('P4 UA pin constants remain immutable Git identities', () => {
  assert.match(PINNED_UA_COMMIT, /^[0-9a-f]{40}$/);
  assert.match(PINNED_UA_PLUGIN_TREE, /^[0-9a-f]{40}$/);
  for (const blob of PINNED_UA_BLOBS) assert.match(blob, /^[0-9a-f]{40}$/);
});
