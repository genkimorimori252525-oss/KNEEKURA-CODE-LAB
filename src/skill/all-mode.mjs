import crypto from 'node:crypto';

import {
  ENGINE_IDS,
  validateEngineRunReceipt
} from './contracts.mjs';
import {
  assertNoEngineSubstitution,
  routeKneekuraCodeLabRequest
} from './router.mjs';
import {
  createSanitizedReceipt,
  createSkillDeliveryZip,
  sanitizeDiagnosticText
} from './runtime.mjs';

export const KNEEKURA_CODE_LAB_EXECUTION_SCHEMA =
  'kneekura.code-lab.execution/v1';
export const KNEEKURA_CODE_LAB_ALL_MODE_SCHEMA =
  'kneekura.code-lab.all-mode-bundle/v1';
export const KNEEKURA_CODE_LAB_COMPARISON_SCHEMA =
  'kneekura.code-lab.operational-comparison/v1';

const ZIP_KIND_BY_ENGINE = Object.freeze({
  kneekura: 'KNEEKURA_HUMAN_EXPLORER_ZIP',
  'understand-anything': 'UA_SKILL_ZIP',
  archify: 'ARCHIFY_SKILL_ZIP'
});

export async function executeKneekuraCodeLabRequest({
  request = {},
  engineRunners = {},
  targetSnapshotId,
  scopeDigest,
  runId
} = {}) {
  const decision = routeKneekuraCodeLabRequest(request);
  if (decision.kind === 'SELECTION_REQUIRED') {
    return deepFreeze({
      schema: KNEEKURA_CODE_LAB_EXECUTION_SCHEMA,
      kind: 'SELECTION_REQUIRED',
      choices: [...decision.choices],
      request: decision.request
    });
  }

  const snapshotId = requireText(targetSnapshotId, 'targetSnapshotId');
  const scope = requireText(scopeDigest, 'scopeDigest');
  const normalizedRunId = requireText(runId, 'runId');
  const requested = [...decision.requestedEngines];
  if (requested.length === 1) {
    return executeDirectEngine({
      engineId: requested[0],
      runner: engineRunners?.[requested[0]],
      request: decision.request,
      snapshotId,
      scopeDigest: scope,
      runId: normalizedRunId
    });
  }
  if (!sameEngineSet(requested, ENGINE_IDS)) {
    throw codedError('ALL_MODE_ENGINE_SET_INVALID', 'all mode must contain exactly the three KNEEKURA Code LAB v1 engines');
  }
  return runAllModeBundle({
    engineRunners,
    request: decision.request,
    snapshotId,
    scopeDigest: scope,
    runId: normalizedRunId
  });
}

async function executeDirectEngine({ engineId, runner, request, snapshotId, scopeDigest, runId }) {
  if (typeof runner !== 'function') {
    throw codedError('ENGINE_RUNNER_REQUIRED', `requested engine runner is unavailable: ${engineId}`);
  }
  const attempt = createAttemptContext(runId, engineId, 1);
  const result = await runner(createRunnerEnvelope({
    engineId,
    request,
    snapshotId,
    scopeDigest,
    attempt
  }));
  const accepted = validateReturnedEngineResult({
    engineId,
    result,
    snapshotId,
    scopeDigest,
    attemptId: attempt.attemptId
  });
  return Object.freeze({
    schema: KNEEKURA_CODE_LAB_EXECUTION_SCHEMA,
    kind: 'ENGINE_RESULT',
    requestedEngine: engineId,
    attempt: deepFreeze({ ...attempt }),
    result,
    sealedArtifact: accepted.sealed == null
      ? null
      : Object.freeze({ digest: accepted.sealed.digest, bytes: accepted.sealed.bytes.length })
  });
}

