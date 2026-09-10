import crypto from 'node:crypto';

import { ENGINE_IDS } from '../../src/skill/contracts.mjs';

export const HOST_TASK_SCHEMA = 'kneekura.code-lab.host-task/v1';
export const HOST_RESPONSE_SCHEMA = 'kneekura.code-lab.host-response/v1';
export const HOST_BRIDGE_STATE_SCHEMA = 'kneekura.code-lab.host-bridge-state/v1';

export const HOST_TASK_KINDS = Object.freeze([
  'kneekura:ARCHITECTURE',
  'kneekura:DOMAIN',
  'kneekura:FLOW',
  'kneekura:TOUR',
  'kneekura:REVIEWER',
  'ua:project-scanner',
  'ua:file-analyzer',
  'ua:assemble-reviewer',
  'ua:architecture-analyzer',
  'ua:tour-builder',
  'archify:typed-ir'
]);

export const DEFAULT_HOST_BRIDGE_LIMITS = Object.freeze({
  maxTasksPerRun: 512,
  maxTaskPayloadBytes: 1024 * 1024,
  maxResponseBytes: 1024 * 1024,
  maxStoredResponseBytes: 16 * 1024 * 1024,
  maxSourceReadBytes: 128 * 1024,
  maxSourceReadLines: 400,
  maxSourceReadBytesPerTask: 4 * 1024 * 1024
});

const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_ATTEMPT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SNAPSHOT_ID = /^snapshot:sha256:[0-9a-f]{64}$/;
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;

export class HostTaskRequiredError extends Error {
  constructor(task) {
    super(`host semantic response required for ${task.engine_id} task ${task.ordinal}`);
    this.name = 'HostTaskRequiredError';
    this.code = 'HOST_TASK_REQUIRED';
    this.task = task;
  }
}

export function createHostTask({
  runId,
  engineId,
  attemptId,
  snapshotId,
  scopeDigest,
  ordinal,
  kind,
  payload,
  limits = DEFAULT_HOST_BRIDGE_LIMITS
} = {}) {
  const binding = normalizeBinding({ runId, engineId, attemptId, snapshotId, scopeDigest });
  const normalizedOrdinal = normalizeOrdinal(ordinal, limits.maxTasksPerRun);
  const normalizedKind = normalizeTaskKind(kind, engineId);
  const normalizedPayload = cloneJson(payload, 'host task payload');
  const payloadBytes = jsonBytes(normalizedPayload, 'host task payload');
  if (payloadBytes > limits.maxTaskPayloadBytes) {
    throw codedError('HOST_TASK_PAYLOAD_TOO_LARGE', `host task payload exceeds ${limits.maxTaskPayloadBytes} bytes`);
  }
  const payloadDigest = digest(normalizedPayload);
  const taskId = digest({
    schema: HOST_TASK_SCHEMA,
    ...binding,
    ordinal: normalizedOrdinal,
    kind: normalizedKind,
    payload_digest: payloadDigest
  }).replace(/^sha256:/, 'task:sha256:');

  return deepFreeze({
    schema: HOST_TASK_SCHEMA,
    task_id: taskId,
    ...binding,
    ordinal: normalizedOrdinal,
    kind: normalizedKind,
    payload_digest: payloadDigest,
    payload_bytes: payloadBytes,
    payload: normalizedPayload,
    trust: {
      repository_content_instruction_authority: false,
      host_response_authority: 'SEMANTIC_ONLY',
      host_response_can_mutate_canonical_evidence: false,
      engine_consensus_can_promote_canonical_truth: false
    },
    limits: {
      max_response_bytes: limits.maxResponseBytes,
      max_source_read_bytes: limits.maxSourceReadBytes,
      max_source_read_lines: limits.maxSourceReadLines,
      max_source_read_bytes_per_task: limits.maxSourceReadBytesPerTask
    }
  });
}

export function createHostResponseRecord({ task, response, limits = DEFAULT_HOST_BRIDGE_LIMITS } = {}) {
  validateHostTask(task);
  const normalizedResponse = cloneJson(response, 'host response');
  const responseBytes = jsonBytes(normalizedResponse, 'host response');
  if (responseBytes > limits.maxResponseBytes) {
    throw codedError('HOST_RESPONSE_TOO_LARGE', `host response exceeds ${limits.maxResponseBytes} bytes`);
  }
  const record = {
    schema: HOST_RESPONSE_SCHEMA,
    task_id: task.task_id,
    run_id: task.run_id,
    engine_id: task.engine_id,
    attempt_id: task.attempt_id,
    snapshot_id: task.snapshot_id,
    scope_digest: task.scope_digest,
    ordinal: task.ordinal,
    kind: task.kind,
    payload_digest: task.payload_digest,
    response_digest: digest(normalizedResponse),
    response_bytes: responseBytes,
    response: normalizedResponse
  };
  validateHostResponseForTask(task, record, limits);
  return deepFreeze(record);
}

export function validateHostTask(task) {
  requireRecord(task, 'host task');
  if (task.schema !== HOST_TASK_SCHEMA) throw new TypeError('invalid host task schema');
  const binding = normalizeBinding({
    runId: task.run_id,
    engineId: task.engine_id,
    attemptId: task.attempt_id,
    snapshotId: task.snapshot_id,
    scopeDigest: task.scope_digest
  });
  normalizeOrdinal(task.ordinal, DEFAULT_HOST_BRIDGE_LIMITS.maxTasksPerRun);
  normalizeTaskKind(task.kind, binding.engine_id);
  if (!/^task:sha256:[0-9a-f]{64}$/.test(String(task.task_id ?? ''))) throw new TypeError('invalid host task id');
  if (!SHA256_DIGEST.test(String(task.payload_digest ?? ''))) throw new TypeError('invalid host task payload digest');
  const actual = digest(cloneJson(task.payload, 'host task payload'));
  if (actual !== task.payload_digest) throw codedError('HOST_TASK_PAYLOAD_DIGEST_MISMATCH', 'host task payload digest mismatch');
  const expectedId = digest({
    schema: HOST_TASK_SCHEMA,
    ...binding,
    ordinal: task.ordinal,
    kind: task.kind,
    payload_digest: task.payload_digest
  }).replace(/^sha256:/, 'task:sha256:');
  if (expectedId !== task.task_id) throw codedError('HOST_TASK_ID_MISMATCH', 'host task identity does not match its exact binding');
  return true;
}

