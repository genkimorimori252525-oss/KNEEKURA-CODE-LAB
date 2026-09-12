import crypto from 'node:crypto';

import { validateEngineRunReceipt } from '../skill/contracts.mjs';
import {
  ALL_CHILD_RESULT_MANIFEST_SCHEMA,
  validateAllChildResultManifest,
  validateAllContextClaim
} from './all-mode-contracts.mjs';
import { GITHUB_RELAY_SCHEMAS, stableRelayJson } from './contracts.mjs';
import { createRelayRunId } from './orchestrator.mjs';

const ZIP_KIND_BY_ENGINE = Object.freeze({
  kneekura: 'KNEEKURA_HUMAN_EXPLORER_ZIP',
  'understand-anything': 'UA_SKILL_ZIP',
  archify: 'ARCHIFY_SKILL_ZIP'
});

export function createChildResultManifest({
  binding,
  contextClaim,
  relayResult,
  receipt,
  sealedBytes
} = {}) {
  const bytes = requireBuffer(sealedBytes, 'sealedBytes');
  const claim = validateAllContextClaim(contextClaim, binding);
  const normalizedReceipt = validateBoundReceipt(receipt, binding, bytes);
  const result = validateBoundRelayResult(relayResult, binding, normalizedReceipt.status);
  const receiptDigest = digestJson(normalizedReceipt);
  const zipDigest = digestBytes(bytes);

  return validateAllChildResultManifest({
    schema: ALL_CHILD_RESULT_MANIFEST_SCHEMA,
    parent_run_id: binding.parent_run_id,
    parent_issue_number: binding.parent_issue_number,
    child_run_id: result.run_id,
    child_issue_number: binding.child_issue_number,
    engine_id: binding.engine_id,
    child_request_digest: binding.child_request_digest,
    target: structuredClone(binding.target),
    scope_digest: binding.scope_digest,
    code_lab_revision: binding.code_lab_revision,
    engine_lock_digest: binding.engine_lock_digest,
    host_context_id: claim.host_context_id,
    assurance_class: claim.assurance_class,
    result_zip: { digest: zipDigest, bytes: bytes.length },
    receipt_digest: receiptDigest
  }, binding, parentPlanFromBinding(binding));
}

export function verifyChildCompositionInput({
  manifest,
  receipt,
  sealedBytes,
  expectedBinding,
  parentPlan,
  expectedContextClaim = null
} = {}) {
  const bytes = requireBuffer(sealedBytes, 'sealedBytes');
  const acceptedManifest = validateAllChildResultManifest(manifest, expectedBinding, parentPlan);
  const expectedRunId = createRelayRunId(
    expectedBinding.child_issue_number,
    expectedBinding.target.revision,
    expectedBinding.scope_digest
  );
  if (acceptedManifest.child_run_id !== expectedRunId) {
    throw bindingError('child result run ID does not match its immutable Issue/revision/scope binding');
  }

  if (expectedContextClaim != null) {
    const claim = validateAllContextClaim(expectedContextClaim, expectedBinding);
    if (
      acceptedManifest.host_context_id !== claim.host_context_id ||
      acceptedManifest.assurance_class !== claim.assurance_class
    ) {
      throw bindingError('child result context claim does not match the accepted host context');
    }
  }

  const normalizedReceipt = validateBoundReceipt(receipt, expectedBinding, bytes);
  if (acceptedManifest.receipt_digest !== digestJson(normalizedReceipt)) {
    throw integrityError('child receipt digest does not match the supplied receipt');
  }
  const zipDigest = digestBytes(bytes);
  if (
    acceptedManifest.result_zip.digest !== zipDigest ||
    acceptedManifest.result_zip.bytes !== bytes.length
  ) {
    throw integrityError('child result ZIP identity does not match the supplied sealed bytes');
  }

  return deepFreeze({
    manifest: structuredClone(acceptedManifest),
    receipt: structuredClone(normalizedReceipt),
    sealed_bytes: Buffer.from(bytes),
    sealed_artifact: {
      digest: zipDigest,
      bytes: bytes.length
    }
  });
}

function validateBoundRelayResult(value, binding, receiptStatus) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw bindingError('child Relay result is required');
  }
  if (value.schema !== GITHUB_RELAY_SCHEMAS.result) {
    throw bindingError('child Relay result schema is invalid');
  }
  const expectedRunId = createRelayRunId(
    binding.child_issue_number,
    binding.target.revision,
    binding.scope_digest
  );
  if (String(value.run_id ?? '') !== expectedRunId) {
    throw bindingError('child Relay result run ID does not match the immutable child binding');
  }
  if (String(value.status ?? '') !== receiptStatus) {
    throw bindingError('child Relay result status does not match the engine receipt');
  }
  if (stableRelayJson(value.target) !== stableRelayJson(binding.target)) {
    throw bindingError('child Relay result target does not match the immutable child binding');
  }
  if (String(value.code_lab_revision ?? '').toLowerCase() !== String(binding.code_lab_revision ?? '').toLowerCase()) {
    throw bindingError('child Relay result runtime does not match the immutable child binding');
  }
  if (String(value.engine_lock_digest ?? '').toLowerCase() !== String(binding.engine_lock_digest ?? '').toLowerCase()) {
    throw bindingError('child Relay result engine lock does not match the immutable child binding');
  }
  return value;
}

function validateBoundReceipt(receipt, binding, sealedBytes) {
  try {
    validateEngineRunReceipt(receipt);
  } catch (error) {
    throw integrityError(`child engine receipt is invalid: ${error.message}`);
  }
  if (receipt.engineId !== binding.engine_id) {
    throw bindingError('child receipt engine does not match the immutable engine slot');
  }
  if (receipt.snapshotId !== binding.target.snapshot_id) {
    throw bindingError('child receipt snapshot does not match the parent snapshot');
  }
  if (receipt.scopeDigest !== binding.scope_digest) {
    throw bindingError('child receipt scope does not match the parent scope');
  }
  if (!['SUCCESS', 'PARTIAL'].includes(receipt.status)) {
    throw bindingError('only successful or partial sealed child results may be composed');
  }
  const expectedKind = ZIP_KIND_BY_ENGINE[binding.engine_id];
  const artifact = receipt.artifacts.find(row => row?.kind === expectedKind);
  const zipDigest = digestBytes(sealedBytes);
  if (
    !artifact ||
    String(artifact.digest ?? '').toLowerCase() !== zipDigest ||
    Number(artifact.bytes) !== sealedBytes.length
  ) {
    throw integrityError('child receipt does not bind the exact sealed result ZIP');
  }
  return receipt;
}

function parentPlanFromBinding(binding) {
  return {
    schema: GITHUB_RELAY_SCHEMAS.plan,
    run_id: binding.parent_run_id,
    selection: 'all',
    target: structuredClone(binding.target),
    semantic_context_mode: 'per-engine',
    code_lab_revision: binding.code_lab_revision,
    engine_lock_digest: binding.engine_lock_digest
  };
}

function digestJson(value) {
  return digestBytes(Buffer.from(stableRelayJson(value), 'utf8'));
}

function digestBytes(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function requireBuffer(value, label) {
  if (!Buffer.isBuffer(value)) throw new TypeError(`${label} must be a Buffer`);
  return value;
}

function bindingError(message) {
  const error = new Error(message);
  error.code = 'ALL_CHILD_RESULT_BINDING_MISMATCH';
  return error;
}

function integrityError(message) {
  const error = new Error(message);
  error.code = 'ALL_CHILD_ARTIFACT_INTEGRITY_MISMATCH';
  return error;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Buffer.isBuffer(value) || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}