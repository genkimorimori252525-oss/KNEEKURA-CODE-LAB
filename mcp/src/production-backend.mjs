import crypto from 'node:crypto';
import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { materializeCommitAnalysisRoot } from '../../src/core/identity/commit-materializer.mjs';
import { resolveRepositoryIdentity } from '../../src/core/identity/repository.mjs';
import { scanRepository } from '../../src/core/scan.mjs';
import {
  createHumanAnalysisEvidencePack,
  createHumanAnalysisSourceBroker
} from '../../src/human-analysis/index.mjs';
import { createExplorerProjection } from '../../src/presentation/explorer/project.mjs';
import {
  assertSkillRunBudget,
  createEngineAttemptContext,
  createSkillRunRoot,
  executeKneekuraCodeLabRequest,
  executeUaHelper,
  removeSkillRunRoot,
  runNativeKneekuraHumanGuide,
  runStableArchifyEngine,
  runStableUnderstandAnythingEngine,
  sanitizeDiagnosticText
} from '../../src/skill/index.mjs';
import {
  DEFAULT_HOST_BRIDGE_LIMITS,
  HostTaskRequiredError
} from './host-bridge-contract.mjs';
import {
  acceptHostResponseForPendingTask,
  createHostReplayBroker,
  createHostResponseLedger
} from './host-task-broker.mjs';

export const PRODUCTION_BACKEND_SCHEMA =
  'kneekura.code-lab.host-bridge-production-backend/v1';

const ENGINE_ORDINAL = Object.freeze({
  kneekura: 1,
  'understand-anything': 2,
  archify: 3
});

