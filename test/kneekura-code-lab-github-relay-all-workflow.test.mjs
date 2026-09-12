import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const WORKFLOW = new URL('../.github/workflows/kneekura-github-relay.yml', import.meta.url);
const RUNNER = new URL('../scripts/run-kneekura-github-relay.mjs', import.meta.url);
const PUBLISHER = new URL('../scripts/publish-kneekura-github-relay.mjs', import.meta.url);
const TRANSPORT = new URL('../src/github-relay/issue-transport.mjs', import.meta.url);
const OLD_RUNTIME = 'f370f70e99e7cab30f89297c042091ad52a03220';

test('ALL workflow admits only external context/resume control and grants bounded Actions read access', async () => {
  const text = await fs.readFile(WORKFLOW, 'utf8');
  assert.match(text, /actions:\s*read/);
  assert.match(text, /KNEEKURA_RELAY_CONTEXT_CLAIM_V1/);
  assert.match(text, /KNEEKURA_RELAY_ALL_RESUME_V1/);
  assert.match(text, /issues:\s*write/);
  assert.match(text, /contents:\s*read/);
  assert.doesNotMatch(text, /contents:\s*write/);
  assert.doesNotMatch(text, /actions:\s*write/);

  assert.match(text, /if \(\$selection -ne 'archify'\) \{ exit 0 \}/);
  assert.match(text, /steps\.engine_prep\.outputs\.selection == 'understand-anything'/);
  assert.doesNotMatch(text, /selection == 'all'[^\n]*understand-anything/);
  assert.doesNotMatch(text, /selection -eq 'all'[^\n]*archify/);

  const checkout = text.match(/Checkout pinned Relay runtime[\s\S]*?ref:\s*([0-9a-f]{40})/);
  assert.ok(checkout, 'workflow must pin one exact Relay runtime SHA');
  assert.notEqual(checkout[1], OLD_RUNTIME, 'ALL workflow must not keep the pre-ALL runtime pin');
});

test('production runner activates ALL as control-only, collects child artifacts, and never uses shared semantic fallback', async () => {
  const text = await fs.readFile(RUNNER, 'utf8');
  assert.doesNotMatch(text, /ALL production activation remains blocked/);
  assert.match(text, /composeVerifiedAllChildResults/);
  assert.match(text, /downloadActionsArtifact/);
  assert.match(text, /collectAllChildState/);
  assert.match(text, /control_actions/);
  assert.match(text, /request\.selection === 'all'\s*\?\s*null/);
  assert.doesNotMatch(text, /selection:\s*'all'[\s\S]{0,120}backend\.execute/);
});

test('publisher creates/reuses deterministic child Issues and records immutable child bindings', async () => {
  const text = await fs.readFile(PUBLISHER, 'utf8');
  assert.match(text, /ALL_CHILD_CREATE/);
  assert.match(text, /findOrCreateChildIssue/);
  assert.match(text, /postCommentIfAbsent/);
  assert.match(text, /GITHUB_RELAY_MARKERS\.allChildBinding/);
  assert.match(text, /child_issue_number/);
  assert.match(text, /parent_run_id/);
});

test('Relay transport exposes dedicated ALL resume marker separate from semantic responses', async () => {
  const text = await fs.readFile(TRANSPORT, 'utf8');
  assert.match(text, /allResume:\s*'KNEEKURA_RELAY_ALL_RESUME_V1'/);
  assert.match(text, /allResumes:\s*\[\]/);
  assert.match(text, /allContextClaim:\s*'KNEEKURA_RELAY_CONTEXT_CLAIM_V1'/);
});

test('ALL child Issue opened events stay inert until an external context claim arrives', async () => {
  const text = await fs.readFile(WORKFLOW, 'utf8');
  assert.match(text, /\[KNEEKURA ALL child /);
  assert.match(text, /isAllChild/);
  assert.match(text, /!isAllChild/);
  assert.match(text, /KNEEKURA_RELAY_CONTEXT_CLAIM_V1/);
});