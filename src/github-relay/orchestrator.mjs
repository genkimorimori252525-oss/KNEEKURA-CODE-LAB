import crypto from 'node:crypto';
import path from 'node:path';

import { resolveRepositoryIdentity } from '../core/identity/repository.mjs';
import { createCommitSnapshot } from '../core/identity/snapshot.mjs';
import { planKneekuraCodeLabMcpRequest } from '../../mcp/src/adapter.mjs';
import {
  GITHUB_RELAY_SCHEMAS,
  stableRelayJson,
  validateRelayPlan,
  validateRelayRequest
} from './contracts.mjs';
import {
  relayEnvelopeDigest
} from './issue-transport.mjs';
import { replayGithubRelayRun } from './replay.mjs';

export async function createGithubRelayExecutionContext({
  request,
  issueNumber,
  targetRoot,
  codeLabRevision,
  engineLockDigest
} = {}) {
  const normalizedRequest = validateRelayRequest(request);
  const issue = normalizeIssueNumber(issueNumber);
  const root = path.resolve(String(targetRoot ?? ''));
  const revision = normalizeRevision(codeLabRevision, 'codeLabRevision');
  const lockDigest = normalizeDigest(engineLockDigest, 'engineLockDigest');

  const repository = await resolveRepositoryIdentity(root);
  const expectedIdentity = `git:github.com/${normalizedRequest.target.repository.toLowerCase()}`;
  if (repository.vcs !== 'git' || repository.canonical_identity !== expectedIdentity) {
    throw codedError(
      'RELAY_TARGET_IDENTITY_MISMATCH',
      'materialized relay target does not match the requested GitHub repository identity'
    );
  }

  const snapshot = createCommitSnapshot(repository, normalizedRequest.target.revision);
  const scopeDigest = relayScopeDigest(normalizedRequest);
  const runId = createRelayRunId(issue, normalizedRequest.target.revision, scopeDigest);
  const mcpPlan = planKneekuraCodeLabMcpRequest({
    selection: normalizedRequest.selection,
    runId,
    target: {
      repository: root,
      revision: normalizedRequest.target.revision,
      snapshotId: snapshot.snapshot_id,
      scopeDigest
    },
    commonScope: normalizedRequest.commonScope,
    engineOptions: normalizedRequest.engineOptions,
    minimumClaimLevel: normalizedRequest.minimumClaimLevel
  });
  if (mcpPlan.kind !== 'RUN') {
    throw codedError('RELAY_ENGINE_SELECTION_INVALID', 'relay request did not resolve to an executable engine selection');
  }

  const relayPlan = validateRelayPlan({
    schema: GITHUB_RELAY_SCHEMAS.plan,
    run_id: runId,
    selection: normalizedRequest.selection,
    target: {
      repository: normalizedRequest.target.repository,
      revision: normalizedRequest.target.revision,
      snapshot_id: snapshot.snapshot_id,
      scope_digest: scopeDigest
    },
    semantic_context_mode: normalizedRequest.semanticContextMode,
    code_lab_revision: revision,
    engine_lock_digest: lockDigest
  });

  return Object.freeze({
    request: normalizedRequest,
    repository,
    snapshot,
    scopeDigest,
    runId,
    mcpPlan,
    relayPlan
  });
}