export function createHostBridgeProductionBackend({
  env = process.env,
  tempParent = os.tmpdir(),
  limits = DEFAULT_HOST_BRIDGE_LIMITS
} = {}) {
  const sessions = new Map();

  return Object.freeze({
    schema: PRODUCTION_BACKEND_SCHEMA,

    async execute(plan) {
      const session = await ensureSession({ sessions, plan, env, tempParent, limits });
      if (session.execution != null) return session.execution;
      session.phase = 'RUNNING';
      session.pendingTask = null;
      session.summary = 'Replaying KNEEKURA Code LAB from the exact Target Snapshot.';

      try {
        const engineRunners = createProductionEngineRunners(session);
        const execution = await executeKneekuraCodeLabRequest({
          request: plan.runtimeRequest,
          engineRunners,
          targetSnapshotId: session.materialized.snapshotIdentity.snapshot_id,
          scopeDigest: plan.target.scopeDigest,
          runId: plan.runId
        });
        session.execution = execution;
        captureArtifacts(session, execution);
        session.phase = 'COMPLETE';
        session.summary = execution.kind === 'ALL_MODE_BUNDLE'
          ? `All-mode completed with status ${execution.status}.`
          : `Engine ${execution.requestedEngine} completed.`;
        await releaseExecutionRoots(session);
        return execution;
      } catch (error) {
        if (String(error?.code ?? '') === 'HOST_TASK_REQUIRED' && error?.task) {
          session.pendingTask = structuredClone(error.task);
          session.phase = 'PENDING';
          session.summary = `Host semantic response required for ${error.task.kind}.`;
          throw error;
        }
        session.phase = String(error?.code ?? '').startsWith('BLOCKED_')
          ? 'BLOCKED'
          : 'FAILED';
        session.summary = 'KNEEKURA Code LAB execution did not complete successfully.';
        session.error = {
          code: sanitizeDiagnosticText(String(error?.code ?? 'ENGINE_EXECUTION_FAILED'), { maxBytes: 256 }),
          message: sanitizeDiagnosticText(String(error?.message ?? error), { maxBytes: 4096 })
        };
        await releaseExecutionRoots(session);
        throw error;
      }
    },

    async status(runId) {
      const session = sessions.get(String(runId ?? ''));
      if (!session) return null;
      return structuredClone({
        phase: session.phase,
        summary: session.summary,
        error: session.error,
        pending_task_id: session.pendingTask?.task_id ?? null,
        host_bridge: session.ledger.summary(),
        artifacts: session.artifacts.map(stripArtifactBytes)
      });
    },

    async artifactInfo(runId, artifactId = null) {
      const session = sessions.get(String(runId ?? ''));
      if (!session) return [];
      return session.artifacts
        .filter(item => artifactId == null || item.id === artifactId)
        .map(stripArtifactBytes);
    },

    async pendingTask(runId) {
      const session = sessions.get(String(runId ?? ''));
      return session?.pendingTask == null
        ? null
        : structuredClone(session.pendingTask);
    },

    async acceptHostResponse(runId, taskId, response) {
      const session = requireSession(sessions, runId);
      if (!session.pendingTask) {
        throw codedError('HOST_TASK_NOT_PENDING', 'no host task is pending for this run');
      }
      const record = acceptHostResponseForPendingTask({
        pendingTask: session.pendingTask,
        taskId,
        response,
        ledger: session.ledger,
        limits
      });
      session.pendingTask = null;
      session.phase = 'PENDING';
      session.summary = 'Host response accepted; replay is ready to continue.';
      return record;
    },

    async sourceCatalog(runId, taskId, { offset = 0, limit = 200 } = {}) {
      const session = requirePendingSession(sessions, runId, taskId);
      const start = normalizeOffset(offset);
      const count = normalizeCatalogLimit(limit);
      const rows = session.sourceCatalog.slice(start, start + count).map(row => ({
        path: row.path,
        content_digest: row.content_digest,
        line_count: row.line_count,
        bytes: row.bytes,
        instruction_authority: false
      }));
      return {
        total: session.sourceCatalog.length,
        offset: start,
        next_offset: start + rows.length < session.sourceCatalog.length
          ? start + rows.length
          : null,
        entries: rows
      };
    },

    async readSource(runId, taskId, request = {}) {
      const session = requirePendingSession(sessions, runId, taskId);
      const relative = normalizeRepositoryPath(request.path);
      const meta = session.sourceCatalogByPath.get(relative);
      if (!meta) {
        throw codedError('HOST_SOURCE_OUTSIDE_CATALOG', 'requested source path is outside the exact Target Snapshot catalog');
      }
      const startLine = Number(request.startLine ?? 1);
      const endLine = Number(request.endLine ?? Math.min(meta.line_count, startLine + limits.maxSourceReadLines - 1));
      if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine) {
        throw new TypeError('source line range is invalid');
      }
      if (endLine - startLine + 1 > limits.maxSourceReadLines) {
        throw codedError('HOST_SOURCE_READ_LINES_EXCEEDED', `source read exceeds ${limits.maxSourceReadLines} lines`);
      }
      const raw = await fs.readFile(path.join(session.materialized.root, ...relative.split('/')), 'utf8');
      const actualDigest = digest(raw);
      if (actualDigest !== meta.content_digest) {
        throw codedError('HOST_SOURCE_DIGEST_MISMATCH', 'materialized source changed after exact snapshot freeze');
      }
      const lines = raw.split(/\r?\n/);
      if (endLine > lines.length) throw new RangeError('source range exceeds file line count');
      const selected = lines.slice(startLine - 1, endLine).join('\n');
      const selectedBytes = Buffer.byteLength(selected, 'utf8');
      if (selectedBytes > limits.maxSourceReadBytes) {
        throw codedError('HOST_SOURCE_READ_BYTES_EXCEEDED', `source read exceeds ${limits.maxSourceReadBytes} bytes`);
      }
      const used = session.sourceReadBytesByTask.get(taskId) ?? 0;
      if (used + selectedBytes > limits.maxSourceReadBytesPerTask) {
        throw codedError('HOST_SOURCE_TASK_BUDGET_EXCEEDED', `source reads for this task exceed ${limits.maxSourceReadBytesPerTask} bytes`);
      }
      session.sourceReadBytesByTask.set(taskId, used + selectedBytes);
      return {
        path: relative,
        start_line: startLine,
        end_line: endLine,
        content_digest: actualDigest,
        text: sanitizeDiagnosticText(selected, { maxBytes: limits.maxSourceReadBytes }),
        instruction_authority: false,
        trust_class: 'UNTRUSTED_REPOSITORY_DATA',
        canonical_source_bytes: selectedBytes,
        task_source_bytes_used: used + selectedBytes,
        task_source_bytes_limit: limits.maxSourceReadBytesPerTask
      };
    }
  });
}