export async function runAllModeBundle({
  engineRunners = {},
  request = {},
  snapshotId,
  scopeDigest,
  runId
} = {}) {
  const snapshot = requireText(snapshotId, 'snapshotId');
  const scope = requireText(scopeDigest, 'scopeDigest');
  const normalizedRunId = requireText(runId, 'runId');
  const sealedOutcomes = [];

  for (let index = 0; index < ENGINE_IDS.length; index += 1) {
    const engineId = ENGINE_IDS[index];
    const attempt = createAttemptContext(normalizedRunId, engineId, index + 1);
    const runner = engineRunners?.[engineId];
    if (typeof runner !== 'function') {
      sealedOutcomes.push(createHostFailureOutcome({
        engineId,
        attempt,
        status: 'BLOCKED',
        code: 'ENGINE_RUNNER_MISSING',
        message: `all mode runner is unavailable: ${engineId}`
      }));
      continue;
    }

    try {
      const result = await runner(createRunnerEnvelope({
        engineId,
        request,
        snapshotId: snapshot,
        scopeDigest: scope,
        attempt
      }));
      const accepted = validateReturnedEngineResult({
        engineId,
        result,
        snapshotId: snapshot,
        scopeDigest: scope,
        attemptId: attempt.attemptId
      });
      sealedOutcomes.push(createAcceptedOutcome({ engineId, attempt, accepted }));
    } catch (error) {
      const blocked = String(error?.code ?? '') === 'BLOCKED_UNSAFE_HOST';
      sealedOutcomes.push(createHostFailureOutcome({
        engineId,
        attempt,
        status: blocked ? 'BLOCKED' : 'FAILED',
        code: String(error?.code ?? 'ENGINE_EXECUTION_FAILED'),
        message: String(error?.message ?? error)
      }));
    }
  }

  const operationalOutcomes = sealedOutcomes.map(stripPrivateOutcome);
  const status = computeAllModeStatus(operationalOutcomes);
  const comparison = deepFreeze({
    schema: KNEEKURA_CODE_LAB_COMPARISON_SCHEMA,
    mode: 'operational-side-by-side',
    semantic_fusion: false,
    canonical_truth_promotion: false,
    engine_substitution: false,
    snapshot_id: snapshot,
    scope_digest: scope,
    engines: operationalOutcomes.map(outcome => ({
      engine_id: outcome.engine_id,
      status: outcome.status,
      claim_level: outcome.claim_level,
      claim_satisfied: outcome.claim_satisfied,
      sealed_artifact: outcome.sealed_artifact,
      coverage_digest: outcome.coverage_digest,
      error_code: outcome.error?.code ?? null
    }))
  });
  const runManifest = deepFreeze({
    schema: KNEEKURA_CODE_LAB_ALL_MODE_SCHEMA,
    run_id: normalizedRunId,
    snapshot_id: snapshot,
    scope_digest: scope,
    requested_engines: [...ENGINE_IDS],
    status,
    semantic_context_policy: 'fresh-per-engine',
    comparison_policy: 'sealed-operational-metadata-only',
    engines: operationalOutcomes
  });

  const entries = [
    {
      classification: 'RUN_METADATA',
      path: 'run-manifest.json',
      data: stableJson(runManifest)
    },
    {
      classification: 'COMPARISON',
      path: 'comparison/operational.json',
      data: stableJson(comparison)
    }
  ];
  for (const outcome of sealedOutcomes) {
    entries.push({
      classification: 'SANITIZED_RECEIPT',
      path: `engines/${outcome.engine_id}/outcome.json`,
      data: stableJson(stripPrivateOutcome(outcome))
    });
    if (outcome.receipt != null) {
      entries.push({
        classification: 'SANITIZED_RECEIPT',
        path: `engines/${outcome.engine_id}/receipt.json`,
        data: stableJson(outcome.receipt)
      });
    }
    if (outcome.sealed_bytes != null) {
      entries.push({
        classification: 'ENGINE_ARTIFACT',
        path: `engines/${outcome.engine_id}/result.zip`,
        data: outcome.sealed_bytes
      });
    }
  }
  const bundleZip = createSkillDeliveryZip(entries);
  return Object.freeze({
    schema: KNEEKURA_CODE_LAB_EXECUTION_SCHEMA,
    kind: 'ALL_MODE_BUNDLE',
    status,
    snapshotId: snapshot,
    scopeDigest: scope,
    runId: normalizedRunId,
    runManifest,
    comparison,
    outcomes: deepFreeze(operationalOutcomes.map(outcome => structuredClone(outcome))),
    bundleZip,
    bundleZipDigest: `sha256:${sha256(bundleZip)}`
  });
}

