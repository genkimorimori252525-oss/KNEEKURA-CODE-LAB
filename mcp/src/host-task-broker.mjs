import {
  DEFAULT_HOST_BRIDGE_LIMITS,
  HOST_BRIDGE_STATE_SCHEMA,
  HostTaskRequiredError,
  createHostResponseRecord,
  createHostTask,
  hostResponseValue,
  validateHostResponseForTask
} from './host-bridge-contract.mjs';

export function createHostResponseLedger({
  records = [],
  limits = DEFAULT_HOST_BRIDGE_LIMITS
} = {}) {
  const byTask = new Map();
  let storedBytes = 0;

  for (const record of records) {
    const taskId = String(record?.task_id ?? '');
    if (!/^task:sha256:[0-9a-f]{64}$/.test(taskId)) {
      throw new TypeError('host response ledger contains an invalid task id');
    }
    if (byTask.has(taskId)) {
      throw codedError('HOST_RESPONSE_DUPLICATE', `duplicate host response record: ${taskId}`);
    }
    const bytes = Number(record?.response_bytes);
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new TypeError('host response ledger contains an invalid response byte count');
    }
    storedBytes += bytes;
    byTask.set(taskId, structuredClone(record));
  }
  assertStoredBudget(storedBytes, limits);

  return Object.freeze({
    get(task) {
      const record = byTask.get(String(task?.task_id ?? ''));
      if (!record) return null;
      validateHostResponseForTask(task, record, limits);
      return structuredClone(record);
    },

    accept(task, response) {
      const record = createHostResponseRecord({ task, response, limits });
      const existing = byTask.get(task.task_id);
      if (existing) {
        validateHostResponseForTask(task, existing, limits);
        if (existing.response_digest !== record.response_digest) {
          throw codedError(
            'HOST_RESPONSE_CONFLICT',
            'a different response is already accepted for this exact host task'
          );
        }
        return structuredClone(existing);
      }
      const nextBytes = storedBytes + record.response_bytes;
      assertStoredBudget(nextBytes, limits);
      byTask.set(task.task_id, structuredClone(record));
      storedBytes = nextBytes;
      return structuredClone(record);
    },

    has(taskId) {
      return byTask.has(String(taskId ?? ''));
    },

    exportRecords() {
      return [...byTask.values()]
        .sort((a, b) => Number(a.ordinal) - Number(b.ordinal) || compareText(a.task_id, b.task_id))
        .map(record => structuredClone(record));
    },

    summary() {
      return Object.freeze({
        schema: HOST_BRIDGE_STATE_SCHEMA,
        accepted_response_count: byTask.size,
        accepted_response_bytes: storedBytes,
        max_stored_response_bytes: limits.maxStoredResponseBytes
      });
    }
  });
}

export function createHostReplayBroker({
  runId,
  engineId,
  attemptId,
  snapshotId,
  scopeDigest,
  ledger,
  projectPayload = defaultProjectPayload,
  limits = DEFAULT_HOST_BRIDGE_LIMITS
} = {}) {
  if (!ledger || typeof ledger.get !== 'function' || typeof ledger.accept !== 'function') {
    throw new TypeError('host replay broker requires a response ledger');
  }
  if (typeof projectPayload !== 'function') {
    throw new TypeError('projectPayload must be a function');
  }

  let ordinal = 0;
  let pending = null;

  return Object.freeze({
    async request(kind, privatePayload) {
      ordinal += 1;
      const publicPayload = await projectPayload(kind, privatePayload, {
        ordinal,
        engineId,
        runId,
        attemptId,
        snapshotId,
        scopeDigest
      });
      const task = createHostTask({
        runId,
        engineId,
        attemptId,
        snapshotId,
        scopeDigest,
        ordinal,
        kind,
        payload: publicPayload,
        limits
      });
      const accepted = ledger.get(task);
      if (accepted) {
        return hostResponseValue(task, accepted, limits);
      }
      pending = task;
      throw new HostTaskRequiredError(task);
    },

    pendingTask() {
      return pending == null ? null : structuredClone(pending);
    },

    acceptPending(taskId, response) {
      if (!pending) {
        throw codedError('HOST_TASK_NOT_PENDING', 'no host task is pending for this replay');
      }
      if (String(taskId ?? '') !== pending.task_id) {
        throw codedError('HOST_TASK_NOT_PENDING', 'host response task id is not the current pending task');
      }
      return ledger.accept(pending, response);
    },

    replaySummary() {
      return Object.freeze({
        schema: HOST_BRIDGE_STATE_SCHEMA,
        run_id: runId,
        engine_id: engineId,
        attempt_id: attemptId,
        snapshot_id: snapshotId,
        scope_digest: scopeDigest,
        replayed_or_requested_tasks: ordinal,
        pending_task_id: pending?.task_id ?? null,
        ledger: ledger.summary()
      });
    }
  });
}

export function acceptHostResponseForPendingTask({
  pendingTask,
  taskId,
  response,
  ledger,
  limits = DEFAULT_HOST_BRIDGE_LIMITS
} = {}) {
  if (!pendingTask) {
    throw codedError('HOST_TASK_NOT_PENDING', 'no host task is pending');
  }
  if (String(taskId ?? '') !== pendingTask.task_id) {
    throw codedError('HOST_TASK_NOT_PENDING', 'host response does not identify the pending task');
  }
  if (!ledger || typeof ledger.accept !== 'function') {
    throw new TypeError('host response ledger is required');
  }
  return ledger.accept(pendingTask, response, limits);
}

function defaultProjectPayload(_kind, payload) {
  return structuredClone(payload);
}

function assertStoredBudget(bytes, limits) {
  if (bytes > limits.maxStoredResponseBytes) {
    throw codedError(
      'HOST_RESPONSE_LEDGER_TOO_LARGE',
      `stored host responses exceed ${limits.maxStoredResponseBytes} bytes`
    );
  }
}

function compareText(a, b) {
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}