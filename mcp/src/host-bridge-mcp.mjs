import {
  DEFAULT_HOST_BRIDGE_LIMITS,
  HOST_RESPONSE_SCHEMA,
  validateHostResponseForTask,
  validateHostTask
} from './host-bridge-contract.mjs';
import { sanitizeDiagnosticText } from '../../src/skill/runtime.mjs';

export const MCP_HOST_TASK_REQUIRED_SCHEMA =
  'kneekura.code-lab.mcp-host-task-required/v1';
export const MCP_HOST_TASK_STATUS_SCHEMA =
  'kneekura.code-lab.mcp-host-task-status/v1';
export const MCP_HOST_SOURCE_CATALOG_SCHEMA =
  'kneekura.code-lab.mcp-host-source-catalog/v1';
export const MCP_HOST_SOURCE_READ_SCHEMA =
  'kneekura.code-lab.mcp-host-source-read/v1';
export const MCP_HOST_RESPONSE_ACCEPTED_SCHEMA =
  'kneekura.code-lab.mcp-host-response-accepted/v1';

export const HOST_BRIDGE_MCP_TOOL_NAMES = Object.freeze([
  'kneekura_code_lab_describe',
  'kneekura_code_lab_plan',
  'kneekura_code_lab_execute',
  'kneekura_code_lab_next_task',
  'kneekura_code_lab_source_catalog',
  'kneekura_code_lab_read_source',
  'kneekura_code_lab_submit_response',
  'kneekura_code_lab_status',
  'kneekura_code_lab_artifact_info'
]);

const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TASK_ID = /^task:sha256:[0-9a-f]{64}$/;
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;
const MAX_SOURCE_PATH = 4096;

