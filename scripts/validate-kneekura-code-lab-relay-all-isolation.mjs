import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  ALL_CONTEXT_ASSURANCE_CLASS,
  ALL_CONTEXT_CLAIM_SCHEMA,
  GITHUB_RELAY_SCHEMAS,
  assertDistinctAllContextClaims,
  createAllChildBindings,
  createRelayRunId,
  runGithubRelayTurn
} from '../src/github-relay/index.mjs';
import { composeVerifiedAllChildResults } from '../src/github-relay/all-mode-composition.mjs';
import { createChildResultManifest } from '../src/github-relay/child-result-manifest.mjs';
import {
  assertRelayResponseMatchesTask,
  validateRelayResponseEnvelope,
  validateRelaySourceRequest
} from '../src/github-relay/contracts.mjs';
import { createEngineRunReceipt } from '../src/skill/contracts.mjs';
import {
  HostTaskRequiredError,
  createHostTask
} from '../mcp/src/host-bridge-contract.mjs';

const TARGET = 'genkimorimori252525-oss/KNEEKURA-LAB';
const TARGET_REVISION = 'a'.repeat(40);
const CODE_LAB_REVISION = 'd'.repeat(40);
const ENGINE_LOCK_DIGEST = `sha256:${'e'.repeat(64)}`;
const PARENT_ISSUE = 500;
const CHILD_ISSUES = Object.freeze([501, 502, 503]);
const ENGINES = Object.freeze(['kneekura', 'understand-anything', 'archify']);
const ZIP_KIND = Object.freeze({
  kneekura: 'KNEEKURA_HUMAN_EXPLORER_ZIP',
  'understand-anything': 'UA_SKILL_ZIP',
  archify: 'ARCHIFY_SKILL_ZIP'
});

const parentRequest = Object.freeze({
  schema: GITHUB_RELAY_SCHEMAS.request,
  selection: 'all',
  target: { repository: TARGET, revision: TARGET_REVISION },
  commonScope: { question: 'Explain this exact snapshot independently.' },
  engineOptions: {},
  minimumClaimLevel: {},
  semanticContextMode: 'per-engine'
});

