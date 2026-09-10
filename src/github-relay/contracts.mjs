const EXACT_GIT_REVISION = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SNAPSHOT_ID = /^snapshot:sha256:[0-9a-f]{64}$/;
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;
const TASK_ID = /^task:sha256:[0-9a-f]{64}$/;
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_ATTEMPT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const REPOSITORY_SLUG = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;

export const GITHUB_RELAY_SCHEMAS = Object.freeze({
  request: 'kneekura.code-lab.github-relay-request/v1',
  plan: 'kneekura.code-lab.github-relay-plan/v1',
  task: 'kneekura.code-lab.github-relay-task/v1',
  response: 'kneekura.code-lab.github-relay-response/v1',
  sourceRequest: 'kneekura.code-lab.github-relay-source-request/v1',
  sourceResult: 'kneekura.code-lab.github-relay-source-result/v1',
  result: 'kneekura.code-lab.github-relay-result/v1',
  replayState: 'kneekura.code-lab.github-relay-replay-state/v1'
});

export const GITHUB_RELAY_LIMITS = Object.freeze({
  maxEnvelopeBytes: 2 * 1024 * 1024,
  maxQuestionBytes: 64 * 1024,
  maxSourcePathBytes: 4096
});

const SELECTIONS = Object.freeze([
  'kneekura',
  'understand-anything',
  'archify',
  'all'
]);

const SEMANTIC_CONTEXT_MODES = Object.freeze([
  'single-context',
  'per-engine'
]);

export function validateRelayRequest(value) {
  const input = cloneRecord(value, 'relay request');
  assertOnlyKeys(input, [
    'schema',
    'selection',
    'target',
    'commonScope',
    'engineOptions',
    'minimumClaimLevel',
    'semanticContextMode'
  ], 'relay request');
  assertSchema(input.schema, GITHUB_RELAY_SCHEMAS.request, 'relay request');

  const selection = normalizeChoice(input.selection, SELECTIONS, 'selection');
  const target = cloneRecord(input.target, 'relay target');
  assertOnlyKeys(target, ['repository', 'revision'], 'relay target');
  const repository = String(target.repository ?? '').trim();
  if (!REPOSITORY_SLUG.test(repository) || CONTROL_CHARACTERS.test(repository)) {
    throw new TypeError('relay target.repository must be a GitHub owner/name slug');
  }
  const revision = String(target.revision ?? '').trim().toLowerCase();
  if (!EXACT_GIT_REVISION.test(revision)) {
    throw new TypeError('relay target.revision must be an exact 40- or 64-hex Git revision');
  }

  const commonScope = input.commonScope == null
    ? {}
    : cloneRecord(input.commonScope, 'relay commonScope');
  const question = commonScope.question == null ? null : String(commonScope.question);
  if (question != null) {
    if (CONTROL_CHARACTERS.test(question.replace(/\n|\r|\t/g, ''))) {
      throw new TypeError('relay commonScope.question contains forbidden control characters');
    }
    if (Buffer.byteLength(question, 'utf8') > GITHUB_RELAY_LIMITS.maxQuestionBytes) {
      throw codedError('RELAY_QUESTION_TOO_LARGE', 'relay question exceeds the configured byte budget');
    }
  }

  const engineOptions = input.engineOptions == null
    ? {}
    : cloneRecord(input.engineOptions, 'relay engineOptions');
  const minimumClaimLevel = input.minimumClaimLevel == null
    ? {}
    : cloneRecord(input.minimumClaimLevel, 'relay minimumClaimLevel');
  const semanticContextMode = input.semanticContextMode == null
    ? 'single-context'
    : normalizeChoice(
        input.semanticContextMode,
        SEMANTIC_CONTEXT_MODES,
        'semanticContextMode'
      );

  if (selection === 'all' && semanticContextMode !== 'per-engine') {
    throw codedError(
      'BLOCKED_SEMANTIC_CONTEXT_ISOLATION',
      'GitHub Relay all-mode requires independently isolated semantic host contexts per engine'
    );
  }

  const normalized = {
    schema: GITHUB_RELAY_SCHEMAS.request,
    selection,
    target: { repository, revision },
    commonScope,
    engineOptions,
    minimumClaimLevel,
    semanticContextMode
  };
  assertEnvelopeBudget(normalized);
  return deepFreeze(normalized);
}