export function createHostBridgeMcpFacade({ adapter, backend = null } = {}) {
  if (!adapter || typeof adapter !== 'object') {
    throw new TypeError('Host Bridge MCP facade requires the base MCP adapter');
  }
  const hostBridgeAttached = hasHostBridgeBackend(backend);

  return Object.freeze({
    describe() {
      const base = adapter.describe();
      return deepFreeze({
        ...cloneJson(base, 'adapter description'),
        tools: [...HOST_BRIDGE_MCP_TOOL_NAMES],
        host_bridge_attached: hostBridgeAttached,
        multi_round_host_semantics: hostBridgeAttached,
        host_task_source_reads_bounded: true
      });
    },

    plan(input = {}) {
      return adapter.plan(input);
    },

    async execute(input = {}) {
      const plan = adapter.plan(input);
      if (plan.kind === 'SELECTION_REQUIRED') {
        return adapter.execute(input);
      }
      try {
        return await adapter.execute(input);
      } catch (error) {
        if (String(error?.code ?? '') !== 'HOST_TASK_REQUIRED' || !error?.task) {
          throw error;
        }
        return projectRequiredTask(plan, error.task);
      }
    },

    async nextTask(input = {}) {
      const runId = onlyRunId(input, 'next-task request');
      requireHostBridge(backend, 'pendingTask');
      const task = await backend.pendingTask(runId);
      if (task == null) {
        return deepFreeze({
          schema: MCP_HOST_TASK_STATUS_SCHEMA,
          run_id: runId,
          pending: false,
          task: null
        });
      }
      validateBoundTask(task, { runId });
      return deepFreeze({
        schema: MCP_HOST_TASK_STATUS_SCHEMA,
        run_id: runId,
        pending: true,
        task: cloneJson(task, 'pending host task')
      });
    },

    async sourceCatalog(input = {}) {
      requirePlainRecord(input, 'source-catalog request');
      assertOnlyKeys(input, ['runId', 'taskId', 'offset', 'limit'], 'source-catalog request');
      const runId = normalizeRunId(input.runId);
      const taskId = normalizeTaskId(input.taskId);
      const offset = normalizeInteger(input.offset ?? 0, 'offset', 0, Number.MAX_SAFE_INTEGER);
      const limit = normalizeInteger(input.limit ?? 200, 'limit', 1, 500);
      requireHostBridge(backend, 'sourceCatalog');
      const value = await backend.sourceCatalog(runId, taskId, { offset, limit });
      requirePlainRecord(value, 'source catalog');
      const entries = Array.isArray(value.entries) ? value.entries : [];
      if (entries.length > limit) {
        throw codedError('HOST_SOURCE_CATALOG_OVERSIZED', 'backend returned more source-catalog entries than requested');
      }
      return deepFreeze({
        schema: MCP_HOST_SOURCE_CATALOG_SCHEMA,
        run_id: runId,
        task_id: taskId,
        total: normalizeInteger(value.total ?? entries.length, 'total', 0, Number.MAX_SAFE_INTEGER),
        offset,
        next_offset: value.next_offset == null
          ? null
          : normalizeInteger(value.next_offset, 'next_offset', 0, Number.MAX_SAFE_INTEGER),
        entries: entries.map(projectCatalogEntry)
      });
    },

    async readSource(input = {}) {
      requirePlainRecord(input, 'source-read request');
      assertOnlyKeys(input, ['runId', 'taskId', 'path', 'startLine', 'endLine'], 'source-read request');
      const runId = normalizeRunId(input.runId);
      const taskId = normalizeTaskId(input.taskId);
      const request = {
        path: normalizeRelativePath(input.path),
        ...(input.startLine == null ? {} : {
          startLine: normalizeInteger(input.startLine, 'startLine', 1, Number.MAX_SAFE_INTEGER)
        }),
        ...(input.endLine == null ? {} : {
          endLine: normalizeInteger(input.endLine, 'endLine', 1, Number.MAX_SAFE_INTEGER)
        })
      };
      if (request.startLine != null && request.endLine != null && request.endLine < request.startLine) {
        throw new TypeError('endLine must be >= startLine');
      }
      requireHostBridge(backend, 'readSource');
      const value = await backend.readSource(runId, taskId, request);
      requirePlainRecord(value, 'source-read result');
      const text = sanitizeDiagnosticText(String(value.text ?? ''), {
        maxBytes: DEFAULT_HOST_BRIDGE_LIMITS.maxSourceReadBytes
      });
      return deepFreeze({
        schema: MCP_HOST_SOURCE_READ_SCHEMA,
        run_id: runId,
        task_id: taskId,
        path: normalizeRelativePath(value.path ?? request.path),
        start_line: normalizeInteger(value.start_line, 'start_line', 1, Number.MAX_SAFE_INTEGER),
        end_line: normalizeInteger(value.end_line, 'end_line', 1, Number.MAX_SAFE_INTEGER),
        content_digest: normalizeDigest(value.content_digest),
        text,
        instruction_authority: false,
        trust_class: 'UNTRUSTED_REPOSITORY_DATA',
        canonical_source_bytes: optionalNonNegativeInteger(value.canonical_source_bytes),
        task_source_bytes_used: optionalNonNegativeInteger(value.task_source_bytes_used),
        task_source_bytes_limit: optionalNonNegativeInteger(value.task_source_bytes_limit)
      });
    },

    async submitResponse(input = {}) {
      requirePlainRecord(input, 'submit-response request');
      assertOnlyKeys(input, ['runId', 'taskId', 'response'], 'submit-response request');
      const runId = normalizeRunId(input.runId);
      const taskId = normalizeTaskId(input.taskId);
      const response = cloneJson(input.response, 'host response');
      const responseBytes = Buffer.byteLength(stableJson(response), 'utf8');
      if (responseBytes > DEFAULT_HOST_BRIDGE_LIMITS.maxResponseBytes) {
        throw codedError(
          'HOST_RESPONSE_TOO_LARGE',
          `host response exceeds ${DEFAULT_HOST_BRIDGE_LIMITS.maxResponseBytes} bytes`
        );
      }
      requireHostBridge(backend, 'pendingTask');
      requireHostBridge(backend, 'acceptHostResponse');
      const pending = await backend.pendingTask(runId);
      if (!pending) throw codedError('HOST_TASK_NOT_PENDING', 'no host task is pending for this run');
      validateBoundTask(pending, { runId, taskId });
      const record = await backend.acceptHostResponse(runId, taskId, response);
      validateHostResponseForTask(pending, record);
      if (record.schema !== HOST_RESPONSE_SCHEMA) throw new TypeError('backend returned an invalid host response record');
      return deepFreeze({
        schema: MCP_HOST_RESPONSE_ACCEPTED_SCHEMA,
        run_id: runId,
        task_id: taskId,
        accepted: true,
        engine_id: record.engine_id,
        attempt_id: record.attempt_id,
        ordinal: record.ordinal,
        kind: record.kind,
        response_digest: record.response_digest,
        response_bytes: record.response_bytes,
        response_body_exposed: false,
        next_action: 'Call kneekura_code_lab_execute again with the exact same immutable request.'
      });
    },

    async status(input = {}) {
      const runId = onlyRunId(input, 'status request');
      const base = await adapter.status({ runId });
      if (!base?.found || typeof backend?.pendingTask !== 'function') return base;
      const task = await backend.pendingTask(runId);
      if (task != null) validateBoundTask(task, { runId });
      return deepFreeze({
        ...cloneJson(base, 'status projection'),
        pending_task_id: task?.task_id ?? null,
        host_task_pending: task != null
      });
    },

    async artifactInfo(input = {}) {
      return adapter.artifactInfo(input);
    }
  });
}

