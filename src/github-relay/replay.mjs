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
  maxRounds = 1024
} = {}) {
  requireBackend(backend);
  const runId = normalizePlanRunId(plan);
  const responseMap = collectResponses(responses, runId);
  const consumed = new Set();

  for (let round = 1; round <= maxRounds; round += 1) {
    try {
      const execution = await backend.execute(plan);
      const unused = [...responseMap.keys()].filter(taskId => !consumed.has(taskId));
      if (unused.length) {
        throw codedError(
          'RELAY_STALE_RESPONSE',
          `relay contains ${unused.length} response(s) that were never requested by this exact replay`
        );
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
        execution: safeClone(execution),
        status: safeClone(status),
        artifacts: safeClone(artifacts)
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
          execution: null,
          status: null,
          artifacts: []
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
    `relay replay exceeded ${maxRounds} rounds`
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
    if (stableRelayJson(existing) !== stableRelayJson(response)) {
      throw codedError(
        'RELAY_RESPONSE_CONFLICT',
        `different relay responses were supplied for ${response.task_id}`
      );
    }
  }
  return byTask;
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

function normalizePlanRunId(plan) {
  const runId = String(plan?.runId ?? '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) {
    throw new TypeError('relay replay plan.runId is invalid');
  }
  return runId;
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