export async function runGithubRelayTurn({
  request,
  issueNumber,
  targetRoot,
  codeLabRevision,
  engineLockDigest,
  backend,
  responses = [],
  sourceRequests = [],
  existingPlan = null,
  existingTaskIds = new Set(),
  existingSourceResultDigests = new Set(),
  existingResultRunIds = new Set(),
  onComplete = null
} = {}) {
  const context = await createGithubRelayExecutionContext({
    request,
    issueNumber,
    targetRoot,
    codeLabRevision,
    engineLockDigest
  });
  assertPlanContinuity(existingPlan, context.relayPlan);

  const responseEnvelopes = normalizeEntryEnvelopes(responses);
  const respondedTaskBindings = new Set(responseEnvelopes.map(response =>
    sourceTaskBindingKey(response.run_id, response.task_id)
  ));
  const sourceEntries = normalizeSourceEntries(sourceRequests);
  const activeSourceEntries = sourceEntries.filter(entry =>
    !respondedTaskBindings.has(sourceTaskBindingKey(
      entry.envelope.run_id,
      entry.envelope.task_id
    ))
  );
  const taskIds = normalizeStringSet(existingTaskIds, 'existingTaskIds');
  const sourceDigests = normalizeStringSet(existingSourceResultDigests, 'existingSourceResultDigests');
  const resultRunIds = normalizeStringSet(existingResultRunIds, 'existingResultRunIds');

  const replay = await replayGithubRelayRun({
    plan: context.mcpPlan,
    backend,
    responses: responseEnvelopes,
    onComplete
  });

  const actions = [];
  if (!existingPlan) {
    actions.push(Object.freeze({ kind: 'PLAN', envelope: context.relayPlan }));
  }

  if (replay.state === 'TASK_REQUIRED') {
    const task = replay.pending_task.task;
    const pendingSource = findPendingSourceRequest({
      runId: context.runId,
      taskId: task.task_id,
      sourceEntries: activeSourceEntries,
      servedDigests: sourceDigests
    });
    if (pendingSource) {
      if (typeof backend?.readSource !== 'function') {
        throw codedError('BLOCKED_RELAY_SOURCE_BACKEND_UNAVAILABLE', 'relay backend does not expose bounded source reads');
      }
      const source = await backend.readSource(
        context.runId,
        task.task_id,
        {
          path: pendingSource.envelope.path,
          startLine: pendingSource.envelope.start_line,
          endLine: pendingSource.envelope.end_line
        }
      );
      if (source?.instruction_authority !== false || source?.trust_class !== 'UNTRUSTED_REPOSITORY_DATA') {
        throw codedError('RELAY_SOURCE_TRUST_BOUNDARY_INVALID', 'Host Bridge source read did not preserve untrusted-data metadata');
      }
      actions.push(Object.freeze({
        kind: 'SOURCE_RESULT',
        envelope: deepFreeze({
          schema: GITHUB_RELAY_SCHEMAS.sourceResult,
          run_id: context.runId,
          task_id: task.task_id,
          source_request_digest: pendingSource.digest,
          source
        })
      }));
      return freezeTurn(context, replay, actions);
    }

    const unservedForeign = firstUnservedSourceRequest(activeSourceEntries, sourceDigests);
    if (unservedForeign) {
      throw codedError(
        'RELAY_SOURCE_REQUEST_OUT_OF_ORDER',
        'source request does not identify the current pending Host Task'
      );
    }

    if (!taskIds.has(task.task_id)) {
      actions.push(Object.freeze({ kind: 'TASK', envelope: replay.pending_task }));
    }
    return freezeTurn(context, replay, actions);
  }

  if (replay.state !== 'COMPLETE') {
    throw codedError('RELAY_REPLAY_STATE_INVALID', `unsupported relay replay state: ${replay.state}`);
  }

  if (!resultRunIds.has(context.runId)) {
    actions.push(Object.freeze({
      kind: 'RESULT',
      envelope: deepFreeze({
        schema: GITHUB_RELAY_SCHEMAS.result,
        run_id: context.runId,
        status: replay.terminal?.status ?? 'UNKNOWN',
        target: context.relayPlan.target,
        code_lab_revision: context.relayPlan.code_lab_revision,
        engine_lock_digest: context.relayPlan.engine_lock_digest,
        terminal: replay.terminal,
        artifacts: replay.artifacts,
        artifact_bytes_exposed: false
      })
    }));
  }

  return freezeTurn(context, replay, actions);
}