async function ensureSession({ sessions, plan, env, tempParent, limits }) {
  const existing = sessions.get(plan.runId);
  if (existing) {
    assertSamePlan(existing.plan, plan);
    return existing;
  }

  const targetRoot = path.resolve(String(plan.target.repository));
  let targetStat;
  try {
    targetStat = await fs.stat(targetRoot);
  } catch {
    throw codedError(
      'BLOCKED_TARGET_REPOSITORY_UNAVAILABLE',
      'target.repository must resolve to an existing local Git repository for the local Host Bridge backend'
    );
  }
  if (!targetStat.isDirectory()) {
    throw codedError('BLOCKED_TARGET_REPOSITORY_UNAVAILABLE', 'target.repository is not a directory');
  }

  const repository = await resolveRepositoryIdentity(targetRoot);
  if (repository.vcs !== 'git') {
    throw codedError('BLOCKED_TARGET_REPOSITORY_NOT_GIT', 'Host Bridge production execution requires a local Git repository');
  }
  const materialized = await materializeCommitAnalysisRoot(
    targetRoot,
    repository,
    plan.target.revision,
    { tempParent }
  );
  if (materialized.snapshotIdentity.snapshot_id !== plan.target.snapshotId) {
    await materialized.cleanup();
    throw codedError(
      'BLOCKED_TARGET_SNAPSHOT_MISMATCH',
      'supplied target.snapshotId does not match the exact repository identity and revision'
    );
  }

  const run = await createSkillRunRoot({ parent: tempParent, runId: plan.runId });
  try {
    const sourceCatalog = await buildSourceCatalog(materialized.root, materialized.materialized_files);
    const trackedBytes = sourceCatalog.reduce((sum, row) => sum + row.bytes, 0);
    assertSkillRunBudget({
      files: sourceCatalog.length,
      trackedBytes,
      artifactBytes: 0,
      artifactEntries: 0,
      attemptsPerEngine: 1
    });
    const graph = await scanRepository(materialized.root, {
      repositoryIdentity: repository,
      snapshotIdentity: materialized.snapshotIdentity
    });
    const coverage = {
      schema: 'core.coverage/v1',
      completeness: 'BOUNDED',
      entries: [{
        id: 'repository:host-bridge-exact-materialization',
        role: 'PRIMARY',
        status: 'ANALYZED'
      }]
    };
    const analysisResult = {
      schema: 'core.analysis-result/v1',
      analysis_id: `analysis:host-bridge:${plan.runId}`,
      session_id: `session:host-bridge:${plan.runId}`,
      repository,
      snapshot: materialized.snapshotIdentity,
      status: 'COMPLETE',
      coverage,
      claims: [],
      evidence: [],
      unknowns: [],
      failures: []
    };
    const evidencePack = createHumanAnalysisEvidencePack({
      repository,
      snapshot: materialized.snapshotIdentity,
      graph,
      result: analysisResult,
      evidence: [],
      source_catalog: sourceCatalog.map(row => ({
        path: row.path,
        content_digest: row.content_digest,
        line_count: row.line_count
      }))
    });
    const sourceBroker = createHumanAnalysisSourceBroker(evidencePack, {
      readSource: relative => fs.readFile(
        path.join(materialized.root, ...normalizeRepositoryPath(relative).split('/')),
        'utf8'
      )
    });
    const explorerProjection = createExplorerProjection({ graph, result: analysisResult });
    const ledger = createHostResponseLedger({ limits });
    const sourceCatalogByPath = new Map(sourceCatalog.map(row => [row.path, row]));
    const session = {
      plan: structuredClone(plan),
      targetRoot,
      repository,
      materialized,
      run,
      graph,
      analysisResult,
      evidencePack,
      sourceBroker,
      explorerProjection,
      sourceCatalog,
      sourceCatalogByPath,
      ledger,
      sourceReadBytesByTask: new Map(),
      engineResults: new Map(),
      env,
      limits,
      phase: 'PENDING',
      summary: 'Exact Target Snapshot is prepared; semantic replay is ready.',
      error: null,
      pendingTask: null,
      execution: null,
      artifacts: [],
      rootsReleased: false
    };
    sessions.set(plan.runId, session);
    return session;
  } catch (error) {
    await materialized.cleanup();
    await removeSkillRunRoot(run.root, { expectedRunId: plan.runId }).catch(() => {});
    throw error;
  }
}

