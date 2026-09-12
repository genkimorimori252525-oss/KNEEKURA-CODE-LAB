import crypto from 'node:crypto';

import {
  stableRelayJson,
  validateRelayPlan,
  validateRelayRequest
} from './contracts.mjs';

export const ALL_PARENT_SCHEMA = 'kneekura.code-lab.github-relay-all-parent/v1';
export const ALL_CHILD_BINDING_SCHEMA = 'kneekura.code-lab.github-relay-all-child-binding/v1';
export const ALL_CONTEXT_CLAIM_SCHEMA = 'kneekura.code-lab.github-relay-all-context-claim/v1';
export const ALL_CHILD_RESULT_MANIFEST_SCHEMA = 'kneekura.code-lab.github-relay-all-child-result-manifest/v1';
export const ALL_CONTEXT_ASSURANCE_CLASS = 'OPERATOR_SEPARATED_HOST_SESSION_V1';

const ALL_ENGINES = Object.freeze([
  'kneekura',
  'understand-anything',
  'archify'
]);
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;
const EXACT_REVISION = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;

export function createAllChildBindings({
  parentRunId,
  parentIssueNumber,
  request,
  relayPlan
} = {}) {
  const normalizedRequest = validateRelayRequest(request);
  const normalizedPlan = validateRelayPlan(relayPlan);
  const runId = requireText(parentRunId, 'parentRunId', 128);
  const issueNumber = positiveInteger(parentIssueNumber, 'parentIssueNumber');

  if (normalizedRequest.selection !== 'all' || normalizedPlan.selection !== 'all') {
    throw codedError('ALL_MODE_ENGINE_SET_INVALID', 'ALL child bindings require an all-mode request and plan');
  }
  if (normalizedRequest.semanticContextMode !== 'per-engine' || normalizedPlan.semantic_context_mode !== 'per-engine') {
    throw codedError('BLOCKED_SEMANTIC_CONTEXT_ISOLATION', 'ALL child bindings require per-engine semantic context isolation');
  }
  if (runId !== normalizedPlan.run_id) {
    throw codedError('ALL_PARENT_BINDING_MISMATCH', 'parentRunId does not match the Relay plan');
  }
  if (
    normalizedRequest.target.repository !== normalizedPlan.target.repository ||
    normalizedRequest.target.revision !== normalizedPlan.target.revision
  ) {
    throw codedError('ALL_PARENT_BINDING_MISMATCH', 'Relay request target does not match the parent plan target');
  }

  return deepFreeze(ALL_ENGINES.map((engineId, index) => {
    const binding = {
      schema: ALL_CHILD_BINDING_SCHEMA,
      parent_run_id: runId,
      parent_issue_number: issueNumber,
      child_slot: index + 1,
      engine_id: engineId,
      target: structuredClone(normalizedPlan.target),
      scope_digest: normalizedPlan.target.scope_digest,
      code_lab_revision: normalizedPlan.code_lab_revision,
      engine_lock_digest: normalizedPlan.engine_lock_digest,
      child_request_digest: null
    };
    binding.child_request_digest = allChildRequestDigest({
      ...binding,
      common_scope: normalizedRequest.commonScope,
      engine_options: engineScopedValue(normalizedRequest.engineOptions, engineId, {}),
      minimum_claim_level: engineScopedValue(normalizedRequest.minimumClaimLevel, engineId, null)
    });
    return binding;
  }));
}

export function allChildRequestDigest(binding) {
  const input = cloneRecord(binding, 'ALL child binding');
  const engineId = normalizeEngineId(input.engine_id);
  const payload = {
    schema: 'kneekura.code-lab.github-relay-all-child-request-digest/v1',
    parent_run_id: requireText(input.parent_run_id, 'parent_run_id', 128),
    parent_issue_number: positiveInteger(input.parent_issue_number, 'parent_issue_number'),
    child_slot: positiveInteger(input.child_slot, 'child_slot'),
    engine_id: engineId,
    target: normalizeTarget(input.target),
    scope_digest: normalizeDigest(input.scope_digest, 'scope_digest'),
    code_lab_revision: normalizeRevision(input.code_lab_revision, 'code_lab_revision'),
    engine_lock_digest: normalizeDigest(input.engine_lock_digest, 'engine_lock_digest'),
    common_scope: cloneJson(input.common_scope ?? {}),
    engine_options: cloneJson(input.engine_options ?? {}),
    minimum_claim_level: input.minimum_claim_level == null ? null : cloneJson(input.minimum_claim_level)
  };
  return `sha256:${crypto.createHash('sha256')
    .update('kneekura.github-relay.all-child-request/v1\0')
    .update(stableRelayJson(payload))
    .digest('hex')}`;
}

