import {
  ENGINE_IDS,
  createSanitizedReceipt,
  routeKneekuraCodeLabRequest,
  sanitizeDiagnosticText
} from '../../src/skill/index.mjs';

export const MCP_ADAPTER_SCHEMA = 'kneekura.code-lab.mcp-adapter/v1';
export const MCP_PLAN_SCHEMA = 'kneekura.code-lab.mcp-plan/v1';
export const MCP_EXECUTION_PROJECTION_SCHEMA =
  'kneekura.code-lab.mcp-execution-projection/v1';
export const MCP_STATUS_SCHEMA = 'kneekura.code-lab.mcp-status/v1';
export const MCP_ARTIFACT_INFO_SCHEMA =
  'kneekura.code-lab.mcp-artifact-info/v1';

export const MCP_TOOL_NAMES = Object.freeze([
  'kneekura_code_lab_describe',
  'kneekura_code_lab_plan',
  'kneekura_code_lab_execute',
  'kneekura_code_lab_status',
  'kneekura_code_lab_artifact_info'
]);

const MAX_REQUEST_JSON_BYTES = 128 * 1024;
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const EXACT_GIT_REVISION = /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/;
const SNAPSHOT_ID = /^snapshot:sha256:[0-9a-f]{64}$/;
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;

export function createKneekuraCodeLabMcpAdapter({ backend = null } = {}) {
  validateBackendShape(backend);

  return Object.freeze({
    schema: MCP_ADAPTER_SCHEMA,

    describe() {
      return deepFreeze({
        schema: MCP_ADAPTER_SCHEMA,
        name: 'KNEEKURA Code LAB',
        protocol: 'mcp-adapter-v1',
        engines: [...ENGINE_IDS, 'all'],
        hidden_default_engine: false,
        semantic_fusion: false,
        canonical_truth_promotion_from_consensus: false,
        exact_target_required_for_execution: true,
        backend_attached: typeof backend?.execute === 'function',
        tools: [...MCP_TOOL_NAMES]
      });
    },

    plan(input = {}) {
      return planKneekuraCodeLabMcpRequest(input);
    },

    async execute(input = {}) {
      const plan = planKneekuraCodeLabMcpRequest(input);
      if (plan.kind === 'SELECTION_REQUIRED') return plan;
      if (typeof backend?.execute !== 'function') {
        throw codedError(
          'BLOCKED_BACKEND_UNAVAILABLE',
          'KNEEKURA Code LAB MCP execution backend is not attached'
        );
      }
      const execution = await backend.execute(plan);
      return projectExecutionForMcp(plan, execution);
    },

    async status(input = {}) {
      requirePlainRecord(input, 'status request');
      assertOnlyKeys(input, ['runId'], 'status request');
      const runId = normalizeRunId(input.runId);
      if (typeof backend?.status !== 'function') {
        throw codedError(
          'BLOCKED_BACKEND_UNAVAILABLE',
          'KNEEKURA Code LAB MCP status backend is not attached'
        );
      }
      const status = await backend.status(runId);
      return projectStatusForMcp(runId, status);
    },

    async artifactInfo(input = {}) {
      requirePlainRecord(input, 'artifact request');
      assertOnlyKeys(input, ['runId', 'artifactId'], 'artifact request');
      const runId = normalizeRunId(input.runId);
      const artifactId = input.artifactId == null
        ? null
        : normalizeArtifactId(input.artifactId);
      if (typeof backend?.artifactInfo !== 'function') {
        throw codedError(
          'BLOCKED_BACKEND_UNAVAILABLE',
          'KNEEKURA Code LAB MCP artifact backend is not attached'
        );
      }
      const value = await backend.artifactInfo(runId, artifactId);
      return projectArtifactInfoForMcp(runId, value);
    }
  });
}

export function planKneekuraCodeLabMcpRequest(input = {}) {
  requirePlainRecord(input, 'MCP request');
  assertOnlyKeys(input, [
    'selection',
    'target',
    'runId',
    'commonScope',
    'engineOptions',
    'minimumClaimLevel'
  ], 'MCP request');
  assertJsonBudget(input);

  const target = normalizeTarget(input.target);
  const runId = normalizeRunId(input.runId);
  const runtimeRequest = deepFreeze({
    selection: input.selection == null ? null : String(input.selection),
    commonScope: clonePlainObject(input.commonScope, 'commonScope'),
    engineOptions: clonePlainObject(input.engineOptions, 'engineOptions'),
    minimumClaimLevel: clonePlainObject(
      input.minimumClaimLevel,
      'minimumClaimLevel'
    )
  });
  const decision = routeKneekuraCodeLabRequest(runtimeRequest);

  if (decision.kind === 'SELECTION_REQUIRED') {
    return deepFreeze({
      schema: MCP_PLAN_SCHEMA,
      kind: 'SELECTION_REQUIRED',
      runId,
      target,
      choices: [...decision.choices],
      runtimeRequest,
      normalizedRequest: decision.request
    });
  }

  return deepFreeze({
    schema: MCP_PLAN_SCHEMA,
    kind: 'RUN',
    runId,
    target,
    requestedEngines: [...decision.requestedEngines],
    runtimeRequest,
    normalizedRequest: decision.request,
    invariants: {
      exact_revision_required: true,
      canonical_snapshot_required: true,
      scope_digest_required: true,
      engine_substitution_forbidden: true,
      semantic_fusion: false,
      target_instruction_authority: false
    }
  });
}

