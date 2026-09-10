import crypto from 'node:crypto';

import { stableHostJson } from '../../mcp/src/host-bridge-contract.mjs';
import { GITHUB_RELAY_SCHEMAS } from './contracts.mjs';
import {
  GITHUB_RELAY_COMMENT_MAX_BYTES,
  GITHUB_RELAY_MARKERS,
  renderRelayComment
} from './issue-transport.mjs';

export const GITHUB_RELAY_TASK_PAYLOAD_SCHEMA =
  'kneekura.code-lab.github-relay-task-payload/v1';
export const GITHUB_RELAY_TASK_PAYLOAD_PATH = 'task-payload.json';

export function prepareRelayTaskTransport(taskEnvelope, {
  workflowRunId,
  artifactName,
  maxCommentBytes = GITHUB_RELAY_COMMENT_MAX_BYTES
} = {}) {
  const full = validateFullTaskEnvelope(taskEnvelope);
  try {
    const commentBody = renderRelayComment(
      GITHUB_RELAY_MARKERS.task,
      full,
      { maxBytes: maxCommentBytes }
    );
    return Object.freeze({
      mode: 'inline',
      envelope: full,
      comment_body: commentBody,
      artifact_bytes: null,
      artifact_content_sha256: null
    });
  } catch (error) {
    if (error?.code !== 'BLOCKED_RELAY_COMMENT_BUDGET') throw error;
  }

  const runId = normalizeWorkflowRunId(workflowRunId);
  const name = normalizeArtifactName(artifactName);
  const task = safeClone(full.task);
  const payload = safeClone(task.payload);
  const binding = taskBinding(task);
  const payloadRecord = {
    schema: GITHUB_RELAY_TASK_PAYLOAD_SCHEMA,
    run_id: full.run_id,
    task_binding: binding,
    payload
  };
  const artifactBytes = Buffer.from(`${stableHostJson(payloadRecord)}\n`, 'utf8');
  const contentSha256 = digestBytes(artifactBytes);
  delete task.payload;

  const compact = deepFreeze({
    schema: GITHUB_RELAY_SCHEMAS.task,
    run_id: full.run_id,
    task,
    payload_externalized: true,
    payload_locator: {
      provider: 'github-actions',
      workflow_run_id: runId,
      artifact_name: name,
      path: GITHUB_RELAY_TASK_PAYLOAD_PATH,
      content_sha256: contentSha256,
      content_bytes: artifactBytes.length,
      payload_digest: binding.payload_digest,
      payload_bytes: binding.payload_bytes
    }
  });
  const commentBody = renderRelayComment(
    GITHUB_RELAY_MARKERS.task,
    compact,
    { maxBytes: maxCommentBytes }
  );

  return Object.freeze({
    mode: 'github-actions-artifact',
    envelope: compact,
    comment_body: commentBody,
    artifact_bytes: artifactBytes,
    artifact_content_sha256: contentSha256
  });
}

export function verifyRelayTaskPayloadArtifact(bytes, publicTaskEnvelope) {
  const raw = Buffer.isBuffer(bytes) ? Buffer.from(bytes) : Buffer.from(bytes ?? []);
  const envelope = validateExternalTaskEnvelope(publicTaskEnvelope);
  if (raw.length !== envelope.payload_locator.content_bytes) {
    throw codedError(
      'RELAY_TASK_PAYLOAD_ARTIFACT_SIZE_MISMATCH',
      'Relay task payload artifact byte count does not match its Issue descriptor'
    );
  }
  if (digestBytes(raw) !== envelope.payload_locator.content_sha256) {
    throw codedError(
      'RELAY_TASK_PAYLOAD_ARTIFACT_DIGEST_MISMATCH',
      'Relay task payload artifact digest does not match its Issue descriptor'
    );
  }

  let record;
  try {
    record = JSON.parse(raw.toString('utf8'));
  } catch (error) {
    throw codedError(
      'RELAY_TASK_PAYLOAD_ARTIFACT_INVALID',
      `Relay task payload artifact is not valid JSON: ${error.message}`
    );
  }
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw codedError('RELAY_TASK_PAYLOAD_ARTIFACT_INVALID', 'Relay task payload artifact must contain one JSON object');
  }
  if (record.schema !== GITHUB_RELAY_TASK_PAYLOAD_SCHEMA || record.run_id !== envelope.run_id) {
    throw codedError('RELAY_TASK_PAYLOAD_ARTIFACT_BINDING_MISMATCH', 'Relay task payload artifact run/schema binding is invalid');
  }
  const expected = taskBinding(envelope.task);
  if (stableHostJson(record.task_binding) !== stableHostJson(expected)) {
    throw codedError('RELAY_TASK_PAYLOAD_ARTIFACT_BINDING_MISMATCH', 'Relay task payload artifact task binding does not match its Issue descriptor');
  }
  assertPayloadBinding(record.payload, expected);
  return deepFreeze(safeClone(record.payload));
}

