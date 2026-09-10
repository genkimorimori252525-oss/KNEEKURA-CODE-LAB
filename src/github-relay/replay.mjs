import {
  GITHUB_RELAY_SCHEMAS,
  assertRelayResponseMatchesTask,
  createRelayTaskEnvelope,
  stableRelayJson,
  validateRelayResponseEnvelope
} from './contracts.mjs';

export async function replayGithubRelayRun({
  plan,
  backend,
  responses = [],
  maxRounds = 1024,
  onComplete = null
} = {}) {
  requireBackend(backend);
  requireCompletionHook(onComplete);
  const runId = normalizePlanRunId(plan);
  const roundLimit = normalizeRoundLimit(maxRounds);
  const responseMap = collectResponses(responses, runId);
  const consumed = new Set();

  for (let round = 1; round <= roundLimit; round += 1) {
    try {
      const execution = await backend.execute(plan);
      const unused = [...responseMap.keys()].filter(taskId => !consumed.has(taskId));
      if (unused.length) {
        throw codedError(
          'RELAY_STALE_RESPONSE',
          `relay contains ${unused.length} response(s) that were never requested by this exact replay`
        );
      }

      if (onComplete) {
        await onComplete(execution);
      }

      const status = typeof backend.status === 'function'
        ? await backend.status(runId)
        : null;
      const artifacts = typeof backend.artifactInfo === 'function'
        ? await backend.artifactInfo(runId, null)
        : [];

      return deepFreeze({
        schema: GITHUB_RELAY_SCHEMAS.replayState,
        state: 'COMPLETE',
        run_id: runId,
        rounds: round,
        consumed_response_count: consumed.size,
        pending_task: null,
        terminal: projectTerminalExecution(execution),
        status: safeClone(status),
        artifacts: safeClone(artifacts),
        artifact_bytes_exposed: false
      });
    } catch (error) {
      if (String(error?.code ?? '') !== 'HOST_TASK_REQUIRED' || !error?.task) {
        throw error;
      }

      const taskEnvelope = createRelayTaskEnvelope(error.task);
      if (taskEnvelope.run_id !== runId) {
        throw codedError(
          'RELAY_TASK_BINDING_MISMATCH',
          'pending Host Task belongs to another relay run'
        );
      }

      const stored = responseMap.get(error.task.task_id);
      if (!stored) {
        const unexpected = [...responseMap.keys()].find(
          taskId => !consumed.has(taskId)
        );
        if (unexpected) {
          throw codedError(
            'RELAY_RESPONSE_OUT_OF_ORDER',
            `relay response ${unexpected} does not match the current pending Host Task`
          );
        }
        return deepFreeze({
          schema: GITHUB_RELAY_SCHEMAS.replayState,
          state: 'TASK_REQUIRED',
          run_id: runId,
          rounds: round,
          consumed_response_count: consumed.size,
          pending_task: taskEnvelope,
          terminal: null,
          status: null,
          artifacts: [],
          artifact_bytes_exposed: false
        });
      }

      const response = assertRelayResponseMatchesTask(stored, error.task);
      await backend.acceptHostResponse(
        runId,
        error.task.task_id,
        safeClone(response.response)
      );
      consumed.add(error.task.task_id);
    }
  }

  throw codedError(
    'RELAY_REPLAY_ROUND_LIMIT',
    `relay replay exceeded ${roundLimit} rounds`
  );
}

function collectResponses(responses, runId) {
  if (!Array.isArray(responses)) {
    throw new TypeError('relay responses must be an array');
  }
  const byTask = new Map();
  for (const value of responses) {
    const response = validateRelayResponseEnvelope(value);
    if (response.run_id !== runId) {
      throw codedError(
        'RELAY_RESPONSE_BINDING_MISMATCH',
        'relay response belongs to another run'
      );
    }
    const existing = byTask.get(response.task_id);
    if (!existing) {
      byTask.set(response.task_id, response);
      continue;
    }
    if (stableRelayJson(responseBinding(existing)) !== stableRelayJson(responseBinding(response))) {
      throw codedError(
        'RELAY_RESPONSE_CONFLICT',
        `different relay response bindings were supplied for ${response.task_id}`
      );
    }
    byTask.set(response.task_id, response);
  }
  return byTask;
}

function responseBinding(response) {
  const binding = { ...response };
  delete binding.response;
  return binding;
}

function projectTerminalExecution(execution) {
  const kind = String(execution?.kind ?? '').trim();
  if (!kind) {
    throw codedError(
      'RELAY_TERMINAL_EXECUTION_INVALID',
      'terminal execution kind is missing'
    );
  }
  if (kind === 'ENGINE_RESULT') {
    return {
      kind,
      requested_engine: execution.requestedEngine == null
        ? null
        : String(execution.requestedEngine),
      status: String(
        execution?.result?.receipt?.status ??
        execution?.result?.status ??
        'SUCCESS'
      )
    };
  }
  if (kind === 'ALL_MODE_BUNDLE') {
    return {
      kind,
      requested_engine: null,
      status: String(execution.status ?? ''),
      bundle_digest: normalizeOptionalDigest(execution.bundleZipDigest)
    };
  }
  throw codedError(
    'RELAY_TERMINAL_EXECUTION_INVALID',
    `unsupported terminal execution kind: ${kind}`
  );
}

function normalizeOptionalDigest(value) {
  if (value == null) return null;
  const digest = String(value).trim().toLowerCase();
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) {
    throw new TypeError('terminal bundle digest must be sha256:<64 hex>');
  }
  return digest;
}

function requireBackend(backend) {
  if (
    !backend ||
    typeof backend.execute !== 'function' ||
    typeof backend.acceptHostResponse !== 'function'
  ) {
    throw new TypeError(
      'GitHub Relay replay requires execute() and acceptHostResponse() backend methods'
    );
  }
}

function requireCompletionHook(onComplete) {
  if (onComplete != null && typeof onComplete !== 'function') {
    throw new TypeError('relay onComplete must be a function when provided');
  }
}

function normalizePlanRunId(plan) {
  const runId = String(plan?.runId ?? '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) {
    throw new TypeError('relay replay plan.runId is invalid');
  }
  return runId;
}

function normalizeRoundLimit(value) {
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 4096) {
    throw new TypeError('relay maxRounds must be an integer from 1 to 4096');
  }
  return limit;
}

function safeClone(value) {
  if (value == null) return value;
  try {
    return structuredClone(value);
  } catch (error) {
    throw new TypeError(`relay replay value must be structured-cloneable: ${error.message}`);
  }
}

function deepFreeze(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Object.isFrozen(value) ||
    ArrayBuffer.isView(value)
  ) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