export function projectExecutionForMcp(plan, execution) {
  requirePlainRecord(execution, 'execution result');

  if (execution.kind === 'ENGINE_RESULT') {
    const receipt = execution.result?.receipt;
    if (!receipt || typeof receipt !== 'object') {
      throw codedError(
        'MCP_EXECUTION_RECEIPT_MISSING',
        'engine execution did not return a receipt'
      );
    }
    return deepFreeze({
      schema: MCP_EXECUTION_PROJECTION_SCHEMA,
      kind: 'ENGINE_RESULT',
      run_id: plan.runId,
      target: plan.target,
      requested_engine: execution.requestedEngine,
      attempt: safeClone(execution.attempt),
      receipt: createSanitizedReceipt(receipt, { maxBytes: 64 * 1024 }),
      sealed_artifact: sanitizeArtifactMetadata(execution.sealedArtifact),
      raw_engine_result_exposed: false,
      artifact_bytes_exposed: false
    });
  }

  if (execution.kind === 'ALL_MODE_BUNDLE') {
    return deepFreeze({
      schema: MCP_EXECUTION_PROJECTION_SCHEMA,
      kind: 'ALL_MODE_BUNDLE',
      run_id: plan.runId,
      target: plan.target,
      status: String(execution.status ?? ''),
      snapshot_id: String(execution.snapshotId ?? ''),
      scope_digest: String(execution.scopeDigest ?? ''),
      run_manifest: safeClone(execution.runManifest),
      comparison: safeClone(execution.comparison),
      outcomes: safeClone(execution.outcomes),
      bundle_artifact: execution.bundleZipDigest
        ? {
            id: 'all:bundle.zip',
            digest: normalizeDigest(execution.bundleZipDigest),
            bytes: Buffer.isBuffer(execution.bundleZip)
              ? execution.bundleZip.length
              : null
          }
        : null,
      raw_engine_results_exposed: false,
      artifact_bytes_exposed: false
    });
  }

  if (execution.kind === 'SELECTION_REQUIRED') {
    return deepFreeze({
      schema: MCP_EXECUTION_PROJECTION_SCHEMA,
      kind: 'SELECTION_REQUIRED',
      run_id: plan.runId,
      target: plan.target,
      choices: Array.isArray(execution.choices)
        ? execution.choices.map(String)
        : [...ENGINE_IDS]
    });
  }

  throw codedError(
    'MCP_EXECUTION_KIND_UNSUPPORTED',
    `unsupported KNEEKURA Code LAB execution kind: ${execution.kind}`
  );
}

export function projectStatusForMcp(runId, status) {
  if (status == null) {
    return deepFreeze({
      schema: MCP_STATUS_SCHEMA,
      run_id: runId,
      found: false,
      phase: 'UNKNOWN',
      summary: null,
      artifacts: []
    });
  }
  requirePlainRecord(status, 'backend status');
  return deepFreeze({
    schema: MCP_STATUS_SCHEMA,
    run_id: runId,
    found: true,
    phase: normalizeEnumText(status.phase, [
      'PENDING', 'RUNNING', 'COMPLETE', 'FAILED', 'BLOCKED'
    ], 'phase'),
    summary: status.summary == null
      ? null
      : sanitizeDiagnosticText(status.summary, { maxBytes: 4096 }),
    error: status.error == null
      ? null
      : sanitizeErrorRecord(status.error),
    artifacts: normalizeArtifactList(status.artifacts)
  });
}

export function projectArtifactInfoForMcp(runId, value) {
  const items = Array.isArray(value)
    ? value
    : value == null
      ? []
      : [value];
  return deepFreeze({
    schema: MCP_ARTIFACT_INFO_SCHEMA,
    run_id: runId,
    artifacts: normalizeArtifactList(items),
    artifact_bytes_exposed: false
  });
}

export function formatMcpAdapterError(error) {
  return deepFreeze({
    schema: 'kneekura.code-lab.mcp-error/v1',
    code: sanitizeDiagnosticText(
      String(error?.code ?? (error instanceof TypeError ? 'INVALID_REQUEST' : 'MCP_ADAPTER_ERROR')),
      { maxBytes: 256 }
    ),
    message: sanitizeDiagnosticText(
      String(error?.message ?? error),
      { maxBytes: 4096 }
    )
  });
}