export function validateAllContextClaim(value, binding) {
  const claim = cloneRecord(value, 'ALL context claim');
  const expected = normalizeBoundChildBinding(binding);
  if (claim.schema !== ALL_CONTEXT_CLAIM_SCHEMA) {
    throw new TypeError(`ALL context claim schema must be ${ALL_CONTEXT_CLAIM_SCHEMA}`);
  }

  const normalized = {
    schema: ALL_CONTEXT_CLAIM_SCHEMA,
    parent_run_id: requireText(claim.parent_run_id, 'parent_run_id', 128),
    parent_issue_number: positiveInteger(claim.parent_issue_number, 'parent_issue_number'),
    child_issue_number: positiveInteger(claim.child_issue_number, 'child_issue_number'),
    engine_id: normalizeEngineId(claim.engine_id),
    host_context_id: requireContextId(claim.host_context_id),
    assurance_class: String(claim.assurance_class ?? '')
  };

  if (normalized.assurance_class !== ALL_CONTEXT_ASSURANCE_CLASS) {
    throw isolationError('ALL child context claim does not provide the required assurance class');
  }
  const exact = [
    ['parent_run_id', expected.parent_run_id],
    ['parent_issue_number', expected.parent_issue_number],
    ['child_issue_number', expected.child_issue_number],
    ['engine_id', expected.engine_id]
  ];
  for (const [key, expectedValue] of exact) {
    if (normalized[key] !== expectedValue) {
      throw isolationError(`ALL child context claim ${key} does not match its immutable child binding`);
    }
  }
  return deepFreeze(normalized);
}

export function assertDistinctAllContextClaims(claims) {
  if (!Array.isArray(claims)) throw new TypeError('ALL context claims must be an array');
  const contexts = new Set();
  const engines = new Set();
  const issues = new Set();
  for (const raw of claims) {
    const claim = cloneRecord(raw, 'ALL context claim');
    if (claim.schema !== ALL_CONTEXT_CLAIM_SCHEMA) throw new TypeError('invalid ALL context claim schema');
    const contextId = requireContextId(claim.host_context_id);
    const engineId = normalizeEngineId(claim.engine_id);
    const issueNumber = positiveInteger(claim.child_issue_number, 'child_issue_number');
    if (contexts.has(contextId)) throw isolationError('two ALL children claim the same host semantic context');
    if (engines.has(engineId)) throw isolationError('multiple context claims target the same ALL engine slot');
    if (issues.has(issueNumber)) throw isolationError('multiple ALL context claims target the same child Issue');
    contexts.add(contextId);
    engines.add(engineId);
    issues.add(issueNumber);
  }
  return true;
}

export function validateAllChildResultManifest(value, binding, parentPlan) {
  const manifest = cloneRecord(value, 'ALL child result manifest');
  const expected = normalizeBoundChildBinding(binding);
  const plan = validateRelayPlan(parentPlan);
  if (plan.selection !== 'all') throw codedError('ALL_MODE_ENGINE_SET_INVALID', 'child result manifest requires an all-mode parent plan');
  if (manifest.schema !== ALL_CHILD_RESULT_MANIFEST_SCHEMA) {
    throw new TypeError(`ALL child result manifest schema must be ${ALL_CHILD_RESULT_MANIFEST_SCHEMA}`);
  }

  const normalized = {
    schema: ALL_CHILD_RESULT_MANIFEST_SCHEMA,
    parent_run_id: requireText(manifest.parent_run_id, 'parent_run_id', 128),
    parent_issue_number: positiveInteger(manifest.parent_issue_number, 'parent_issue_number'),
    child_run_id: normalizeRunId(manifest.child_run_id),
    child_issue_number: positiveInteger(manifest.child_issue_number, 'child_issue_number'),
    engine_id: normalizeEngineId(manifest.engine_id),
    child_request_digest: normalizeDigest(manifest.child_request_digest, 'child_request_digest'),
    target: normalizeTarget(manifest.target),
    scope_digest: normalizeDigest(manifest.scope_digest, 'scope_digest'),
    code_lab_revision: normalizeRevision(manifest.code_lab_revision, 'code_lab_revision'),
    engine_lock_digest: normalizeDigest(manifest.engine_lock_digest, 'engine_lock_digest'),
    host_context_id: requireContextId(manifest.host_context_id),
    assurance_class: String(manifest.assurance_class ?? ''),
    result_zip: normalizeArtifact(manifest.result_zip, 'result_zip'),
    receipt_digest: normalizeDigest(manifest.receipt_digest, 'receipt_digest')
  };

  if (normalized.assurance_class !== ALL_CONTEXT_ASSURANCE_CLASS) {
    throw codedError('ALL_CHILD_RESULT_BINDING_MISMATCH', 'child result assurance class is not accepted');
  }

  const exact = [
    ['parent_run_id', expected.parent_run_id],
    ['parent_issue_number', expected.parent_issue_number],
    ['child_issue_number', expected.child_issue_number],
    ['engine_id', expected.engine_id],
    ['child_request_digest', expected.child_request_digest],
    ['scope_digest', expected.scope_digest],
    ['code_lab_revision', expected.code_lab_revision],
    ['engine_lock_digest', expected.engine_lock_digest]
  ];
  for (const [key, expectedValue] of exact) {
    if (normalized[key] !== expectedValue) {
      throw codedError('ALL_CHILD_RESULT_BINDING_MISMATCH', `child result ${key} does not match its immutable binding`);
    }
  }
  if (stableRelayJson(normalized.target) !== stableRelayJson(expected.target)) {
    throw codedError('ALL_CHILD_RESULT_BINDING_MISMATCH', 'child result target does not match its immutable binding');
  }
  if (
    normalized.parent_run_id !== plan.run_id ||
    normalized.scope_digest !== plan.target.scope_digest ||
    normalized.code_lab_revision !== plan.code_lab_revision ||
    normalized.engine_lock_digest !== plan.engine_lock_digest ||
    stableRelayJson(normalized.target) !== stableRelayJson(plan.target)
  ) {
    throw codedError('ALL_CHILD_RESULT_BINDING_MISMATCH', 'child result does not match the parent ALL plan');
  }

  return deepFreeze(normalized);
}