export function relayScopeDigest(request) {
  const normalized = validateRelayRequest(request);
  const payload = {
    schema: GITHUB_RELAY_SCHEMAS.request,
    selection: normalized.selection,
    commonScope: normalized.commonScope,
    engineOptions: normalized.engineOptions,
    minimumClaimLevel: normalized.minimumClaimLevel,
    semanticContextMode: normalized.semanticContextMode
  };
  return `sha256:${crypto.createHash('sha256')
    .update('kneekura.github-relay.scope/v1\0')
    .update(stableRelayJson(payload))
    .digest('hex')}`;
}

export function createRelayRunId(issueNumber, revision, scopeDigest) {
  const issue = normalizeIssueNumber(issueNumber);
  const exactRevision = normalizeRevision(revision, 'revision');
  const scope = normalizeDigest(scopeDigest, 'scopeDigest').slice('sha256:'.length);
  return `ghr-${issue}-${exactRevision.slice(0, 12)}-${scope.slice(0, 12)}`;
}

export function sealedArtifactBytes(execution) {
  if (execution?.kind === 'ALL_MODE_BUNDLE' && Buffer.isBuffer(execution.bundleZip)) {
    return Buffer.from(execution.bundleZip);
  }
  if (execution?.kind === 'ENGINE_RESULT') {
    if (Buffer.isBuffer(execution?.result?.deliveryZip)) {
      return Buffer.from(execution.result.deliveryZip);
    }
    if (Buffer.isBuffer(execution?.result?.artifact?.zip_bytes)) {
      return Buffer.from(execution.result.artifact.zip_bytes);
    }
  }
  return null;
}

function findPendingSourceRequest({ runId, taskId, sourceEntries, servedDigests }) {
  for (let index = sourceEntries.length - 1; index >= 0; index -= 1) {
    const entry = sourceEntries[index];
    if (servedDigests.has(entry.digest)) continue;
    if (entry.envelope.run_id === runId && entry.envelope.task_id === taskId) return entry;
  }
  return null;
}

function firstUnservedSourceRequest(entries, servedDigests) {
  return entries.find(entry => !servedDigests.has(entry.digest)) ?? null;
}

function sourceTaskBindingKey(runId, taskId) {
  return `${String(runId ?? '')}\0${String(taskId ?? '')}`;
}

function normalizeSourceEntries(values) {
  if (!Array.isArray(values)) throw new TypeError('sourceRequests must be an array');
  return values.map(value => {
    const envelope = value?.envelope ?? value;
    return {
      envelope,
      digest: relayEnvelopeDigest(envelope)
    };
  });
}

function normalizeEntryEnvelopes(values) {
  if (!Array.isArray(values)) throw new TypeError('responses must be an array');
  return values.map(value => value?.envelope ?? value);
}

function assertPlanContinuity(existing, expected) {
  if (!existing) return;
  if (stableRelayJson(existing) !== stableRelayJson(expected)) {
    throw codedError(
      'RELAY_PLAN_CONFLICT',
      'existing Issue plan does not match the exact request/runtime binding for this turn'
    );
  }
}

function normalizeStringSet(value, label) {
  if (!(value instanceof Set)) throw new TypeError(`${label} must be a Set`);
  return new Set([...value].map(item => String(item)));
}

function freezeTurn(context, replay, actions) {
  return deepFreeze({
    schema: 'kneekura.code-lab.github-relay-turn/v1',
    run_id: context.runId,
    relay_plan: context.relayPlan,
    replay,
    actions
  });
}

function normalizeIssueNumber(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new TypeError('issueNumber must be a positive safe integer');
  return number;
}

function normalizeRevision(value, label) {
  const revision = String(value ?? '').trim().toLowerCase();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(revision)) {
    throw new TypeError(`${label} must be an exact Git revision`);
  }
  return revision;
}

function normalizeDigest(value, label) {
  const digest = String(value ?? '').trim().toLowerCase();
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw new TypeError(`${label} must be sha256:<64 hex>`);
  return digest;
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