function normalizeTarget(value) {
  requirePlainRecord(value, 'target');
  assertOnlyKeys(value, [
    'repository', 'revision', 'snapshotId', 'scopeDigest'
  ], 'target');

  const repository = requireBoundedText(value.repository, 'target.repository', 500);
  if (CONTROL_CHARACTERS.test(repository)) {
    throw new TypeError('target.repository contains forbidden control characters');
  }

  const revision = String(value.revision ?? '').trim().toLowerCase();
  if (!EXACT_GIT_REVISION.test(revision)) {
    throw new TypeError('target.revision must be an exact 40- or 64-hex Git revision');
  }
  const snapshotId = String(value.snapshotId ?? '').trim().toLowerCase();
  if (!SNAPSHOT_ID.test(snapshotId)) {
    throw new TypeError('target.snapshotId must be snapshot:sha256:<64 hex>');
  }
  const scopeDigest = String(value.scopeDigest ?? '').trim().toLowerCase();
  if (!SHA256_DIGEST.test(scopeDigest)) {
    throw new TypeError('target.scopeDigest must be sha256:<64 hex>');
  }

  return deepFreeze({ repository, revision, snapshotId, scopeDigest });
}

function normalizeRunId(value) {
  const runId = String(value ?? '').trim();
  if (!SAFE_RUN_ID.test(runId)) {
    throw new TypeError('runId must be a safe 1-128 character identifier');
  }
  return runId;
}

function normalizeArtifactId(value) {
  const artifactId = String(value ?? '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(artifactId)) {
    throw new TypeError('artifactId is invalid');
  }
  return artifactId;
}

function clonePlainObject(value, label) {
  if (value == null) return {};
  requirePlainRecord(value, label);
  return deepFreeze(safeClone(value));
}

function assertJsonBudget(value) {
  let json;
  try {
    json = JSON.stringify(value);
  } catch (error) {
    throw new TypeError(`MCP request must be JSON serializable: ${error.message}`);
  }
  if (Buffer.byteLength(json, 'utf8') > MAX_REQUEST_JSON_BYTES) {
    throw codedError(
      'MCP_REQUEST_TOO_LARGE',
      `MCP request exceeds ${MAX_REQUEST_JSON_BYTES} bytes`
    );
  }
}

function normalizeArtifactList(items) {
  if (!Array.isArray(items)) return [];
  return items.map(sanitizeArtifactMetadata).filter(Boolean);
}

function sanitizeArtifactMetadata(value) {
  if (value == null) return null;
  requirePlainRecord(value, 'artifact metadata');
  const id = value.id == null ? null : normalizeArtifactId(value.id);
  const digest = value.digest == null ? null : normalizeDigest(value.digest);
  const bytes = value.bytes == null ? null : Number(value.bytes);
  if (bytes != null && (!Number.isSafeInteger(bytes) || bytes < 0)) {
    throw new TypeError('artifact bytes must be a non-negative safe integer');
  }
  const result = { id, digest, bytes };
  if (value.uri != null) {
    const uri = requireBoundedText(value.uri, 'artifact uri', 2048);
    if (!/^(?:https|kneekura-code-lab):/i.test(uri)) {
      throw new TypeError('artifact uri must use https: or kneekura-code-lab:');
    }
    result.uri = uri;
  }
  return deepFreeze(result);
}

function normalizeDigest(value) {
  const text = String(value ?? '').trim().toLowerCase();
  const normalized = text.startsWith('sha256:') ? text : `sha256:${text}`;
  if (!SHA256_DIGEST.test(normalized)) {
    throw new TypeError('artifact digest must be sha256:<64 hex>');
  }
  return normalized;
}

function sanitizeErrorRecord(value) {
  requirePlainRecord(value, 'error');
  return deepFreeze({
    code: sanitizeDiagnosticText(String(value.code ?? 'UNKNOWN'), { maxBytes: 256 }),
    message: sanitizeDiagnosticText(String(value.message ?? ''), { maxBytes: 4096 })
  });
}

function normalizeEnumText(value, choices, label) {
  const text = String(value ?? '').toUpperCase();
  if (!choices.includes(text)) throw new TypeError(`${label} is invalid`);
  return text;
}

function requireBoundedText(value, label, maxLength) {
  const text = String(value ?? '').trim();
  if (!text) throw new TypeError(`${label} must be a non-empty string`);
  if (text.length > maxLength) throw new TypeError(`${label} exceeds ${maxLength} characters`);
  return text;
}

function requirePlainRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Buffer.isBuffer(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function assertOnlyKeys(value, allowed, label) {
  const set = new Set(allowed);
  const unexpected = Object.keys(value).filter(key => !set.has(key));
  if (unexpected.length) {
    throw new TypeError(`${label} contains unsupported field(s): ${unexpected.join(', ')}`);
  }
}

function validateBackendShape(backend) {
  if (backend == null) return;
  requirePlainRecord(backend, 'backend');
  for (const name of ['execute', 'status', 'artifactInfo']) {
    if (backend[name] != null && typeof backend[name] !== 'function') {
      throw new TypeError(`backend.${name} must be a function`);
    }
  }
}

function safeClone(value) {
  if (value == null) return value;
  if (Buffer.isBuffer(value)) {
    throw codedError('RAW_ARTIFACT_FORBIDDEN', 'raw artifact bytes are forbidden in MCP metadata');
  }
  if (Array.isArray(value)) return value.map(safeClone);
  if (typeof value === 'object') {
    const output = {};
    for (const [key, child] of Object.entries(value)) output[key] = safeClone(child);
    return output;
  }
  return value;
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