function validateFullTaskEnvelope(value) {
  const envelope = safeClone(value);
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new TypeError('Relay task envelope must be an object');
  }
  if (envelope.schema !== GITHUB_RELAY_SCHEMAS.task) {
    throw new TypeError('Relay task envelope schema is invalid');
  }
  if (!envelope.task || typeof envelope.task !== 'object' || Array.isArray(envelope.task)) {
    throw new TypeError('Relay task envelope.task must be an object');
  }
  if (!Object.prototype.hasOwnProperty.call(envelope.task, 'payload')) {
    throw codedError('RELAY_TASK_PAYLOAD_MISSING', 'Full Relay task envelope is missing its Host Task payload');
  }
  if (envelope.run_id !== envelope.task.run_id) {
    throw codedError('RELAY_TASK_BINDING_MISMATCH', 'Relay task envelope run_id does not match Host Task run_id');
  }
  const binding = taskBinding(envelope.task);
  assertPayloadBinding(envelope.task.payload, binding);
  return deepFreeze(envelope);
}

function validateExternalTaskEnvelope(value) {
  const envelope = safeClone(value);
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new TypeError('External Relay task envelope must be an object');
  }
  if (envelope.schema !== GITHUB_RELAY_SCHEMAS.task || envelope.payload_externalized !== true) {
    throw codedError('RELAY_TASK_PAYLOAD_DESCRIPTOR_INVALID', 'Relay task payload descriptor is not externalized');
  }
  if (!envelope.task || typeof envelope.task !== 'object' || Array.isArray(envelope.task)) {
    throw codedError('RELAY_TASK_PAYLOAD_DESCRIPTOR_INVALID', 'Relay task payload descriptor is missing task binding');
  }
  if (Object.prototype.hasOwnProperty.call(envelope.task, 'payload')) {
    throw codedError('RELAY_TASK_PAYLOAD_DESCRIPTOR_INVALID', 'External Relay task descriptor must not embed the raw payload');
  }
  if (envelope.run_id !== envelope.task.run_id) {
    throw codedError('RELAY_TASK_BINDING_MISMATCH', 'Relay task descriptor run_id does not match task binding');
  }
  const locator = envelope.payload_locator;
  if (!locator || typeof locator !== 'object' || Array.isArray(locator)) {
    throw codedError('RELAY_TASK_PAYLOAD_DESCRIPTOR_INVALID', 'Relay task payload locator is missing');
  }
  if (locator.provider !== 'github-actions' || locator.path !== GITHUB_RELAY_TASK_PAYLOAD_PATH) {
    throw codedError('RELAY_TASK_PAYLOAD_DESCRIPTOR_INVALID', 'Relay task payload locator provider/path is invalid');
  }
  normalizeWorkflowRunId(locator.workflow_run_id);
  normalizeArtifactName(locator.artifact_name);
  normalizeDigest(locator.content_sha256, 'payload locator content_sha256');
  normalizePositiveInteger(locator.content_bytes, 'payload locator content_bytes');
  const binding = taskBinding(envelope.task);
  if (locator.payload_digest !== binding.payload_digest || locator.payload_bytes !== binding.payload_bytes) {
    throw codedError('RELAY_TASK_PAYLOAD_ARTIFACT_BINDING_MISMATCH', 'Relay task payload locator does not repeat the exact payload binding');
  }
  return deepFreeze(envelope);
}

function taskBinding(task) {
  const required = [
    'task_id',
    'run_id',
    'engine_id',
    'attempt_id',
    'snapshot_id',
    'scope_digest',
    'ordinal',
    'kind',
    'payload_digest',
    'payload_bytes'
  ];
  const binding = {};
  for (const key of required) {
    if (task?.[key] == null || task[key] === '') {
      throw codedError('RELAY_TASK_BINDING_INVALID', `Relay Host Task is missing ${key}`);
    }
    binding[key] = task[key];
  }
  normalizeDigest(binding.payload_digest, 'task payload_digest');
  normalizePositiveInteger(binding.payload_bytes, 'task payload_bytes');
  return binding;
}

function assertPayloadBinding(payload, binding) {
  const stable = stableHostJson(payload);
  const bytes = Buffer.byteLength(stable, 'utf8');
  const digest = `sha256:${crypto.createHash('sha256').update(stable).digest('hex')}`;
  if (bytes !== binding.payload_bytes) {
    throw codedError('RELAY_TASK_PAYLOAD_SIZE_MISMATCH', 'Relay task payload byte count does not match Host Task binding');
  }
  if (digest !== binding.payload_digest) {
    throw codedError('RELAY_TASK_PAYLOAD_DIGEST_MISMATCH', 'Relay task payload digest does not match Host Task binding');
  }
}

function normalizeWorkflowRunId(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new TypeError('workflowRunId must be a positive safe integer for externalized Relay task payloads');
  }
  return number;
}

function normalizeArtifactName(value) {
  const text = String(value ?? '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(text)) {
    throw new TypeError('Relay task payload artifact name is invalid');
  }
  return text;
}

function normalizeDigest(value, label) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!/^sha256:[0-9a-f]{64}$/.test(text)) throw new TypeError(`${label} must be sha256:<64 hex>`);
  return text;
}

function normalizePositiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new TypeError(`${label} must be a positive safe integer`);
  return number;
}

function digestBytes(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function safeClone(value) {
  try {
    return structuredClone(value);
  } catch (error) {
    throw new TypeError(`Relay task transport value must be structured-cloneable: ${error.message}`);
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value) || ArrayBuffer.isView(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
