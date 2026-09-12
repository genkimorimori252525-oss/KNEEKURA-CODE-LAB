import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ALL_CHILD_RESULT_MANIFEST_SCHEMA,
  ALL_CONTEXT_ASSURANCE_CLASS,
  ALL_CONTEXT_CLAIM_SCHEMA,
  GITHUB_RELAY_SCHEMAS,
  runGithubRelayTurn,
  validateAllContextClaim
} from '../src/github-relay/index.mjs';

const OWNER = 'genkimorimori252525-oss';
const TARGET = `${OWNER}/KNEEKURA-LAB`;
const TARGET_REVISION = 'a'.repeat(40);
const CODE_LAB_REVISION = 'b'.repeat(40);
const ENGINE_LOCK_DIGEST = `sha256:${'c'.repeat(64)}`;
const ISSUE = 220;

const REQUEST = Object.freeze({
  schema: GITHUB_RELAY_SCHEMAS.request,
  selection: 'all',
  target: { repository: TARGET, revision: TARGET_REVISION },
  commonScope: { question: 'Explain the exact Water Tank Studio snapshot independently.' },
  engineOptions: {},
  minimumClaimLevel: {},
  semanticContextMode: 'per-engine'
});

function semanticBackendSpy() {
  const state = { executeCalls: 0 };
  return {
    state,
    async execute() {
      state.executeCalls += 1;
      throw new Error('ALL parent must never invoke semantic backend');
    },
    async acceptHostResponse() {
      throw new Error('ALL parent must never accept semantic responses');
    }
  };
}

test('ALL parent is control-plane only, creates three child slots once, then waits for contexts and sealed results', async () => {
  const fixture = await makeTargetFixture();
  try {
    const firstBackend = semanticBackendSpy();
    const first = await runGithubRelayTurn({
      request: REQUEST,
      issueNumber: ISSUE,
      targetRoot: fixture.root,
      codeLabRevision: CODE_LAB_REVISION,
      engineLockDigest: ENGINE_LOCK_DIGEST,
      backend: firstBackend
    });
    assert.equal(firstBackend.state.executeCalls, 0);
    assert.deepEqual(first.actions.map(row => row.kind), [
      'PLAN',
      'ALL_CHILD_CREATE',
      'ALL_CHILD_CREATE',
      'ALL_CHILD_CREATE',
      'ALL_CONTEXTS_REQUIRED'
    ]);
    assert.equal(first.actions.some(row => row.kind === 'TASK'), false);

    const plan = first.actions.find(row => row.kind === 'PLAN').envelope;
    const creates = first.actions.filter(row => row.kind === 'ALL_CHILD_CREATE');
    assert.deepEqual(creates.map(row => row.binding.engine_id), [
      'kneekura', 'understand-anything', 'archify'
    ]);
    assert.ok(creates.every(row => row.binding.scope_digest === plan.target.scope_digest));
    assert.deepEqual(creates.map(row => row.child_request.selection), [
      'kneekura', 'understand-anything', 'archify'
    ]);

    const boundChildren = creates.map((row, index) => ({
      ...row.binding,
      child_issue_number: 301 + index
    }));
    const secondBackend = semanticBackendSpy();
    const second = await runGithubRelayTurn({
      request: REQUEST,
      issueNumber: ISSUE,
      targetRoot: fixture.root,
      codeLabRevision: CODE_LAB_REVISION,
      engineLockDigest: ENGINE_LOCK_DIGEST,
      backend: secondBackend,
      existingPlan: plan,
      allChildBindings: boundChildren
    });
    assert.equal(secondBackend.state.executeCalls, 0);
    assert.deepEqual(second.actions.map(row => row.kind), ['ALL_CONTEXTS_REQUIRED']);

    const claims = boundChildren.map((binding, index) => validateAllContextClaim({
      schema: ALL_CONTEXT_CLAIM_SCHEMA,
      parent_run_id: plan.run_id,
      parent_issue_number: ISSUE,
      child_issue_number: binding.child_issue_number,
      engine_id: binding.engine_id,
      host_context_id: `host-session-${index + 1}`,
      assurance_class: ALL_CONTEXT_ASSURANCE_CLASS
    }, binding));

    const thirdBackend = semanticBackendSpy();
    const third = await runGithubRelayTurn({
      request: REQUEST,
      issueNumber: ISSUE,
      targetRoot: fixture.root,
      codeLabRevision: CODE_LAB_REVISION,
      engineLockDigest: ENGINE_LOCK_DIGEST,
      backend: thirdBackend,
      existingPlan: plan,
      allChildBindings: boundChildren,
      allContextClaims: claims
    });
    assert.equal(thirdBackend.state.executeCalls, 0);
    assert.deepEqual(third.actions.map(row => row.kind), ['ALL_CHILDREN_PENDING']);

    const manifests = boundChildren.map((binding, index) => ({
      schema: ALL_CHILD_RESULT_MANIFEST_SCHEMA,
      parent_run_id: plan.run_id,
      parent_issue_number: ISSUE,
      child_run_id: `ghr-${binding.child_issue_number}-${TARGET_REVISION.slice(0, 12)}-${plan.target.scope_digest.slice(7, 19)}`,
      child_issue_number: binding.child_issue_number,
      engine_id: binding.engine_id,
      child_request_digest: binding.child_request_digest,
      target: { ...plan.target },
      scope_digest: plan.target.scope_digest,
      code_lab_revision: plan.code_lab_revision,
      engine_lock_digest: plan.engine_lock_digest,
      host_context_id: claims[index].host_context_id,
      assurance_class: claims[index].assurance_class,
      result_zip: { digest: `sha256:${String(index + 1).repeat(64)}`, bytes: 100 + index },
      receipt_digest: `sha256:${String(index + 4).repeat(64)}`
    }));

    const fourthBackend = semanticBackendSpy();
    const fourth = await runGithubRelayTurn({
      request: REQUEST,
      issueNumber: ISSUE,
      targetRoot: fixture.root,
      codeLabRevision: CODE_LAB_REVISION,
      engineLockDigest: ENGINE_LOCK_DIGEST,
      backend: fourthBackend,
      existingPlan: plan,
      allChildBindings: boundChildren,
      allContextClaims: claims,
      allChildResults: manifests
    });
    assert.equal(fourthBackend.state.executeCalls, 0);
    assert.deepEqual(fourth.actions.map(row => row.kind), ['ALL_COMPOSE_REQUIRED']);
    assert.equal(fourth.actions[0].children.length, 3);
  } finally {
    await fixture.cleanup();
  }
});