function createProductionEngineRunners(session) {
  const runners = {};
  for (const engineId of session.plan.requestedEngines) {
    runners[engineId] = async envelope => {
      const cached = session.engineResults.get(engineId);
      if (cached) return cached;
      const result = await runProductionEngine(session, engineId, envelope);
      session.engineResults.set(engineId, result);
      return result;
    };
  }
  return runners;
}

async function runProductionEngine(session, engineId, envelope) {
  assertEnvelopeBinding(session, engineId, envelope);
  const attemptOrdinal = session.plan.requestedEngines.length === 1
    ? 1
    : ENGINE_ORDINAL[engineId];
  const attempt = createEngineAttemptContext(
    session.plan.runId,
    engineId,
    attemptOrdinal
  );
  if (attempt.attemptId !== envelope.attemptId) {
    throw codedError('HOST_BRIDGE_ATTEMPT_MISMATCH', 'runner envelope attempt identity is not deterministic');
  }
  const replay = createHostReplayBroker({
    runId: session.plan.runId,
    engineId,
    attemptId: envelope.attemptId,
    snapshotId: session.materialized.snapshotIdentity.snapshot_id,
    scopeDigest: session.plan.target.scopeDigest,
    ledger: session.ledger,
    projectPayload: (kind, payload) => projectEngineHostPayload(session, kind, payload),
    limits: session.limits
  });

  if (engineId === 'kneekura') {
    return runNativeKneekuraHumanGuide({
      evidencePack: session.evidencePack,
      sourceBroker: session.sourceBroker,
      explorerProjection: session.explorerProjection,
      semanticAuthorHost: envelopeValue => replay.request(
        `kneekura:${envelopeValue.stage}`,
        envelopeValue
      ),
      semanticAuthorId: 'kneekura-code-lab-mcp-host',
      semanticProviderId: 'mcp-host-bridge',
      locale: 'ja-JP',
      request: normalizeKneekuraRequest(session, envelope.request),
      attemptId: envelope.attemptId,
      scopeDigest: session.plan.target.scopeDigest,
      minimumClaimLevel: minimumClaimLevel(session, engineId),
      title: 'KNEEKURA Human Guide'
    });
  }

  if (engineId === 'understand-anything') {
    const roots = requireUaRoots(session.env);
    const uaView = await ensureUaAnalysisView(session, roots.uaRoot);
    return runStableUnderstandAnythingEngine({
      uaRoot: roots.uaRoot,
      dashboardRoot: roots.dashboardRoot,
      dashboardAcceptance: {
        status: 'SKIPPED',
        reason: 'Local Host Bridge does not promote dashboard bytes into browser acceptance without a separate browser proof.'
      },
      targetRoot: uaView.root,
      targetSnapshotId: session.materialized.snapshotIdentity.snapshot_id,
      targetRevision: session.plan.target.revision,
      analysisViewPrivate: true,
      analysisViewManifest: uaView.manifest,
      semanticScheduler: {
        mode: 'portable-compatible',
        isolation: 'host-replay-context',
        dispatch: (role, payload) => replay.request(`ua:${role}`, payload)
      },
      runRoot: session.run.root,
      attemptId: envelope.attemptId,
      scopeDigest: session.plan.target.scopeDigest,
      minimumClaimLevel: minimumClaimLevel(session, engineId),
      hostCapabilities: {
        semanticSubagentIsolation: false,
        hostTaskReplay: true
      }
    });
  }

  if (engineId === 'archify') {
    const roots = requireArchifyRoots(session.env);
    return runStableArchifyEngine({
      archifyRoot: roots.archifyRoot,
      archifyArtifactSha256: roots.artifactSha256,
      targetRoot: session.targetRoot,
      targetSnapshotId: session.materialized.snapshotIdentity.snapshot_id,
      targetRepositoryUrl: repositoryUrl(session),
      targetRevision: session.plan.target.revision,
      typedIrAuthor: authorEnvelope => replay.request('archify:typed-ir', authorEnvelope),
      diagramType: String(engineOptions(session, engineId).diagramType ?? 'architecture'),
      quality: String(engineOptions(session, engineId).quality ?? 'showcase'),
      runRoot: session.run.root,
      attemptId: envelope.attemptId,
      scopeDigest: session.plan.target.scopeDigest,
      minimumClaimLevel: minimumClaimLevel(session, engineId),
      perceptualReview: {
        status: 'SKIPPED',
        reason: 'Host Bridge automated execution keeps human perceptual review as a separate acceptance axis.'
      }
    });
  }

  throw codedError('ENGINE_RUNNER_REQUIRED', `unsupported production engine: ${engineId}`);
}