export function validateRelayPlan(value) {
  const input = cloneRecord(value, 'relay plan');
  assertOnlyKeys(input, [
    'schema',
    'run_id',
    'selection',
    'target',
    'semantic_context_mode',
    'code_lab_revision',
    'engine_lock_digest'
  ], 'relay plan');
  assertSchema(input.schema, GITHUB_RELAY_SCHEMAS.plan, 'relay plan');

  const selection = normalizeChoice(input.selection, SELECTIONS, 'selection');
  const runId = normalizeRunId(input.run_id);
  const target = normalizeBoundTarget(input.target);
  const semanticContextMode = normalizeChoice(
    input.semantic_context_mode,
    SEMANTIC_CONTEXT_MODES,
    'semantic_context_mode'
  );
  if (selection === 'all' && semanticContextMode !== 'per-engine') {
    throw codedError(
      'BLOCKED_SEMANTIC_CONTEXT_ISOLATION',
      'relay plan cannot authorize all-mode without per-engine semantic context isolation'
    );
  }
  const codeLabRevision = normalizeRevision(input.code_lab_revision, 'code_lab_revision');
  const engineLockDigest = normalizeDigest(input.engine_lock_digest, 'engine_lock_digest');

  const normalized = {
    schema: GITHUB_RELAY_SCHEMAS.plan,
    run_id: runId,
    selection,
    target,
    semantic_context_mode: semanticContextMode,
    code_lab_revision: codeLabRevision,
    engine_lock_digest: engineLockDigest
  };
  assertEnvelopeBudget(normalized);
  return deepFreeze(normalized);
}

export function createRelayTaskEnvelope(task) {
  const normalizedTask = normalizeHostTaskBinding(task);
  const envelope = {
    schema: GITHUB_RELAY_SCHEMAS.task,
    run_id: normalizedTask.run_id,
    task: safeClone(task)
  };
  assertEnvelopeBudget(envelope);
  return deepFreeze(envelope);
}

export function validateRelayResponseEnvelope(value) {
  const input = cloneRecord(value, 'relay response');
  assertOnlyKeys(input, [
    'schema',
    'run_id',
    'task_id',
    'engine_id',
    'attempt_id',
    'snapshot_id',
    'scope_digest',
    'ordinal',
    'kind',
    'payload_digest',
    'response'
  ], 'relay response');
  assertSchema(input.schema, GITHUB_RELAY_SCHEMAS.response, 'relay response');

  const normalized = {
    schema: GITHUB_RELAY_SCHEMAS.response,
    run_id: normalizeRunId(input.run_id),
    task_id: normalizeTaskId(input.task_id),
    engine_id: normalizeEngineId(input.engine_id),
    attempt_id: normalizeAttemptId(input.attempt_id),
    snapshot_id: normalizeSnapshotId(input.snapshot_id),
    scope_digest: normalizeDigest(input.scope_digest, 'scope_digest'),
    ordinal: normalizePositiveInteger(input.ordinal, 'ordinal'),
    kind: normalizeBoundedText(input.kind, 'kind', 200),
    payload_digest: normalizeDigest(input.payload_digest, 'payload_digest'),
    response: safeClone(input.response)
  };
  assertEnvelopeBudget(normalized);
  return deepFreeze(normalized);
}

export function assertRelayResponseMatchesTask(responseEnvelope, task) {
  const response = validateRelayResponseEnvelope(responseEnvelope);
  const expected = normalizeHostTaskBinding(task);
  const pairs = [
    ['run_id', expected.run_id],
    ['task_id', expected.task_id],
    ['engine_id', expected.engine_id],
    ['attempt_id', expected.attempt_id],
    ['snapshot_id', expected.snapshot_id],
    ['scope_digest', expected.scope_digest],
    ['ordinal', expected.ordinal],
    ['kind', expected.kind],
    ['payload_digest', expected.payload_digest]
  ];
  for (const [key, value] of pairs) {
    if (response[key] !== value) {
      throw codedError(
        'RELAY_RESPONSE_BINDING_MISMATCH',
        `relay response ${key} does not match the current pending Host Task`
      );
    }
  }
  return response;
}

export function validateRelaySourceRequest(value) {
  const input = cloneRecord(value, 'relay source request');
  assertOnlyKeys(input, [
    'schema',
    'run_id',
    'task_id',
    'path',
    'start_line',
    'end_line'
  ], 'relay source request');
  assertSchema(
    input.schema,
    GITHUB_RELAY_SCHEMAS.sourceRequest,
    'relay source request'
  );
  const path = normalizeRepositoryPath(input.path);
  const startLine = normalizePositiveInteger(input.start_line, 'start_line');
  const endLine = normalizePositiveInteger(input.end_line, 'end_line');
  if (endLine < startLine) throw new TypeError('end_line must be >= start_line');
  const normalized = {
    schema: GITHUB_RELAY_SCHEMAS.sourceRequest,
    run_id: normalizeRunId(input.run_id),
    task_id: normalizeTaskId(input.task_id),
    path,
    start_line: startLine,
    end_line: endLine
  };
  assertEnvelopeBudget(normalized);
  return deepFreeze(normalized);
}

export function stableRelayJson(value) {
  return JSON.stringify(sortValue(value));
}

function normalizeBoundTarget(value) {
  const target = cloneRecord(value, 'relay bound target');
  assertOnlyKeys(target, [
    'repository',
    'revision',
    'snapshot_id',
    'scope_digest'
  ], 'relay bound target');
  const repository = String(target.repository ?? '').trim();
  if (!REPOSITORY_SLUG.test(repository) || CONTROL_CHARACTERS.test(repository)) {
    throw new TypeError('relay target.repository must be a GitHub owner/name slug');
  }
  return {
    repository,
    revision: normalizeRevision(target.revision, 'target.revision'),
    snapshot_id: normalizeSnapshotId(target.snapshot_id),
    scope_digest: normalizeDigest(target.scope_digest, 'target.scope_digest')
  };
}