function validateReturnedEngineResult({ engineId, result, snapshotId, scopeDigest, attemptId }) {
  if (!result || typeof result !== 'object') {
    throw codedError('ENGINE_RESULT_INVALID', `engine returned no result: ${engineId}`);
  }
  assertNoEngineSubstitution(engineId, result.engineId);
  const receipt = result.receipt;
  validateEngineRunReceipt(receipt);
  assertNoEngineSubstitution(engineId, receipt.engineId);
  if (receipt.snapshotId !== snapshotId) {
    throw codedError('ENGINE_SNAPSHOT_MISMATCH', `${engineId} receipt snapshot does not match all-mode Target Snapshot`);
  }
  if (receipt.scopeDigest !== scopeDigest) {
    throw codedError('ENGINE_SCOPE_MISMATCH', `${engineId} receipt scope does not match all-mode scope`);
  }
  if (receipt.attemptId !== attemptId) {
    throw codedError('ENGINE_ATTEMPT_MISMATCH', `${engineId} receipt attempt does not match assigned Attempt Root`);
  }
  const sealed = resolveSealedEngineZip(engineId, result, receipt);
  if (['SUCCESS', 'PARTIAL'].includes(receipt.status) && sealed == null) {
    throw codedError('ENGINE_SEALED_ARTIFACT_REQUIRED', `${engineId} returned ${receipt.status} without a sealed delivery ZIP`);
  }
  return Object.freeze({ receipt, sealed });
}

function resolveSealedEngineZip(engineId, result, receipt) {
  let bytes = null;
  let claimedDigest = null;
  if (Buffer.isBuffer(result.deliveryZip)) {
    bytes = result.deliveryZip;
    claimedDigest = result.deliveryZipDigest ?? null;
  } else if (Buffer.isBuffer(result.artifact?.zip_bytes)) {
    bytes = result.artifact.zip_bytes;
    claimedDigest = result.artifact.zip_digest ?? null;
  }
  if (bytes == null) return null;
  const computed = `sha256:${sha256(bytes)}`;
  if (claimedDigest != null && normalizeSha256Digest(claimedDigest) !== computed) {
    throw codedError('ENGINE_SEALED_ARTIFACT_DIGEST_MISMATCH', `${engineId} result ZIP digest does not match bytes`);
  }
  const expectedKind = ZIP_KIND_BY_ENGINE[engineId];
  const artifact = receipt.artifacts.find(candidate => candidate?.kind === expectedKind);
  if (!artifact) {
    throw codedError('ENGINE_SEALED_ARTIFACT_RECEIPT_MISSING', `${engineId} receipt does not bind its delivery ZIP`);
  }
  if (normalizeSha256Digest(artifact.digest) !== computed || Number(artifact.bytes) !== bytes.length) {
    throw codedError('ENGINE_SEALED_ARTIFACT_RECEIPT_MISMATCH', `${engineId} receipt ZIP identity does not match sealed bytes`);
  }
  return Object.freeze({ bytes, digest: computed });
}

