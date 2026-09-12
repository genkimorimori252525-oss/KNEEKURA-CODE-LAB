import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ALL_CONTEXT_ASSURANCE_CLASS,
  ALL_CONTEXT_CLAIM_SCHEMA,
  GITHUB_RELAY_SCHEMAS,
  createAllChildBindings,
  createGithubRelayExecutionContext,
  relayScopeDigest,
  runGithubRelayTurn,
  validateAllContextClaim
} from '../src/github-relay/index.mjs';
import {
  HostTaskRequiredError,
  createHostTask
} from '../mcp/src/host-bridge-contract.mjs';

const OWNER = 'genkimorimori252525-oss';
const TARGET = `${OWNER}/KNEEKURA-LAB`;
const TARGET_REVISION = 'a'.repeat(40);
const CODE_LAB_REVISION = 'b'.repeat(40);
const ENGINE_LOCK_DIGEST = `sha256:${'c'.repeat(64)}`;

const PARENT_REQUEST = Object.freeze({
  schema: GITHUB_RELAY_SCHEMAS.request,
  selection: 'all',
  target: { repository: TARGET, revision: TARGET_REVISION },
  commonScope: { question: 'Explain the exact snapshot independently.' },
  engineOptions: {},
  minimumClaimLevel: {},
  semanticContextMode: 'per-engine'
});

const CHILD_REQUEST = Object.freeze({
  schema: GITHUB_RELAY_SCHEMAS.request,
  selection: 'understand-anything',
  target: { repository: TARGET, revision: TARGET_REVISION },
  commonScope: { question: 'Explain the exact snapshot independently.' },
  engineOptions: {},
  minimumClaimLevel: {},
  semanticContextMode: 'single-context'
});

test('parent-bound ALL child inherits exact parent scope instead of recomputing standalone scope', async () => {
  const fixture = await makeTargetFixture();
  try {
    const parent = await createGithubRelayExecutionContext({
      request: PARENT_REQUEST,
      issueNumber: 220,
      targetRoot: fixture.root,
      codeLabRevision: CODE_LAB_REVISION,
      engineLockDigest: ENGINE_LOCK_DIGEST
    });
    const binding = {
      ...createAllChildBindings({
        parentRunId: parent.runId,
        parentIssueNumber: 220,
        request: PARENT_REQUEST,
        relayPlan: parent.relayPlan
      })[1],
      child_issue_number: 301
    };
    const claim = validateAllContextClaim({
      schema: ALL_CONTEXT_CLAIM_SCHEMA,
      parent_run_id: parent.runId,
      parent_issue_number: 220,
      child_issue_number: 301,
      engine_id: 'understand-anything',
      host_context_id: 'host-session-ua-1',
      assurance_class: ALL_CONTEXT_ASSURANCE_CLASS
    }, binding);

    assert.notEqual(relayScopeDigest(CHILD_REQUEST), parent.scopeDigest);
    const backend = taskBackend();
    const turn = await runGithubRelayTurn({
      request: CHILD_REQUEST,
      issueNumber: 301,
      targetRoot: fixture.root,
      codeLabRevision: CODE_LAB_REVISION,
      engineLockDigest: ENGINE_LOCK_DIGEST,
      backend,
      allChildBinding: binding,
      allContextClaim: claim
    });

    assert.equal(turn.relay_plan.target.scope_digest, parent.scopeDigest);
    assert.equal(backend.seenScope(), parent.scopeDigest);
    assert.deepEqual(turn.actions.map(row => row.kind), ['PLAN', 'TASK']);
    assert.equal(turn.actions[1].envelope.task.engine_id, 'understand-anything');
    assert.equal(turn.actions[1].envelope.task.scope_digest, parent.scopeDigest);
  } finally {
    await fixture.cleanup();
  }
});

test('parent-bound child fails closed without its accepted context claim', async () => {
  const fixture = await makeTargetFixture();
  try {
    const { binding } = await parentBoundUaFixture(fixture.root);
    await assert.rejects(
      runGithubRelayTurn({
        request: CHILD_REQUEST,
        issueNumber: 301,
        targetRoot: fixture.root,
        codeLabRevision: CODE_LAB_REVISION,
        engineLockDigest: ENGINE_LOCK_DIGEST,
        backend: taskBackend(),
        allChildBinding: binding
      }),
      error => error?.code === 'BLOCKED_SEMANTIC_CONTEXT_ISOLATION'
    );
  } finally {
    await fixture.cleanup();
  }
});

test('parent-bound child rejects request projection drift from the parent-authorized child digest', async () => {
  const fixture = await makeTargetFixture();
  try {
    const { binding, claim } = await parentBoundUaFixture(fixture.root);
    await assert.rejects(
      runGithubRelayTurn({
        request: {
          ...CHILD_REQUEST,
          commonScope: { question: 'Edited child question must not silently rebind scope.' }
        },
        issueNumber: 301,
        targetRoot: fixture.root,
        codeLabRevision: CODE_LAB_REVISION,
        engineLockDigest: ENGINE_LOCK_DIGEST,
        backend: taskBackend(),
        allChildBinding: binding,
        allContextClaim: claim
      }),
      error => error?.code === 'ALL_CHILD_BINDING_MISMATCH'
    );
  } finally {
    await fixture.cleanup();
  }
});

async function parentBoundUaFixture(root) {
  const parent = await createGithubRelayExecutionContext({
    request: PARENT_REQUEST,
    issueNumber: 220,
    targetRoot: root,
    codeLabRevision: CODE_LAB_REVISION,
    engineLockDigest: ENGINE_LOCK_DIGEST
  });
  const binding = {
    ...createAllChildBindings({
      parentRunId: parent.runId,
      parentIssueNumber: 220,
      request: PARENT_REQUEST,
      relayPlan: parent.relayPlan
    })[1],
    child_issue_number: 301
  };
  const claim = validateAllContextClaim({
    schema: ALL_CONTEXT_CLAIM_SCHEMA,
    parent_run_id: parent.runId,
    parent_issue_number: 220,
    child_issue_number: 301,
    engine_id: 'understand-anything',
    host_context_id: 'host-session-ua-1',
    assurance_class: ALL_CONTEXT_ASSURANCE_CLASS
  }, binding);
  return { parent, binding, claim };
}

function taskBackend() {
  let scope = null;
  return {
    async execute(plan) {
      scope = plan.target.scopeDigest;
      const task = createHostTask({
        runId: plan.runId,
        engineId: 'understand-anything',
        attemptId: 'attempt-all-child-ua',
        snapshotId: plan.target.snapshotId,
        scopeDigest: plan.target.scopeDigest,
        ordinal: 1,
        kind: 'ua:project-scanner',
        payload: { prompt: 'Analyze exact child snapshot.' }
      });
      throw new HostTaskRequiredError(task);
    },
    async acceptHostResponse() {},
    seenScope: () => scope
  };
}

async function makeTargetFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kneekura-relay-all-child-'));
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