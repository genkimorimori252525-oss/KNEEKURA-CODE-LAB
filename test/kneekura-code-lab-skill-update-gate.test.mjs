import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

import {
  assertCandidateCannotSelfAdopt,
  createUpstreamRepinProposal,
  evaluateUpstreamUpdateCandidate
} from '../src/skill/index.mjs';
import { readEngineLock } from '../src/skill/engine-lock.mjs';

function candidate(commit = 'a'.repeat(40)) {
  return {
    release: 'v9.9.9',
    version: '9.9.9',
    commit,
    artifact: { algorithm: 'sha256', value: 'b'.repeat(64) }
  };
}

function passedInputs(commit = 'a'.repeat(40)) {
  return {
    candidate: candidate(commit),
    identityReceipt: {
      status: 'PASSED',
      commit,
      content_identity_verified: true
    },
    licenseReceipt: {
      status: 'PASSED',
      spdx: 'MIT',
      notices_preserved: true
    },
    regressionReceipts: [
      { status: 'PASSED', candidate_commit: commit, fixture: 'tiny-js' },
      { status: 'PASSED', candidate_commit: commit, fixture: 'kneekura-snapshot' }
    ]
  };
}

test('candidate evaluation is quarantined and cannot mutate production engine-lock bytes', async () => {
  const before = await fs.readFile(new URL('../engine-lock.json', import.meta.url));
  const lock = await readEngineLock();
  const inputs = passedInputs();
  const decision = evaluateUpstreamUpdateCandidate({
    engineId: 'understand-anything',
    currentPin: lock.engines['understand-anything'],
    ...inputs
  });
  assert.equal(decision.adoptable, true);
  assert.equal(decision.production_pin_mutated, false);
  assert.equal(assertCandidateCannotSelfAdopt(decision), true);
  const after = await fs.readFile(new URL('../engine-lock.json', import.meta.url));
  assert.deepEqual(after, before);
});

test('failed identity, license, or regression evidence blocks adoption', async () => {
  const lock = await readEngineLock();
  for (const broken of ['identity', 'license', 'regression']) {
    const inputs = passedInputs();
    if (broken === 'identity') inputs.identityReceipt.content_identity_verified = false;
    if (broken === 'license') inputs.licenseReceipt.notices_preserved = false;
    if (broken === 'regression') inputs.regressionReceipts[1].status = 'FAILED';
    const decision = evaluateUpstreamUpdateCandidate({
      engineId: 'archify',
      currentPin: lock.engines.archify,
      ...inputs
    });
    assert.equal(decision.adoptable, false, broken);
    assert.throws(
      () => createUpstreamRepinProposal({
        decision,
        explicitApproval: { approved: true, candidate_digest: decision.candidate_digest }
      }),
      error => error?.code === 'UPSTREAM_CANDIDATE_NOT_ADOPTABLE'
    );
  }
});

test('adoptable candidate still requires explicit digest-bound adoption approval', async () => {
  const lock = await readEngineLock();
  const decision = evaluateUpstreamUpdateCandidate({
    engineId: 'archify',
    currentPin: lock.engines.archify,
    ...passedInputs('c'.repeat(40))
  });
  assert.equal(decision.adoptable, true);
  assert.throws(
    () => createUpstreamRepinProposal({ decision, explicitApproval: { approved: false, candidate_digest: decision.candidate_digest } }),
    error => error?.code === 'UPSTREAM_ADOPTION_APPROVAL_REQUIRED'
  );
  assert.throws(
    () => createUpstreamRepinProposal({ decision, explicitApproval: { approved: true, candidate_digest: 'sha256:' + '0'.repeat(64) } }),
    error => error?.code === 'UPSTREAM_ADOPTION_APPROVAL_REQUIRED'
  );
  const proposal = createUpstreamRepinProposal({
    decision,
    explicitApproval: { approved: true, candidate_digest: decision.candidate_digest }
  });
  assert.equal(proposal.production_pin_mutated, false);
  assert.equal(proposal.maintainer_commit_required, true);
  assert.deepEqual(proposal.proposed_pin, decision.candidate);
});