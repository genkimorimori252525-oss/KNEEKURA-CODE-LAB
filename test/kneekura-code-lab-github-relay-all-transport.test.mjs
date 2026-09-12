import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ALL_CHILD_BINDING_SCHEMA,
  ALL_CONTEXT_ASSURANCE_CLASS,
  ALL_CONTEXT_CLAIM_SCHEMA,
  GITHUB_RELAY_MARKERS,
  GITHUB_RELAY_SCHEMAS,
  parseRelayThreadComments,
  recognizedRelayClientMarker,
  renderRelayComment
} from '../src/github-relay/index.mjs';

const OWNER = 'genkimorimori252525-oss';

const CONTEXT_CLAIM = Object.freeze({
  schema: ALL_CONTEXT_CLAIM_SCHEMA,
  parent_run_id: 'ghr-parent',
  parent_issue_number: 220,
  child_issue_number: 301,
  engine_id: 'kneekura',
  host_context_id: 'host-session-kneekura-1',
  assurance_class: ALL_CONTEXT_ASSURANCE_CLASS
});

const CHILD_BINDING = Object.freeze({
  schema: ALL_CHILD_BINDING_SCHEMA,
  parent_run_id: 'ghr-parent',
  parent_issue_number: 220,
  child_issue_number: 301,
  child_slot: 1,
  engine_id: 'kneekura',
  target: {
    repository: `${OWNER}/KNEEKURA-LAB`,
    revision: 'a'.repeat(40),
    snapshot_id: `snapshot:sha256:${'b'.repeat(64)}`,
    scope_digest: `sha256:${'c'.repeat(64)}`
  },
  scope_digest: `sha256:${'c'.repeat(64)}`,
  code_lab_revision: 'd'.repeat(40),
  engine_lock_digest: `sha256:${'e'.repeat(64)}`,
  child_request_digest: `sha256:${'f'.repeat(64)}`
});

const SEMANTIC_RESPONSE = Object.freeze({
  schema: GITHUB_RELAY_SCHEMAS.response,
  run_id: 'ghr-child',
  task_id: `task:sha256:${'1'.repeat(64)}`,
  engine_id: 'kneekura',
  attempt_id: 'attempt-child',
  snapshot_id: `snapshot:sha256:${'b'.repeat(64)}`,
  scope_digest: `sha256:${'c'.repeat(64)}`,
  ordinal: 1,
  kind: 'kneekura:ARCHITECTURE',
  payload_digest: `sha256:${'2'.repeat(64)}`,
  response: { summary: 'semantic child response' }
});

test('ALL context claim is an authorized client marker but remains outside semantic response ledger', () => {
  assert.equal(GITHUB_RELAY_MARKERS.allContextClaim, 'KNEEKURA_RELAY_CONTEXT_CLAIM_V1');
  const body = renderRelayComment(GITHUB_RELAY_MARKERS.allContextClaim, CONTEXT_CLAIM);
  assert.equal(recognizedRelayClientMarker(body), GITHUB_RELAY_MARKERS.allContextClaim);

  const thread = parseRelayThreadComments([
    { id: 1, user: { login: OWNER }, body },
    {
      id: 2,
      user: { login: OWNER },
      body: renderRelayComment(GITHUB_RELAY_MARKERS.response, SEMANTIC_RESPONSE)
    }
  ], { allowedActors: [OWNER] });

  assert.equal(thread.contextClaims.length, 1);
  assert.equal(thread.contextClaims[0].envelope.host_context_id, CONTEXT_CLAIM.host_context_id);
  assert.equal(thread.responses.length, 1);
  assert.notEqual(thread.contextClaims[0].envelope.schema, thread.responses[0].envelope.schema);
});

test('ALL child binding is runner-authored control metadata and cannot enter semantic client ledgers', () => {
  assert.equal(GITHUB_RELAY_MARKERS.allChildBinding, 'KNEEKURA_RELAY_ALL_CHILD_BINDING_V1');
  const body = renderRelayComment(GITHUB_RELAY_MARKERS.allChildBinding, CHILD_BINDING);
  assert.equal(recognizedRelayClientMarker(body), null);

  const thread = parseRelayThreadComments([
    { id: 10, user: { login: 'github-actions[bot]' }, body },
    { id: 11, user: { login: OWNER }, body }
  ], { allowedActors: [OWNER] });

  assert.equal(thread.allChildBindings.length, 1);
  assert.equal(thread.allChildBindings[0].actor, 'github-actions[bot]');
  assert.equal(thread.allChildBindings[0].envelope.child_issue_number, 301);
  assert.equal(thread.responses.length, 0);
  assert.equal(thread.sourceRequests.length, 0);
});