async function projectEngineHostPayload(session, kind, payload) {
  return {
    schema: 'kneekura.code-lab.host-task-public-payload/v1',
    kind,
    target: {
      repository: session.plan.target.repository,
      revision: session.plan.target.revision,
      snapshot_id: session.materialized.snapshotIdentity.snapshot_id,
      scope_digest: session.plan.target.scopeDigest
    },
    source_catalog: {
      entry_count: session.sourceCatalog.length,
      browse_via_host_bridge: true,
      direct_repository_text_embedded: false
    },
    semantic_input: structuredClone(payload),
    trust: {
      repository_content_instruction_authority: false,
      semantic_input_may_contain_untrusted_repository_data: true
    }
  };
}

async function ensureUaAnalysisView(session, uaRoot) {
  if (session.uaView) return session.uaView;
  const viewRoot = path.join(session.run.root, 'views', 'understand-anything');
  await fs.mkdir(path.dirname(viewRoot), { recursive: true });
  await fs.cp(session.materialized.root, viewRoot, {
    recursive: true,
    force: false,
    errorOnExist: true
  });
  runGit(viewRoot, ['init']);
  runGit(viewRoot, ['config', 'core.autocrlf', 'false']);
  runGit(viewRoot, ['config', 'commit.gpgSign', 'false']);
  runGit(viewRoot, ['config', 'user.email', 'host-bridge@example.invalid']);
  runGit(viewRoot, ['config', 'user.name', 'KNEEKURA Host Bridge']);
  runGit(viewRoot, ['add', '--all']);
  runGit(viewRoot, ['commit', '--no-gpg-sign', '-m', 'private exact analysis view']);

  const preScanPath = path.join(session.run.root, 'ua-host-bridge-prescan.json');
  const uaSkillDir = path.join(uaRoot, 'understand-anything-plugin', 'skills', 'understand');
  const preScan = await executeUaHelper({
    helper: 'scan-project',
    skillDir: uaSkillDir,
    targetRoot: viewRoot,
    args: [viewRoot, preScanPath]
  });
  if (preScan.status !== 0) {
    throw codedError('UA_PRESCAN_FAILED', 'Understand Anything pre-scan failed for the private exact analysis view');
  }
  const scan = JSON.parse(await fs.readFile(preScanPath, 'utf8'));
  if (scan?.scriptCompleted !== true || !Array.isArray(scan.files)) {
    throw codedError('UA_PRESCAN_INVALID', 'Understand Anything pre-scan returned invalid output');
  }
  session.uaView = {
    root: viewRoot,
    manifest: {
      entries: scan.files.map(file => ({
        path: file.path,
        classification: 'semantic-input'
      }))
    }
  };
  return session.uaView;
}