export function validateHostResponseForTask(task, record, limits = DEFAULT_HOST_BRIDGE_LIMITS) {
  validateHostTask(task);
  requireRecord(record, 'host response record');
  if (record.schema !== HOST_RESPONSE_SCHEMA) throw new TypeError('invalid host response schema');
  const exact = [
    ['task_id', task.task_id],
    ['run_id', task.run_id],
    ['engine_id', task.engine_id],
    ['attempt_id', task.attempt_id],
    ['snapshot_id', task.snapshot_id],
    ['scope_digest', task.scope_digest],
    ['ordinal', task.ordinal],
    ['kind', task.kind],
    ['payload_digest', task.payload_digest]
  ];
  for (const [key, expected] of exact) {
    if (record[key] !== expected) {
      throw codedError('HOST_RESPONSE_BINDING_MISMATCH', `host response ${key} does not match pending task`);
    }
  }
  const response = cloneJson(record.response, 'host response');
  const bytes = jsonBytes(response, 'host response');
  if (bytes > limits.maxResponseBytes) throw codedError('HOST_RESPONSE_TOO_LARGE', `host response exceeds ${limits.maxResponseBytes} bytes`);
  if (record.response_bytes !== bytes) throw codedError('HOST_RESPONSE_SIZE_MISMATCH', 'host response byte count mismatch');
  if (record.response_digest !== digest(response)) throw codedError('HOST_RESPONSE_DIGEST_MISMATCH', 'host response digest mismatch');
  return true;
}

export function hostResponseValue(task, record, limits = DEFAULT_HOST_BRIDGE_LIMITS) {
  validateHostResponseForTask(task, record, limits);
  return cloneJson(record.response, 'host response');
}

export function stableHostJson(value) {
  return JSON.stringify(sortValue(value));
}

function normalizeBinding({ runId, engineId, attemptId, snapshotId, scopeDigest }) {
  const run = String(runId ?? '').trim();
  if (!SAFE_RUN_ID.test(run)) throw new TypeError('host bridge runId is invalid');
  const engine = String(engineId ?? '');
  if (!ENGINE_IDS.includes(engine)) throw new TypeError('host bridge engineId is invalid');
  const attempt = String(attemptId ?? '').trim();
  if (!SAFE_ATTEMPT_ID.test(attempt)) throw new TypeError('host bridge attemptId is invalid');
  const snapshot = String(snapshotId ?? '').trim().toLowerCase();
  if (!SNAPSHOT_ID.test(snapshot)) throw new TypeError('host bridge snapshotId is invalid');
  const scope = String(scopeDigest ?? '').trim().toLowerCase();
  if (!SHA256_DIGEST.test(scope)) throw new TypeError('host bridge scopeDigest is invalid');
  return {
    run_id: run,
    engine_id: engine,
    attempt_id: attempt,
    snapshot_id: snapshot,
    scope_digest: scope
  };
}

function normalizeOrdinal(value, maxTasks) {
  const ordinal = Number(value);
  if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > maxTasks) {
    throw new TypeError(`host task ordinal must be 1-${maxTasks}`);
  }
  return ordinal;
}

function normalizeTaskKind(value, engineId) {
  const kind = String(value ?? '');
  if (!HOST_TASK_KINDS.includes(kind)) throw new TypeError(`unsupported host task kind: ${kind}`);
  const expectedPrefix = engineId === 'understand-anything' ? 'ua:' : `${engineId}:`;
  if (!kind.startsWith(expectedPrefix)) throw codedError('HOST_TASK_ENGINE_KIND_MISMATCH', 'host task kind does not belong to engine');
  return kind;
}

function cloneJson(value, label) {
  assertNoBinary(value, label);
  let text;
  try { text = JSON.stringify(value); } catch (error) { throw new TypeError(`${label} must be JSON serializable: ${error.message}`); }
  if (text === undefined) throw new TypeError(`${label} must be JSON serializable`);
  return JSON.parse(text);
}

function jsonBytes(value, label) {
  let text;
  try { text = stableHostJson(value); } catch (error) { throw new TypeError(`${label} must be JSON serializable: ${error.message}`); }
  return Buffer.byteLength(text, 'utf8');
}

function assertNoBinary(value, label, seen = new Set()) {
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    throw codedError('HOST_BINARY_FORBIDDEN', `${label} may not contain binary values`);
  }
  if (!value || typeof value !== 'object') return;
  if (seen.has(value)) throw new TypeError(`${label} may not contain cycles`);
  seen.add(value);
  for (const child of Array.isArray(value) ? value : Object.values(value)) assertNoBinary(child, label, seen);
  seen.delete(value);
}

function digest(value) {
  return `sha256:${crypto.createHash('sha256').update(stableHostJson(value)).digest('hex')}`;
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort(compareText).map(key => [key, sortValue(value[key])]));
  }
  return value;
}

function compareText(a, b) {
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

function requireRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Buffer.isBuffer(value)) throw new TypeError(`${label} must be an object`);
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