function createAcceptedOutcome({ engineId, attempt, accepted }) {
  const sanitizedReceipt = createSanitizedReceipt(accepted.receipt);
  const coverageDigest = `sha256:${sha256(Buffer.from(stableJson(sanitizedReceipt.coverage), 'utf8'))}`;
  return {
    engine_id: engineId,
    status: sanitizedReceipt.status,
    claim_level: sanitizedReceipt.claimLevel,
    claim_satisfied: sanitizedReceipt.claimSatisfied,
    attempt_id: attempt.attemptId,
    semantic_context_id: attempt.semanticContextId,
    sealed_artifact: accepted.sealed == null
      ? null
      : { digest: accepted.sealed.digest, bytes: accepted.sealed.bytes.length },
    coverage_digest: coverageDigest,
    error: null,
    receipt: sanitizedReceipt,
    sealed_bytes: accepted.sealed?.bytes ?? null
  };
}

function createHostFailureOutcome({ engineId, attempt, status, code, message }) {
  return {
    engine_id: engineId,
    status,
    claim_level: null,
    claim_satisfied: false,
    attempt_id: attempt.attemptId,
    semantic_context_id: attempt.semanticContextId,
    sealed_artifact: null,
    coverage_digest: null,
    error: {
      code: sanitizeDiagnosticText(code, { maxBytes: 256 }),
      message: sanitizeDiagnosticText(message, { maxBytes: 4096 })
    },
    receipt: null,
    sealed_bytes: null
  };
}

function stripPrivateOutcome(outcome) {
  return deepFreeze({
    engine_id: outcome.engine_id,
    status: outcome.status,
    claim_level: outcome.claim_level,
    claim_satisfied: outcome.claim_satisfied,
    attempt_id: outcome.attempt_id,
    semantic_context_id: outcome.semantic_context_id,
    sealed_artifact: outcome.sealed_artifact == null ? null : { ...outcome.sealed_artifact },
    coverage_digest: outcome.coverage_digest,
    error: outcome.error == null ? null : { ...outcome.error }
  });
}

function createAttemptContext(runId, engineId, ordinal) {
  const token = sha256(Buffer.from(runId, 'utf8')).slice(0, 16);
  return Object.freeze({
    attemptId: `attempt-${token}-${ordinal}-${engineId}`,
    semanticContextId: `context-${token}-${ordinal}-${engineId}`,
    freshSemanticContextRequired: true
  });
}

function createRunnerEnvelope({ engineId, request, snapshotId, scopeDigest, attempt }) {
  return deepFreeze({
    schema: 'kneekura.code-lab.engine-attempt/v1',
    engineId,
    targetSnapshotId: snapshotId,
    scopeDigest,
    attemptId: attempt.attemptId,
    semanticContextId: attempt.semanticContextId,
    freshSemanticContextRequired: true,
    request: structuredClone(request)
  });
}

function computeAllModeStatus(outcomes) {
  if (outcomes.every(outcome => outcome.status === 'SUCCESS' && outcome.claim_satisfied === true)) return 'SUCCESS';
  if (outcomes.some(outcome => ['SUCCESS', 'PARTIAL'].includes(outcome.status))) return 'PARTIAL';
  return 'FAILED';
}

function normalizeSha256Digest(value) {
  const text = String(value ?? '').toLowerCase();
  const normalized = text.startsWith('sha256:') ? text : `sha256:${text}`;
  if (!/^sha256:[0-9a-f]{64}$/.test(normalized)) throw codedError('INVALID_SHA256_DIGEST', `invalid sha256 digest: ${value}`);
  return normalized;
}

function sameEngineSet(left, right) {
  return left.length === right.length && right.every(engine => left.includes(engine));
}

function stableJson(value) {
  return JSON.stringify(sortObject(value), null, 2) + '\n';
}

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (value && typeof value === 'object' && !Buffer.isBuffer(value)) {
    return Object.fromEntries(Object.keys(value).sort(compareText).map(key => [key, sortObject(value[key])]));
  }
  return value;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function requireText(value, label) {
  const text = String(value ?? '').trim();
  if (!text) throw new TypeError(`${label} must be a non-empty string`);
  return text;
}

function compareText(a, b) {
  const left = String(a);
  const right = String(b);
  return left < right ? -1 : left > right ? 1 : 0;
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