async function buildSourceCatalog(root, relativePaths) {
  const rows = [];
  for (const relative of relativePaths) {
    const safe = normalizeRepositoryPath(relative);
    const full = path.join(root, ...safe.split('/'));
    const bytes = await fs.readFile(full);
    const text = bytes.toString('utf8');
    rows.push({
      path: safe,
      content_digest: digest(bytes),
      line_count: text.split(/\r?\n/).length,
      bytes: bytes.length
    });
  }
  rows.sort((a, b) => compareText(a.path, b.path));
  return rows;
}

function captureArtifacts(session, execution) {
  const rows = [];
  if (execution.kind === 'ENGINE_RESULT') {
    const bytes = directZip(execution.result);
    if (bytes) rows.push(artifactRow(`${execution.requestedEngine}:result.zip`, bytes));
  } else if (execution.kind === 'ALL_MODE_BUNDLE' && Buffer.isBuffer(execution.bundleZip)) {
    rows.push(artifactRow('all:bundle.zip', execution.bundleZip));
  }
  session.artifacts = rows;
}

function directZip(result) {
  if (Buffer.isBuffer(result?.deliveryZip)) return result.deliveryZip;
  if (Buffer.isBuffer(result?.artifact?.zip_bytes)) return result.artifact.zip_bytes;
  return null;
}

function artifactRow(id, bytes) {
  return {
    id,
    digest: digest(bytes),
    bytes: bytes.length,
    bytes_buffer: Buffer.from(bytes)
  };
}

function stripArtifactBytes(value) {
  return { id: value.id, digest: value.digest, bytes: value.bytes };
}

async function releaseExecutionRoots(session) {
  if (session.rootsReleased) return;
  // Completed/terminal runs keep only bounded receipts/artifact bytes in memory.
  // Canonical and run roots are disposable and must not become a second source
  // of truth after the engine has produced its sealed result.
  session.rootsReleased = true;
  await session.materialized.cleanup().catch(() => {});
  await removeSkillRunRoot(session.run.root, {
    expectedRunId: session.plan.runId
  }).catch(() => {});
}

function assertEnvelopeBinding(session, engineId, envelope) {
  if (envelope?.engineId !== engineId) throw codedError('ENGINE_SUBSTITUTION_FORBIDDEN', 'runner envelope engine mismatch');
  if (envelope?.targetSnapshotId !== session.materialized.snapshotIdentity.snapshot_id) {
    throw codedError('ENGINE_SNAPSHOT_MISMATCH', 'runner envelope snapshot mismatch');
  }
  if (envelope?.scopeDigest !== session.plan.target.scopeDigest) {
    throw codedError('ENGINE_SCOPE_MISMATCH', 'runner envelope scope mismatch');
  }
}

function assertSamePlan(expected, actual) {
  const a = JSON.stringify(expected);
  const b = JSON.stringify(actual);
  if (a !== b) throw codedError('RUN_ID_ALREADY_EXISTS', 'runId is already bound to a different Host Bridge plan');
}

function requireSession(sessions, runId) {
  const session = sessions.get(String(runId ?? ''));
  if (!session) throw codedError('HOST_RUN_NOT_FOUND', 'Host Bridge run was not found');
  return session;
}

