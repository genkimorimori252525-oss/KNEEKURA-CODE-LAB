import crypto from 'node:crypto';

import {
  executeKneekuraCodeLabRequest,
  sanitizeDiagnosticText
} from '../../src/skill/index.mjs';

export function createInProcessKneekuraCodeLabBackend({
  createEngineRunners
} = {}) {
  if (typeof createEngineRunners !== 'function') {
    throw new TypeError('createEngineRunners must be a function');
  }

  const runs = new Map();
  const artifacts = new Map();

  return Object.freeze({
    async execute(plan) {
      if (runs.has(plan.runId)) {
        throw codedError(
          'RUN_ID_ALREADY_EXISTS',
          `runId already exists: ${plan.runId}`
        );
      }
      runs.set(plan.runId, freezeStatus({
        phase: 'RUNNING',
        summary: 'KNEEKURA Code LAB execution is running.',
        artifacts: []
      }));

      try {
        const engineRunners = await createEngineRunners({
          runId: plan.runId,
          target: structuredClone(plan.target),
          requestedEngines: [...plan.requestedEngines],
          runtimeRequest: structuredClone(plan.runtimeRequest),
          normalizedRequest: structuredClone(plan.normalizedRequest)
        });
        requireRunnerMap(engineRunners);

        const execution = await executeKneekuraCodeLabRequest({
          request: plan.runtimeRequest,
          engineRunners,
          targetSnapshotId: plan.target.snapshotId,
          scopeDigest: plan.target.scopeDigest,
          runId: plan.runId
        });
        if (execution.kind === 'SELECTION_REQUIRED') {
          throw codedError(
            'BACKEND_PLAN_DIVERGENCE',
            'validated RUN plan unexpectedly returned SELECTION_REQUIRED'
          );
        }

        const runArtifacts = captureArtifacts(plan.runId, execution, artifacts);
        runs.set(plan.runId, freezeStatus({
          phase: 'COMPLETE',
          summary: execution.kind === 'ALL_MODE_BUNDLE'
            ? `All-mode finished with status ${execution.status}.`
            : `Engine ${execution.requestedEngine} finished with status ${execution.result?.receipt?.status ?? 'UNKNOWN'}.`,
          artifacts: runArtifacts.map(stripBytes)
        }));
        return execution;
      } catch (error) {
        runs.set(plan.runId, freezeStatus({
          phase: String(error?.code ?? '').startsWith('BLOCKED_')
            ? 'BLOCKED'
            : 'FAILED',
          summary: 'KNEEKURA Code LAB execution did not complete successfully.',
          error: {
            code: sanitizeDiagnosticText(String(error?.code ?? 'ENGINE_EXECUTION_FAILED'), { maxBytes: 256 }),
            message: sanitizeDiagnosticText(String(error?.message ?? error), { maxBytes: 4096 })
          },
          artifacts: []
        }));
        throw error;
      }
    },

    async status(runId) {
      const value = runs.get(runId);
      return value == null ? null : structuredClone(value);
    },

    async artifactInfo(runId, artifactId = null) {
      const runArtifacts = artifacts.get(runId) ?? [];
      const values = artifactId == null
        ? runArtifacts
        : runArtifacts.filter(item => item.id === artifactId);
      return values.map(stripBytes);
    },

    async readArtifact(runId, artifactId) {
      const item = (artifacts.get(runId) ?? [])
        .find(candidate => candidate.id === artifactId);
      if (!item) return null;
      return Buffer.from(item.bytes_buffer);
    }
  });
}

function captureArtifacts(runId, execution, store) {
  const rows = [];

  if (execution.kind === 'ENGINE_RESULT') {
    const engineId = execution.requestedEngine;
    const bytes = resolveDirectZip(execution.result);
    if (bytes) {
      rows.push({
        id: `${engineId}:result.zip`,
        digest: `sha256:${sha256(bytes)}`,
        bytes: bytes.length,
        bytes_buffer: Buffer.from(bytes)
      });
    }
  } else if (
    execution.kind === 'ALL_MODE_BUNDLE' &&
    Buffer.isBuffer(execution.bundleZip)
  ) {
    rows.push({
      id: 'all:bundle.zip',
      digest: `sha256:${sha256(execution.bundleZip)}`,
      bytes: execution.bundleZip.length,
      bytes_buffer: Buffer.from(execution.bundleZip)
    });
  }

  store.set(runId, rows);
  return rows;
}

function resolveDirectZip(result) {
  if (Buffer.isBuffer(result?.deliveryZip)) return result.deliveryZip;
  if (Buffer.isBuffer(result?.artifact?.zip_bytes)) return result.artifact.zip_bytes;
  return null;
}

function stripBytes(value) {
  return {
    id: value.id,
    digest: value.digest,
    bytes: value.bytes
  };
}

function freezeStatus(value) {
  const cloned = structuredClone(value);
  deepFreeze(cloned);
  return cloned;
}

function requireRunnerMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('createEngineRunners must return an object');
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
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