function normalizeHostTaskBinding(task) {
  const input = cloneRecord(task, 'Host Task');
  return {
    run_id: normalizeRunId(input.run_id),
    task_id: normalizeTaskId(input.task_id),
    engine_id: normalizeEngineId(input.engine_id),
    attempt_id: normalizeAttemptId(input.attempt_id),
    snapshot_id: normalizeSnapshotId(input.snapshot_id),
    scope_digest: normalizeDigest(input.scope_digest, 'scope_digest'),
    ordinal: normalizePositiveInteger(input.ordinal, 'ordinal'),
    kind: normalizeBoundedText(input.kind, 'kind', 200),
    payload_digest: normalizeDigest(input.payload_digest, 'payload_digest')
  };
}

function normalizeRepositoryPath(value) {
  const path = String(value ?? '').replaceAll('\\', '/').replace(/^\.\//, '');
  if (
    !path ||
    path.startsWith('/') ||
    /^[A-Za-z]:\//.test(path) ||
    path.split('/').some(part => !part || part === '.' || part === '..') ||
    CONTROL_CHARACTERS.test(path) ||
    Buffer.byteLength(path, 'utf8') > GITHUB_RELAY_LIMITS.maxSourcePathBytes
  ) {
    throw codedError('RELAY_SOURCE_PATH_UNSAFE', 'relay source path is unsafe');
  }
  return path;
}

function normalizeEngineId(value) {
  return normalizeChoice(
    value,
    ['kneekura', 'understand-anything', 'archify'],
    'engine_id'
  );
}

function normalizeRevision(value, label) {
  const revision = String(value ?? '').trim().toLowerCase();
  if (!EXACT_GIT_REVISION.test(revision)) {
    throw new TypeError(`${label} must be an exact 40- or 64-hex Git revision`);
  }
  return revision;
}

function normalizeSnapshotId(value) {
  const snapshot = String(value ?? '').trim().toLowerCase();
  if (!SNAPSHOT_ID.test(snapshot)) {
    throw new TypeError('snapshot_id must be snapshot:sha256:<64 hex>');
  }
  return snapshot;
}

function normalizeDigest(value, label) {
  const digest = String(value ?? '').trim().toLowerCase();
  if (!SHA256_DIGEST.test(digest)) {
    throw new TypeError(`${label} must be sha256:<64 hex>`);
  }
  return digest;
}

function normalizeTaskId(value) {
  const taskId = String(value ?? '').trim().toLowerCase();
  if (!TASK_ID.test(taskId)) {
    throw new TypeError('task_id must be task:sha256:<64 hex>');
  }
  return taskId;
}

function normalizeRunId(value) {
  const runId = String(value ?? '').trim();
  if (!SAFE_RUN_ID.test(runId)) throw new TypeError('run_id is invalid');
  return runId;
}

function normalizeAttemptId(value) {
  const attemptId = String(value ?? '').trim();
  if (!SAFE_ATTEMPT_ID.test(attemptId)) throw new TypeError('attempt_id is invalid');
  return attemptId;
}

function normalizeChoice(value, choices, label) {
  const text = String(value ?? '').trim();
  if (!choices.includes(text)) {
    throw new TypeError(`${label} must be one of: ${choices.join(', ')}`);
  }
  return text;
}

function normalizePositiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return number;
}

function normalizeBoundedText(value, label, maxBytes) {
  const text = String(value ?? '').trim();
  if (!text || CONTROL_CHARACTERS.test(text)) {
    throw new TypeError(`${label} is invalid`);
  }
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    throw codedError('RELAY_FIELD_TOO_LARGE', `${label} exceeds ${maxBytes} bytes`);
  }
  return text;
}

function cloneRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return safeClone(value);
}

function assertOnlyKeys(value, allowed, label) {
  const set = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!set.has(key)) throw new TypeError(`${label} contains unsupported key: ${key}`);
  }
}

function assertSchema(actual, expected, label) {
  if (actual !== expected) throw new TypeError(`${label} schema must be ${expected}`);
}

function assertEnvelopeBudget(value) {
  let json;
  try {
    json = stableRelayJson(value);
  } catch (error) {
    throw new TypeError(`relay envelope must be JSON serializable: ${error.message}`);
  }
  if (Buffer.byteLength(json, 'utf8') > GITHUB_RELAY_LIMITS.maxEnvelopeBytes) {
    throw codedError(
      'RELAY_ENVELOPE_TOO_LARGE',
      `relay envelope exceeds ${GITHUB_RELAY_LIMITS.maxEnvelopeBytes} bytes`
    );
  }
}

function safeClone(value) {
  if (value === undefined) return null;
  try {
    return structuredClone(value);
  } catch (error) {
    throw new TypeError(`relay value must be structured-cloneable: ${error.message}`);
  }
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort(compareText)
        .map(key => [key, sortValue(value[key])])
    );
  }
  return value;
}

function compareText(left, right) {
  return String(left) < String(right) ? -1 : String(left) > String(right) ? 1 : 0;
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
