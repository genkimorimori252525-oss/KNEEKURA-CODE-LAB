import crypto from 'node:crypto';

import { ENGINE_IDS } from './contracts.mjs';

export const UPSTREAM_UPDATE_DECISION_SCHEMA =
  'kneekura.code-lab.upstream-update-decision/v1';
export const UPSTREAM_REPIN_PROPOSAL_SCHEMA =
  'kneekura.code-lab.upstream-repin-proposal/v1';

const UPSTREAM_ENGINES = new Set(['understand-anything', 'archify']);

export function evaluateUpstreamUpdateCandidate({
  engineId,
  currentPin,
  candidate,
  identityReceipt,
  licenseReceipt,
  regressionReceipts
} = {}) {
  requireUpstreamEngine(engineId);
  requireRecord(currentPin, 'currentPin');
  requireRecord(candidate, 'candidate');
  requireRecord(identityReceipt, 'identityReceipt');
  requireRecord(licenseReceipt, 'licenseReceipt');
  if (!Array.isArray(regressionReceipts) || regressionReceipts.length === 0) {
    throw new TypeError('regressionReceipts must contain at least one receipt');
  }

  const checks = {
    candidate_commit_exact:
      /^[0-9a-f]{40}$/i.test(String(candidate.commit ?? '')),
    candidate_differs_from_current:
      String(candidate.commit ?? '').toLowerCase() !==
      String(currentPin.commit ?? '').toLowerCase(),
    identity_verified:
      identityReceipt.status === 'PASSED' &&
      identityReceipt.commit === candidate.commit &&
      identityReceipt.content_identity_verified === true,
    license_verified:
      licenseReceipt.status === 'PASSED' &&
      licenseReceipt.spdx === 'MIT' &&
      licenseReceipt.notices_preserved === true,
    regressions_passed:
      regressionReceipts.every(receipt =>
        receipt?.status === 'PASSED' &&
        receipt?.candidate_commit === candidate.commit &&
        typeof receipt?.fixture === 'string' &&
        receipt.fixture.length > 0
      )
  };
  const adoptable = Object.values(checks).every(Boolean);
  const candidateDigest = stableDigest({
    engine_id: engineId,
    candidate,
    identity: identityReceipt,
    license: licenseReceipt,
    regressions: regressionReceipts
  });

  return deepFreeze({
    schema: UPSTREAM_UPDATE_DECISION_SCHEMA,
    engine_id: engineId,
    current_commit: currentPin.commit,
    candidate: structuredClone(candidate),
    candidate_digest: candidateDigest,
    checks,
    adoptable,
    production_pin_mutated: false,
    requires_explicit_adoption: true
  });
}

export function createUpstreamRepinProposal({
  decision,
  explicitApproval
} = {}) {
  requireRecord(decision, 'decision');
  if (decision.schema !== UPSTREAM_UPDATE_DECISION_SCHEMA) {
    throw new TypeError('decision is not an upstream update decision');
  }
  if (decision.adoptable !== true) {
    throw codedError(
      'UPSTREAM_CANDIDATE_NOT_ADOPTABLE',
      'candidate cannot be proposed for repin until every gate passes'
    );
  }
  requireRecord(explicitApproval, 'explicitApproval');
  if (
    explicitApproval.approved !== true ||
    explicitApproval.candidate_digest !== decision.candidate_digest
  ) {
    throw codedError(
      'UPSTREAM_ADOPTION_APPROVAL_REQUIRED',
      'explicit adoption approval must bind to the exact candidate digest'
    );
  }

  return deepFreeze({
    schema: UPSTREAM_REPIN_PROPOSAL_SCHEMA,
    engine_id: decision.engine_id,
    candidate_digest: decision.candidate_digest,
    proposed_pin: structuredClone(decision.candidate),
    production_pin_mutated: false,
    maintainer_commit_required: true
  });
}

export function assertCandidateCannotSelfAdopt(value) {
  if (value?.production_pin_mutated === true) {
    throw codedError(
      'UPSTREAM_SELF_ADOPTION_FORBIDDEN',
      'candidate evaluation may never mutate a production pin'
    );
  }
  return true;
}

function requireUpstreamEngine(engineId) {
  if (!ENGINE_IDS.includes(engineId) || !UPSTREAM_ENGINES.has(engineId)) {
    throw new TypeError(`engine is not a pinned upstream engine: ${engineId}`);
  }
}

function stableDigest(value) {
  const text = JSON.stringify(sortObject(value));
  return `sha256:${crypto.createHash('sha256').update(text).digest('hex')}`;
}

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort(compareText)
        .map(key => [key, sortObject(value[key])])
    );
  }
  return value;
}

function compareText(a, b) {
  const left = String(a);
  const right = String(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

function requireRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}