function projectRequiredTask(plan, task) {
  validateBoundTask(task, {
    runId: plan.runId,
    snapshotId: plan.target.snapshotId,
    scopeDigest: plan.target.scopeDigest,
    requestedEngines: plan.requestedEngines
  });
  return deepFreeze({
    schema: MCP_HOST_TASK_REQUIRED_SCHEMA,
    kind: 'HOST_TASK_REQUIRED',
    run_id: plan.runId,
    target: cloneJson(plan.target, 'target'),
    requested_engines: [...plan.requestedEngines],
    task: cloneJson(task, 'host task'),
    next_action: {
      inspect_task: 'Use kneekura_code_lab_next_task for the same run id.',
      inspect_sources: 'Use source_catalog/read_source only while this exact task is pending.',
      submit: 'Submit one semantic response with kneekura_code_lab_submit_response.',
      continue: 'Then call kneekura_code_lab_execute again with the exact same immutable request.'
    }
  });
}

function projectCatalogEntry(value) {
  requirePlainRecord(value, 'source-catalog entry');
  return {
    path: normalizeRelativePath(value.path),
    content_digest: normalizeDigest(value.content_digest),
    line_count: optionalNonNegativeInteger(value.line_count),
    bytes: optionalNonNegativeInteger(value.bytes),
    instruction_authority: false
  };
}

function validateBoundTask(task, {
  runId,
  taskId = null,
  snapshotId = null,
  scopeDigest = null,
  requestedEngines = null
} = {}) {
  validateHostTask(task);
  if (task.run_id !== runId) throw codedError('HOST_TASK_BINDING_MISMATCH', 'pending Host Task belongs to another run');
  if (taskId != null && task.task_id !== taskId) throw codedError('HOST_TASK_NOT_PENDING', 'task id is not the current pending Host Task');
  if (snapshotId != null && task.snapshot_id !== snapshotId) throw codedError('HOST_TASK_BINDING_MISMATCH', 'pending Host Task snapshot does not match the execution plan');
  if (scopeDigest != null && task.scope_digest !== scopeDigest) throw codedError('HOST_TASK_BINDING_MISMATCH', 'pending Host Task scope does not match the execution plan');
  if (requestedEngines != null && !requestedEngines.includes(task.engine_id)) {
    throw codedError('ENGINE_SUBSTITUTION_FORBIDDEN', 'pending Host Task engine was not requested by the execution plan');
  }
  return true;
}

function hasHostBridgeBackend(backend) {
  return Boolean(backend) && [
    'execute',
    'status',
    'artifactInfo',
    'pendingTask',
    'sourceCatalog',
    'readSource',
    'acceptHostResponse'
  ].every(name => typeof backend[name] === 'function');
}

function requireHostBridge(backend, method) {
  if (typeof backend?.[method] !== 'function') {
    throw codedError(
      'BLOCKED_HOST_BRIDGE_UNAVAILABLE',
      `KNEEKURA Code LAB Host Bridge operation is unavailable: ${method}`
    );
  }
}

function onlyRunId(input, label) {
  requirePlainRecord(input, label);
  assertOnlyKeys(input, ['runId'], label);
  return normalizeRunId(input.runId);
}

function normalizeRunId(value) {
  const runId = String(value ?? '').trim();
  if (!SAFE_RUN_ID.test(runId)) throw new TypeError('runId must be a safe 1-128 character identifier');
  return runId;
}

function normalizeTaskId(value) {
  const taskId = String(value ?? '').trim().toLowerCase();
  if (!TASK_ID.test(taskId)) throw new TypeError('taskId must be task:sha256:<64 hex>');
  return taskId;
}

function normalizeDigest(value) {
  const digest = String(value ?? '').trim().toLowerCase();
  if (!SHA256_DIGEST.test(digest)) throw new TypeError('content digest must be sha256:<64 hex>');
  return digest;
}

function normalizeRelativePath(value) {
  const text = String(value ?? '').replaceAll('\\', '/').replace(/^\.\//, '');
  if (
    !text ||
    text.length > MAX_SOURCE_PATH ||
    text.startsWith('/') ||
    /^[A-Za-z]:\//.test(text) ||
    text.split('/').some(part => !part || part === '.' || part === '..') ||
    /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(text)
  ) {
    throw new TypeError('source path must be a safe repository-relative path');
  }
  return text;
}

function normalizeInteger(value, label, min, max) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new TypeError(`${label} must be an integer between ${min} and ${max}`);
  }
  return number;
}

function optionalNonNegativeInteger(value) {
  if (value == null) return null;
  return normalizeInteger(value, 'numeric metadata', 0, Number.MAX_SAFE_INTEGER);
}

function cloneJson(value, label) {
  assertNoBinary(value, label);
  let text;
  try { text = JSON.stringify(value); } catch (error) { throw new TypeError(`${label} must be JSON serializable: ${error.message}`); }
  if (text === undefined) throw new TypeError(`${label} must be JSON serializable`);
  return JSON.parse(text);
}

function stableJson(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortValue(value[key])]));
  }
  return value;
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

function requirePlainRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Buffer.isBuffer(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function assertOnlyKeys(value, allowed, label) {
  const set = new Set(allowed);
  const unexpected = Object.keys(value).filter(key => !set.has(key));
  if (unexpected.length) throw new TypeError(`${label} contains unsupported field(s): ${unexpected.join(', ')}`);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Buffer.isBuffer(value) || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}