test('ALL parent rejects drifted recovered child binding instead of creating or substituting a replacement', async () => {
  const fixture = await makeTargetFixture();
  try {
    const first = await runGithubRelayTurn({
      request: REQUEST,
      issueNumber: ISSUE + 1,
      targetRoot: fixture.root,
      codeLabRevision: CODE_LAB_REVISION,
      engineLockDigest: ENGINE_LOCK_DIGEST,
      backend: semanticBackendSpy()
    });
    const plan = first.actions.find(row => row.kind === 'PLAN').envelope;
    const creates = first.actions.filter(row => row.kind === 'ALL_CHILD_CREATE');
    const boundChildren = creates.map((row, index) => ({
      ...row.binding,
      child_issue_number: 401 + index
    }));
    boundChildren[1] = { ...boundChildren[1], engine_id: 'archify' };

    await assert.rejects(
      runGithubRelayTurn({
        request: REQUEST,
        issueNumber: ISSUE + 1,
        targetRoot: fixture.root,
        codeLabRevision: CODE_LAB_REVISION,
        engineLockDigest: ENGINE_LOCK_DIGEST,
        backend: semanticBackendSpy(),
        existingPlan: plan,
        allChildBindings: boundChildren
      }),
      error => error?.code === 'ALL_CHILD_BINDING_MISMATCH'
    );
  } finally {
    await fixture.cleanup();
  }
});

async function makeTargetFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kneekura-relay-all-parent-'));
  git(root, ['init']);
  git(root, ['remote', 'add', 'origin', `https://github.com/${TARGET}.git`]);
  return {
    root,
    cleanup: () => fs.rm(root, { recursive: true, force: true })
  };
}

function git(cwd, args) {
  return childProcess.execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
}