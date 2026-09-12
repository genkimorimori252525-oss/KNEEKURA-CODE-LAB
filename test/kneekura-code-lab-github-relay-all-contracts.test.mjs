import assert from 'node:assert/strict';
import test from 'node:test';

import * as relay from '../src/github-relay/index.mjs';

const REVISION = 'a'.repeat(40);
const SNAPSHOT = `snapshot:sha256:${'b'.repeat(64)}`;
const SCOPE = `sha256:${'c'.repeat(64)}`;
const RUNTIME = 'd'.repeat(40);
const LOCK = `sha256:${'e'.repeat(64)}`;
const PARENT_RUN = 'ghr-200-parent';
const PARENT_ISSUE = 200;
const ASSURANCE = 'OPERATOR_SEPARATED_HOST_SESSION_V1';

const parentRequest = Object.freeze({
  schema: 'kneekura.code-lab.github-relay-request/v1',
  selection: 'all',
  target: { repository: 'owner/repository', revision: REVISION },
  commonScope: { question: 'explain the exact snapshot' },
  engineOptions: {},
  minimumClaimLevel: {},
  semanticContextMode: 'per-engine'
});

const parentPlan = Object.freeze({
  schema: 'kneekura.code-lab.github-relay-plan/v1',
  run_id: PARENT_RUN,
  selection: 'all',
  target: {
    repository: 'owner/repository',
    revision: REVISION,
    snapshot_id: SNAPSHOT,
    scope_digest: SCOPE
  },
  semantic_context_mode: 'per-engine',
  code_lab_revision: RUNTIME,
  engine_lock_digest: LOCK
});

function required(name) {
  const value = relay[name];
  if (typeof value === 'function') return value;
  return () => assert.fail(`${name} is not implemented`);
}

const createAllChildBindings = required('createAllChildBindings');
const validateAllContextClaim = required('validateAllContextClaim');
const assertDistinctAllContextClaims = required('assertDistinctAllContextClaims');
const validateAllChildResultManifest = required('validateAllChildResultManifest');

test('ALL parent creates exactly three fixed child slots that inherit parent snapshot and scope', () => {
  const bindings = createAllChildBindings({
    parentRunId: PARENT_RUN,
    parentIssueNumber: PARENT_ISSUE,
    request: parentRequest,
    relayPlan: parentPlan
  });

  assert.deepEqual(bindings.map(row => row.engine_id), [
    'kneekura', 'understand-anything', 'archify'
  ]);
  assert.equal(bindings.length, 3);
  assert.ok(bindings.every(row => row.parent_run_id === PARENT_RUN));
  assert.ok(bindings.every(row => row.parent_issue_number === PARENT_ISSUE));
  assert.ok(bindings.every(row => row.target.snapshot_id === SNAPSHOT));
  assert.ok(bindings.every(row => row.scope_digest === SCOPE));
  assert.ok(bindings.every(row => row.code_lab_revision === RUNTIME));
  assert.ok(bindings.every(row => row.engine_lock_digest === LOCK));
  assert.ok(bindings.every(row => /^sha256:[0-9a-f]{64}$/.test(row.child_request_digest)));
  assert.equal(new Set(bindings.map(row => row.child_request_digest)).size, 3);
});

test('context claim is exact-child bound and never accepts a different engine', () => {
  const [slot] = createAllChildBindings({
    parentRunId: PARENT_RUN,
    parentIssueNumber: PARENT_ISSUE,
    request: parentRequest,
    relayPlan: parentPlan
  });
  const binding = { ...slot, child_issue_number: 301 };
  const claim = {
    schema: 'kneekura.code-lab.github-relay-all-context-claim/v1',
    parent_run_id: PARENT_RUN,
    parent_issue_number: PARENT_ISSUE,
    child_issue_number: 301,
    engine_id: 'kneekura',
    host_context_id: 'chatgpt-context-kneekura-001',
    assurance_class: ASSURANCE
  };

  const accepted = validateAllContextClaim(claim, binding);
  assert.equal(accepted.host_context_id, 'chatgpt-context-kneekura-001');
  assert.equal(accepted.assurance_class, ASSURANCE);

  assert.throws(
    () => validateAllContextClaim({ ...claim, engine_id: 'archify' }, binding),
    error => error?.code === 'BLOCKED_SEMANTIC_CONTEXT_ISOLATION'
  );
});

test('three ALL children must claim three distinct host semantic contexts', () => {
  const bindings = createAllChildBindings({
    parentRunId: PARENT_RUN,
    parentIssueNumber: PARENT_ISSUE,
    request: parentRequest,
    relayPlan: parentPlan
  }).map((row, index) => ({ ...row, child_issue_number: 301 + index }));

  const claims = bindings.map((binding, index) => validateAllContextClaim({
    schema: 'kneekura.code-lab.github-relay-all-context-claim/v1',
    parent_run_id: PARENT_RUN,
    parent_issue_number: PARENT_ISSUE,
    child_issue_number: binding.child_issue_number,
    engine_id: binding.engine_id,
    host_context_id: `chatgpt-context-${index + 1}`,
    assurance_class: ASSURANCE
  }, binding));

  assert.equal(assertDistinctAllContextClaims(claims), true);
  assert.throws(
    () => assertDistinctAllContextClaims([
      claims[0],
      { ...claims[1], host_context_id: claims[0].host_context_id },
      claims[2]
    ]),
    error => error?.code === 'BLOCKED_SEMANTIC_CONTEXT_ISOLATION'
  );
});

test('child result manifest must preserve parent target runtime lock and child slot identity', () => {
  const [slot] = createAllChildBindings({
    parentRunId: PARENT_RUN,
    parentIssueNumber: PARENT_ISSUE,
    request: parentRequest,
    relayPlan: parentPlan
  });
  const binding = { ...slot, child_issue_number: 301 };
  const manifest = {
    schema: 'kneekura.code-lab.github-relay-all-child-result-manifest/v1',
    parent_run_id: PARENT_RUN,
    parent_issue_number: PARENT_ISSUE,
    child_run_id: `ghr-301-${REVISION.slice(0, 12)}-${SCOPE.slice(7, 19)}`,
    child_issue_number: 301,
    engine_id: 'kneekura',
    child_request_digest: binding.child_request_digest,
    target: { ...parentPlan.target },
    scope_digest: SCOPE,
    code_lab_revision: RUNTIME,
    engine_lock_digest: LOCK,
    host_context_id: 'chatgpt-context-kneekura-001',
    assurance_class: ASSURANCE,
    result_zip: { digest: `sha256:${'f'.repeat(64)}`, bytes: 1234 },
    receipt_digest: `sha256:${'1'.repeat(64)}`
  };

  const accepted = validateAllChildResultManifest(manifest, binding, parentPlan);
  assert.equal(accepted.engine_id, 'kneekura');
  assert.equal(accepted.child_run_id, manifest.child_run_id);

  assert.throws(
    () => validateAllChildResultManifest({ ...manifest, code_lab_revision: '9'.repeat(40) }, binding, parentPlan),
    error => error?.code === 'ALL_CHILD_RESULT_BINDING_MISMATCH'
  );
  assert.throws(
    () => validateAllChildResultManifest({ ...manifest, scope_digest: `sha256:${'8'.repeat(64)}` }, binding, parentPlan),
    error => error?.code === 'ALL_CHILD_RESULT_BINDING_MISMATCH'
  );
});