const fixture = await makeTargetFixture();
try {
  let parentBackendCalls = 0;
  const parentBackend = {
    async execute() { parentBackendCalls += 1; throw new Error('ALL parent must not execute semantic backend'); },
    async acceptHostResponse() { parentBackendCalls += 1; throw new Error('ALL parent must not accept semantic responses'); },
    async readSource() { parentBackendCalls += 1; throw new Error('ALL parent must not read semantic sources'); }
  };

  const parentTurn = await runGithubRelayTurn({
    request: parentRequest,
    issueNumber: PARENT_ISSUE,
    targetRoot: fixture.root,
    codeLabRevision: CODE_LAB_REVISION,
    engineLockDigest: ENGINE_LOCK_DIGEST,
    backend: parentBackend
  });
  const parentSemanticTaskCount = parentTurn.actions.filter(row => row.kind === 'TASK').length;

  const slots = createAllChildBindings({
    parentRunId: parentTurn.run_id,
    parentIssueNumber: PARENT_ISSUE,
    request: parentRequest,
    relayPlan: parentTurn.relay_plan
  });
  const bindings = slots.map((slot, index) => Object.freeze({
    ...slot,
    child_issue_number: CHILD_ISSUES[index]
  }));
  const claims = bindings.map((binding, index) => Object.freeze({
    schema: ALL_CONTEXT_CLAIM_SCHEMA,
    parent_run_id: binding.parent_run_id,
    parent_issue_number: binding.parent_issue_number,
    child_issue_number: binding.child_issue_number,
    engine_id: binding.engine_id,
    host_context_id: `fixture-host-context-${index + 1}`,
    assurance_class: ALL_CONTEXT_ASSURANCE_CLASS
  }));
  const contextIdsDistinct = assertDistinctAllContextClaims(claims) === true;

  const taskFixtures = [];
  for (let index = 0; index < 2; index += 1) {
    const binding = bindings[index];
    const claim = claims[index];
    const request = childRequest(binding.engine_id);
    const backend = createPendingTaskBackend(binding.engine_id);
    const turn = await runGithubRelayTurn({
      request,
      issueNumber: binding.child_issue_number,
      targetRoot: fixture.root,
      codeLabRevision: CODE_LAB_REVISION,
      engineLockDigest: ENGINE_LOCK_DIGEST,
      backend,
      allChildBinding: binding,
      allContextClaim: claim
    });
    const task = turn.actions.find(row => row.kind === 'TASK')?.envelope?.task;
    if (!task) throw new Error(`fixture child ${binding.engine_id} did not emit one Host Task`);
    taskFixtures.push({ binding, claim, request, task });
  }

  const responseA = responseFor(taskFixtures[0].task);
  const crossChildResponseRejected = rejectedWithCode(
    () => assertRelayResponseMatchesTask(responseA, taskFixtures[1].task),
    'RELAY_RESPONSE_BINDING_MISMATCH'
  );

  const foreignSourceRequest = sourceRequestFor(taskFixtures[0].task);
  const crossChildSourceRequestRejected = await rejectedAsyncWithCode(
    () => runGithubRelayTurn({
      request: taskFixtures[1].request,
      issueNumber: taskFixtures[1].binding.child_issue_number,
      targetRoot: fixture.root,
      codeLabRevision: CODE_LAB_REVISION,
      engineLockDigest: ENGINE_LOCK_DIGEST,
      backend: createPendingTaskBackend(taskFixtures[1].binding.engine_id),
      allChildBinding: taskFixtures[1].binding,
      allContextClaim: taskFixtures[1].claim,
      sourceRequests: [foreignSourceRequest]
    }),
    'RELAY_SOURCE_REQUEST_OUT_OF_ORDER'
  );

  const childInputs = bindings.map((binding, index) => {
    const sealedBytes = Buffer.from(`sealed-fixture-${binding.engine_id}-v1`, 'utf8');
    const digest = `sha256:${crypto.createHash('sha256').update(sealedBytes).digest('hex')}`;
    const receipt = createEngineRunReceipt({
      engineId: binding.engine_id,
      implementationOrigin: binding.engine_id === 'kneekura' ? 'first-party' : 'pinned-upstream',
      implementationVersion: 'fixture-v1',
      orchestrationMode: binding.engine_id === 'kneekura' ? 'native' : 'portable-compatible',
      snapshotId: binding.target.snapshot_id,
      scopeDigest: binding.scope_digest,
      attemptId: `attempt-fixture-${index + 1}`,
      status: 'SUCCESS',
      claimLevel: 'NATIVE',
      claimSatisfied: true,
      acceptance: { fixture: true },
      coverage: { fixture_engine: binding.engine_id },
      artifacts: [{ kind: ZIP_KIND[binding.engine_id], digest, bytes: sealedBytes.length }],
      warnings: [],
      errors: []
    });
    const relayResult = {
      schema: GITHUB_RELAY_SCHEMAS.result,
      run_id: createRelayRunId(binding.child_issue_number, binding.target.revision, binding.scope_digest),
      status: 'SUCCESS',
      target: { ...binding.target },
      code_lab_revision: binding.code_lab_revision,
      engine_lock_digest: binding.engine_lock_digest,
      terminal: { kind: 'ENGINE_RESULT', status: 'SUCCESS' },
      artifacts: [],
      artifact_bytes_exposed: false
    };
    const manifest = createChildResultManifest({
      binding,
      contextClaim: claims[index],
      relayResult,
      receipt,
      sealedBytes
    });
    return {
      manifest,
      receipt,
      sealedBytes,
      expectedBinding: binding,
      expectedContextClaim: claims[index]
    };
  });

  const composedA = composeVerifiedAllChildResults({
    parentPlan: parentTurn.relay_plan,
    childInputs
  });
  const composedB = composeVerifiedAllChildResults({
    parentPlan: parentTurn.relay_plan,
    childInputs
  });

  const sameSnapshot = childInputs.every(row =>
    row.manifest.target.snapshot_id === parentTurn.relay_plan.target.snapshot_id
  );
  const sameScope = childInputs.every(row =>
    row.manifest.scope_digest === parentTurn.relay_plan.target.scope_digest
  );
  const deterministicBundle =
    composedA.bundleZipDigest === composedB.bundleZipDigest &&
    composedA.bundleZip.equals(composedB.bundleZip);

  const report = {
    schema: 'kneekura.code-lab.github-relay-all-isolation-report/v1',
    parent_semantic_task_count: parentSemanticTaskCount,
    parent_backend_call_count: parentBackendCalls,
    context_ids_distinct: contextIdsDistinct,
    cross_child_response_rejected: crossChildResponseRejected,
    cross_child_source_request_rejected: crossChildSourceRequestRejected,
    same_snapshot: sameSnapshot,
    same_scope: sameScope,
    child_artifacts_verified: childInputs.length,
    comparison: {
      semantic_fusion: composedA.comparison.semantic_fusion,
      canonical_truth_promotion: composedA.comparison.canonical_truth_promotion,
      engine_substitution: composedA.comparison.engine_substitution
    },
    deterministic_bundle: deterministicBundle,
    bundle_digest: composedA.bundleZipDigest,
    critical_high_findings: []
  };

  const checks = [
    [parentSemanticTaskCount === 0 && parentBackendCalls === 0, 'CRITICAL', 'ALL_PARENT_SEMANTIC_EXECUTION'],
    [contextIdsDistinct, 'CRITICAL', 'ALL_CONTEXT_COLLISION'],
    [crossChildResponseRejected, 'HIGH', 'CROSS_CHILD_RESPONSE_REUSE'],
    [crossChildSourceRequestRejected, 'HIGH', 'CROSS_CHILD_SOURCE_REUSE'],
    [sameSnapshot && sameScope, 'HIGH', 'CHILD_TARGET_DRIFT'],
    [childInputs.length === 3, 'HIGH', 'CHILD_ARTIFACT_SET_INVALID'],
    [composedA.comparison.semantic_fusion === false, 'HIGH', 'SEMANTIC_FUSION_ENABLED'],
    [composedA.comparison.canonical_truth_promotion === false, 'HIGH', 'CANONICAL_PROMOTION_ENABLED'],
    [composedA.comparison.engine_substitution === false, 'HIGH', 'ENGINE_SUBSTITUTION_ENABLED'],
    [deterministicBundle, 'HIGH', 'NONDETERMINISTIC_ALL_BUNDLE']
  ];
  report.critical_high_findings = checks
    .filter(([passed]) => !passed)
    .map(([, severity, code]) => ({ severity, code }));

  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (report.critical_high_findings.length) process.exitCode = 1;
} finally {
  await fixture.cleanup();
}