function requirePendingSession(sessions, runId, taskId) {
  const session = requireSession(sessions, runId);
  if (!session.pendingTask || session.pendingTask.task_id !== String(taskId ?? '')) {
    throw codedError('HOST_TASK_NOT_PENDING', 'source access requires the current pending Host Task');
  }
  if (session.rootsReleased) throw codedError('HOST_SOURCE_UNAVAILABLE', 'source root is no longer retained for this terminal run');
  return session;
}

function normalizeKneekuraRequest(session, request) {
  return {
    question: String(request?.commonScope?.question ?? request?.question ?? 'Explain this exact repository snapshot.'),
    audience: 'HUMAN',
    target_repository: session.plan.target.repository,
    target_revision: session.plan.target.revision,
    scope: request?.commonScope ?? null
  };
}

function minimumClaimLevel(session, engineId) {
  const map = session.plan.runtimeRequest?.minimumClaimLevel ?? {};
  return map?.[engineId] ?? null;
}

function engineOptions(session, engineId) {
  const options = session.plan.runtimeRequest?.engineOptions ?? {};
  const selected = options?.[engineId];
  return selected && typeof selected === 'object' && !Array.isArray(selected)
    ? selected
    : {};
}

function requireUaRoots(env) {
  const uaRoot = String(env.KNEEKURA_UA_ROOT ?? '').trim();
  if (!uaRoot) throw codedError('BLOCKED_UA_ROOT_UNAVAILABLE', 'KNEEKURA_UA_ROOT is required for Understand Anything execution');
  const dashboardRoot = String(env.KNEEKURA_UA_DASHBOARD_ROOT ?? '').trim() || null;
  return { uaRoot: path.resolve(uaRoot), dashboardRoot: dashboardRoot == null ? null : path.resolve(dashboardRoot) };
}

function requireArchifyRoots(env) {
  const archifyRoot = String(env.KNEEKURA_ARCHIFY_ROOT ?? '').trim();
  const artifactSha256 = String(env.KNEEKURA_ARCHIFY_ARTIFACT_SHA256 ?? '').trim();
  if (!archifyRoot || !artifactSha256) {
    throw codedError('BLOCKED_ARCHIFY_ROOT_UNAVAILABLE', 'KNEEKURA_ARCHIFY_ROOT and KNEEKURA_ARCHIFY_ARTIFACT_SHA256 are required for Archify execution');
  }
  return { archifyRoot: path.resolve(archifyRoot), artifactSha256 };
}

function repositoryUrl(session) {
  const canonical = String(session.repository.canonical_identity ?? '');
  if (canonical.startsWith('git:github.com/')) {
    return `https://github.com/${canonical.slice('git:github.com/'.length)}`;
  }
  const configured = engineOptions(session, 'archify').repositoryUrl;
  return configured == null ? null : String(configured);
}

function normalizeRepositoryPath(value) {
  const text = String(value ?? '').replaceAll('\\', '/').replace(/^\.\//, '');
  if (
    !text ||
    text.startsWith('/') ||
    /^[A-Za-z]:\//.test(text) ||
    text.split('/').some(part => !part || part === '.' || part === '..') ||
    /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(text)
  ) {
    throw codedError('HOST_SOURCE_PATH_UNSAFE', `unsafe repository source path: ${value}`);
  }
  return text;
}

function normalizeOffset(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw new TypeError('source catalog offset must be a non-negative integer');
  return number;
}

function normalizeCatalogLimit(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 500) throw new TypeError('source catalog limit must be 1-500');
  return number;
}

function runGit(cwd, args) {
  const nullHooks = process.platform === 'win32' ? 'NUL' : '/dev/null';
  return childProcess.execFileSync(
    'git',
    ['-c', `core.hooksPath=${nullHooks}`, '-C', cwd, ...args],
    {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: Object.fromEntries(Object.entries({
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        WINDIR: process.env.WINDIR,
        HOME: process.env.HOME,
        USERPROFILE: process.env.USERPROFILE,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP
      }).filter(([, value]) => value != null))
    }
  );
}

function digest(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function compareText(a, b) {
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}