function normalizeBoundChildBinding(value) {
  const binding = cloneRecord(value, 'ALL child binding');
  if (binding.schema !== ALL_CHILD_BINDING_SCHEMA) throw new TypeError('invalid ALL child binding schema');
  return {
    schema: ALL_CHILD_BINDING_SCHEMA,
    parent_run_id: requireText(binding.parent_run_id, 'parent_run_id', 128),
    parent_issue_number: positiveInteger(binding.parent_issue_number, 'parent_issue_number'),
    child_issue_number: positiveInteger(binding.child_issue_number, 'child_issue_number'),
    child_slot: positiveInteger(binding.child_slot, 'child_slot'),
    engine_id: normalizeEngineId(binding.engine_id),
    target: normalizeTarget(binding.target),
    scope_digest: normalizeDigest(binding.scope_digest, 'scope_digest'),
    code_lab_revision: normalizeRevision(binding.code_lab_revision, 'code_lab_revision'),
    engine_lock_digest: normalizeDigest(binding.engine_lock_digest, 'engine_lock_digest'),
    child_request_digest: normalizeDigest(binding.child_request_digest, 'child_request_digest')
  };
}

function normalizeTarget(value) {
  const target = cloneRecord(value, 'target');
  const repository = requireText(target.repository, 'target.repository', 500);
  const revision = normalizeRevision(target.revision, 'target.revision');
  const snapshotId = String(target.snapshot_id ?? '').trim().toLowerCase();
  if (!/^snapshot:sha256:[0-9a-f]{64}$/.test(snapshotId)) throw new TypeError('target.snapshot_id is invalid');
  return {
    repository,
    revision,
    snapshot_id: snapshotId,
    scope_digest: normalizeDigest(target.scope_digest, 'target.scope_digest')
  };
}

function normalizeArtifact(value, label) {
  const artifact = cloneRecord(value, label);
  const bytes = Number(artifact.bytes);
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new TypeError(`${label}.bytes must be a non-negative safe integer`);
  return {
    digest: normalizeDigest(artifact.digest, `${label}.digest`),
    bytes
  };
}

function engineScopedValue(map, engineId, fallback) {
  if (!map || typeof map !== 'object' || Array.isArray(map)) return fallback;
  const value = map[engineId];
  return value == null ? fallback : structuredClone(value);
}

function normalizeEngineId(value) {
  const engineId = String(value ?? '');
  if (!ALL_ENGINES.includes(engineId)) throw new TypeError(`unsupported ALL engine: ${engineId}`);
  return engineId;
}

function normalizeRunId(value) {
  const runId = String(value ?? '').trim();
  if (!SAFE_RUN_ID.test(runId)) throw new TypeError('child_run_id is invalid');
  return runId;
}

function normalizeDigest(value, label) {
  const digest = String(value ?? '').trim().toLowerCase();
  if (!SHA256_DIGEST.test(digest)) throw new TypeError(`${label} must be sha256:<64 hex>`);
  return digest;
}

function normalizeRevision(value, label) {
  const revision = String(value ?? '').trim().toLowerCase();
  if (!EXACT_REVISION.test(revision)) throw new TypeError(`${label} must be an exact Git revision`);
  return revision;
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new TypeError(`${label} must be a positive safe integer`);
  return number;
}

function requireContextId(value) {
  const text = requireText(value, 'host_context_id', 512);
  if (CONTROL_CHARACTERS.test(text)) throw new TypeError('host_context_id contains forbidden control characters');
  return text;
}

function requireText(value, label, maxBytes) {
  const text = String(value ?? '').trim();
  if (!text) throw new TypeError(`${label} must be a non-empty string`);
  if (CONTROL_CHARACTERS.test(text)) throw new TypeError(`${label} contains forbidden control characters`);
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new TypeError(`${label} exceeds ${maxBytes} bytes`);
  return text;
}

function cloneRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Buffer.isBuffer(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return structuredClone(value);
}

function cloneJson(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (error) {
    throw new TypeError(`value must be JSON serializable: ${error.message}`);
  }
}

function isolationError(message) {
  return codedError('BLOCKED_SEMANTIC_CONTEXT_ISOLATION', message);
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}