function childRequest(engineId) {
  return {
    schema: GITHUB_RELAY_SCHEMAS.request,
    selection: engineId,
    target: { ...parentRequest.target },
    commonScope: { ...parentRequest.commonScope },
    engineOptions: {},
    minimumClaimLevel: {},
    semanticContextMode: 'single-context'
  };
}

function createPendingTaskBackend(engineId) {
  let task = null;
  return {
    async execute(plan) {
      if (!task) {
        task = createHostTask({
          runId: plan.runId,
          engineId,
          attemptId: `attempt-${engineId.replace(/[^a-z0-9]+/g, '-')}`,
          snapshotId: plan.target.snapshotId,
          scopeDigest: plan.target.scopeDigest,
          ordinal: 1,
          kind: `${engineId}:FIXTURE`,
          payload: { prompt: `Independent ${engineId} fixture task.` }
        });
      }
      throw new HostTaskRequiredError(task);
    },
    async acceptHostResponse() {
      throw new Error('fixture should not accept a response');
    },
    async readSource() {
      throw new Error('foreign source request must be rejected before source read');
    },
    async status() { return { phase: 'PENDING' }; },
    async artifactInfo() { return []; }
  };
}

function responseFor(task) {
  return validateRelayResponseEnvelope({
    schema: GITHUB_RELAY_SCHEMAS.response,
    run_id: task.run_id,
    task_id: task.task_id,
    engine_id: task.engine_id,
    attempt_id: task.attempt_id,
    snapshot_id: task.snapshot_id,
    scope_digest: task.scope_digest,
    ordinal: task.ordinal,
    kind: task.kind,
    payload_digest: task.payload_digest,
    response: { fixture: true }
  });
}

function sourceRequestFor(task) {
  return validateRelaySourceRequest({
    schema: GITHUB_RELAY_SCHEMAS.sourceRequest,
    run_id: task.run_id,
    task_id: task.task_id,
    path: 'src/fixture.mjs',
    start_line: 1,
    end_line: 1
  });
}

function rejectedWithCode(fn, expectedCode) {
  try {
    fn();
    return false;
  } catch (error) {
    return error?.code === expectedCode;
  }
}

async function rejectedAsyncWithCode(fn, expectedCode) {
  try {
    await fn();
    return false;
  } catch (error) {
    return error?.code === expectedCode;
  }
}

async function makeTargetFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kneekura-relay-all-isolation-'));
  git(root, ['init']);
  git(root, ['remote', 'add', 'origin', `https://github.com/${TARGET}.git`]);
  return {
    root,
    cleanup: () => fs.rm(root, { recursive: true, force: true })
  };
}

function git(cwd, args) {
  return childProcess.execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
}