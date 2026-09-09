import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { materializeCommitAnalysisRoot } from '../src/core/identity/commit-materializer.mjs';
import { createRepositoryIdentity } from '../src/core/identity/repository.mjs';
import { scanRepository } from '../src/core/scan.mjs';
import { createExplorerProjection } from '../src/presentation/explorer/project.mjs';
import {
  createHumanAnalysisEvidencePack,
  createHumanAnalysisSourceBroker
} from '../src/human-analysis/index.mjs';
import {
  createSkillRunRoot,
  executeUaHelper,
  removeSkillRunRoot,
  runNativeKneekuraHumanGuide,
  runStableArchifyEngine,
  runStableUnderstandAnythingEngine,
  validateEngineRunReceipt
} from '../src/skill/index.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(here);
const TARGET_REPOSITORY = 'genkimorimori252525-oss/KNEEKURA-LAB';
const TARGET_URL = `https://github.com/${TARGET_REPOSITORY}`;
const TARGET_SHA = 'e96e40ab0fc7a8995a1972d8f9defb2aa894ad0e';
const TARGET_GIT_ROOT = process.env.KNEEKURA_LAB_GIT_ROOT;
const ARCHIFY_ROOT = process.env.KNEEKURA_ARCHIFY_ROOT;
const ARCHIFY_SHA256 = process.env.KNEEKURA_ARCHIFY_ARTIFACT_SHA256;
const UA_ROOT = process.env.KNEEKURA_UA_ROOT;
const UA_DASHBOARD_ROOT = process.env.KNEEKURA_UA_DASHBOARD_ROOT;
if (!TARGET_GIT_ROOT || !ARCHIFY_ROOT || !ARCHIFY_SHA256 || !UA_ROOT || !UA_DASHBOARD_ROOT) {
  throw new Error('KNEEKURA_LAB_GIT_ROOT, pinned Archify, and pinned UA environment are required');
}

const repository = createRepositoryIdentity({
  root: TARGET_GIT_ROOT,
  remote: `${TARGET_URL}.git`,
  vcs: 'git',
  objectFormat: 'sha1'
});
const materialized = await materializeCommitAnalysisRoot(
  TARGET_GIT_ROOT,
  repository,
  TARGET_SHA
);
const run = await createSkillRunRoot({
  parent: os.tmpdir(),
  runId: 'kneekura-lab-three-engine-v1'
});
const outputRoot = path.join(ROOT, 'dist', 'kneekura-lab-three-engine-acceptance');

try {
  const canonicalRoot = materialized.root;
  const snapshot = materialized.snapshotIdentity;
  assert.equal(snapshot.kind, 'COMMIT');
  assert.equal(snapshot.base_commit, TARGET_SHA);

  const graph = await scanRepository(canonicalRoot, {
    repositoryIdentity: repository,
    snapshotIdentity: snapshot
  });
  const coverage = {
    schema: 'core.coverage/v1',
    completeness: 'BOUNDED',
    entries: [{ id: 'repository:pinned-target', role: 'PRIMARY', status: 'ANALYZED' }]
  };
  const analysisResult = {
    schema: 'core.analysis-result/v1',
    analysis_id: `analysis:kneekura-lab-skill-v1:${TARGET_SHA.slice(0, 12)}`,
    session_id: 'session:kneekura-lab-skill-v1',
    repository,
    snapshot,
    status: 'COMPLETE',
    coverage,
    claims: [],
    evidence: [],
    unknowns: [],
    failures: []
  };
  const sourcePaths = [
    'README.md',
    'docs/KNEEKURA_RENDER_ARCHITECTURE_V1.md',
    'simlab/renderpack/README.md',
    'simlab/renderframe/README.md',
    'simlab/golden/README.md'
  ];
  const sourceCatalog = [];
  for (const relative of sourcePaths) {
    const text = await fs.readFile(path.join(canonicalRoot, relative), 'utf8');
    sourceCatalog.push({
      path: relative,
      content_digest: digest(text),
      line_count: text.split(/\r?\n/).length
    });
  }
  const pack = createHumanAnalysisEvidencePack({
    repository,
    snapshot,
    graph,
    result: analysisResult,
    evidence: [],
    source_catalog: sourceCatalog
  });
  const broker = createHumanAnalysisSourceBroker(pack, {
    readSource: relative => fs.readFile(path.join(canonicalRoot, relative), 'utf8')
  });
  const explorerProjection = createExplorerProjection({ graph, result: analysisResult });
  const scopeDigest = digest(`KNEEKURA-LAB\0${TARGET_SHA}\0three-engine-v1`);

  const kneekura = await runNativeKneekuraHumanGuide({
    evidencePack: pack,
    sourceBroker: broker,
    explorerProjection,
    semanticAuthorHost: createKneekuraAuthor(),
    semanticAuthorId: 'chatgpt-kneekura-lab-acceptance',
    semanticProviderId: 'chatgpt',
    locale: 'ja-JP',
    request: {
      question: 'KNEEKURA-LABの主要な実機観測→証拠→Render Pack/RenderFrame→Viewerの境界を人間向けに説明する',
      audience: 'HUMAN',
      target_repository: TARGET_REPOSITORY,
      target_revision: TARGET_SHA
    },
    attemptId: 'kneekura-lab-kneekura-v1',
    scopeDigest,
    minimumClaimLevel: 'NATIVE',
    title: 'KNEEKURA-LAB — KNEEKURA Human Guide acceptance'
  });
  assert.equal(kneekura.receipt.status, 'SUCCESS');
  assert.equal(kneekura.receipt.snapshotId, snapshot.snapshot_id);
  assert.equal(validateEngineRunReceipt(kneekura.receipt), true);

  const uaView = path.join(run.root, 'views', 'understand-anything');
  await fs.mkdir(path.dirname(uaView), { recursive: true });
  await fs.cp(canonicalRoot, uaView, { recursive: true, force: false, errorOnExist: true });
  runGit(uaView, ['init']);
  runGit(uaView, ['config', 'core.autocrlf', 'false']);
  runGit(uaView, ['config', 'user.email', 'acceptance@example.invalid']);
  runGit(uaView, ['config', 'user.name', 'KNEEKURA Acceptance']);
  runGit(uaView, ['add', '--all']);
  runGit(uaView, ['commit', '-m', 'private analysis view']);

  const preScanPath = path.join(run.root, 'ua-prescan.json');
  const uaSkillDir = path.join(UA_ROOT, 'understand-anything-plugin', 'skills', 'understand');
  const preScan = await executeUaHelper({
    helper: 'scan-project',
    skillDir: uaSkillDir,
    targetRoot: uaView,
    args: [uaView, preScanPath]
  });
  assert.equal(preScan.status, 0);
  const preScanJson = JSON.parse(await fs.readFile(preScanPath, 'utf8'));
  assert.equal(preScanJson.scriptCompleted, true);
  const analysisViewManifest = {
    entries: preScanJson.files.map(file => ({
      path: file.path,
      classification: 'semantic-input'
    }))
  };
  const scheduler = createUaScheduler(run.root);
  const ua = await runStableUnderstandAnythingEngine({
    uaRoot: UA_ROOT,
    dashboardRoot: UA_DASHBOARD_ROOT,
    dashboardAcceptance: {
      status: 'SKIPPED',
      reason: 'Dashboard bytes are included, but KNEEKURA-LAB target acceptance does not promote a build-only check into browser acceptance.'
    },
    targetRoot: uaView,
    targetSnapshotId: snapshot.snapshot_id,
    targetRevision: TARGET_SHA,
    analysisViewPrivate: true,
    analysisViewManifest,
    semanticScheduler: scheduler,
    runRoot: run.root,
    attemptId: 'kneekura-lab-ua-v1',
    scopeDigest,
    minimumClaimLevel: 'NATIVE',
    hostCapabilities: {
      semanticSubagentIsolation: true,
      targetAcceptanceRoleProcesses: true
    }
  });
  assert.equal(ua.receipt.status, 'SUCCESS');
  assert.equal(ua.receipt.claimLevel, 'NATIVE');
  assert.equal(ua.receipt.claimSatisfied, true);
  assert.equal(ua.receipt.snapshotId, snapshot.snapshot_id);
  assert.deepEqual(ua.receipt.coverage.missing_host_semantic_inputs, []);
  assert.equal(validateEngineRunReceipt(ua.receipt), true);

  const archify = await runStableArchifyEngine({
    archifyRoot: ARCHIFY_ROOT,
    archifyArtifactSha256: ARCHIFY_SHA256,
    targetRoot: canonicalRoot,
    targetSnapshotId: snapshot.snapshot_id,
    targetRepositoryUrl: TARGET_URL,
    targetRevision: TARGET_SHA,
    typedIrAuthor: async () => archifyIr(),
    diagramType: 'architecture',
    quality: 'showcase',
    runRoot: run.root,
    attemptId: 'kneekura-lab-archify-v1',
    scopeDigest,
    minimumClaimLevel: 'NATIVE',
    perceptualReview: {
      status: 'SKIPPED',
      reason: 'Automated upstream visual-check is executed in CI; human perceptual review remains a separate acceptance axis.'
    }
  });
  assert.equal(archify.receipt.status, 'SUCCESS');
  assert.equal(archify.receipt.snapshotId, snapshot.snapshot_id);
  assert.equal(archify.receipt.acceptance.browser_visual_check.status, 'PASS');
  assert.equal(validateEngineRunReceipt(archify.receipt), true);

  for (const receipt of [kneekura.receipt, ua.receipt, archify.receipt]) {
    assert.equal(receipt.snapshotId, snapshot.snapshot_id);
    assert.equal(receipt.scopeDigest, scopeDigest);
  }

  await fs.rm(outputRoot, { recursive: true, force: true });
  await fs.mkdir(outputRoot, { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(outputRoot, 'kneekura-human-explorer.zip'), kneekura.artifact.zip_bytes),
    fs.writeFile(path.join(outputRoot, 'understand-anything.zip'), ua.deliveryZip),
    fs.writeFile(path.join(outputRoot, 'archify.zip'), archify.deliveryZip),
    fs.writeFile(path.join(outputRoot, 'archify.html'), archify.artifact.bytes)
  ]);
  const report = {
    schema: 'kneekura.code-lab.kneekura-lab-three-engine-acceptance/v1',
    target: {
      repository: TARGET_REPOSITORY,
      repository_url: TARGET_URL,
      revision: TARGET_SHA,
      snapshot_id: snapshot.snapshot_id,
      materialized_files: materialized.materialized_files.length
    },
    scope_digest: scopeDigest,
    semantic_fusion: false,
    canonical_truth_promotion_from_engine_consensus: false,
    engines: {
      kneekura: summarize(kneekura.receipt),
      'understand-anything': summarize(ua.receipt),
      archify: summarize(archify.receipt)
    }
  };
  await fs.writeFile(path.join(outputRoot, 'acceptance-report.json'), JSON.stringify(report, null, 2) + '\n');
  await fs.writeFile(path.join(outputRoot, 'kneekura.receipt.json'), JSON.stringify(kneekura.receipt, null, 2) + '\n');
  await fs.writeFile(path.join(outputRoot, 'understand-anything.receipt.json'), JSON.stringify(ua.receipt, null, 2) + '\n');
  await fs.writeFile(path.join(outputRoot, 'archify.receipt.json'), JSON.stringify(archify.receipt, null, 2) + '\n');
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
} finally {
  await materialized.cleanup();
  await removeSkillRunRoot(run.root, {
    expectedRunId: 'kneekura-lab-three-engine-v1'
  });
}

function createKneekuraAuthor() {
  const specs = [
    ['README.md', 'Repository boundary', 'KNEEKURA-LAB separates runtime observation and SimLab analysis from Minecraft/TLM implementation details.'],
    ['docs/KNEEKURA_RENDER_ARCHITECTURE_V1.md', 'Render architecture boundary', 'The frozen render architecture separates Minecraft/YSM authoring-time truth from the offline Viewer runtime boundary.'],
    ['simlab/renderpack/README.md', 'Render Pack', 'Render Pack carries self-contained static rendering assets and preserves UNKNOWN instead of guessing missing state.'],
    ['simlab/renderframe/README.md', 'Render Frame', 'RenderFrameIR promotes captured final-vertex evidence only when replay-critical bindings are complete.'],
    ['simlab/golden/README.md', 'Golden Oracle', 'Golden infrastructure compares real-client or deterministic reference pixels against Thin Viewer output without overstating unproven real YSM parity.']
  ];
  return async (envelope, broker) => {
    if (envelope.stage === 'ARCHITECTURE') {
      const items = [];
      for (const [relative, title, body] of specs) {
        const row = await broker.readFileRange({
          kind: 'FILE_RANGE',
          path: relative,
          start_line: 1,
          end_line: 24
        });
        items.push({
          kind: 'ARCHITECTURE_COMPONENT',
          semantic_class: 'AI_INTERPRETATION',
          title,
          body,
          source_refs: [{
            kind: 'FILE_RANGE',
            path: row.path,
            start_line: row.start_line,
            end_line: row.end_line,
            content_digest: row.content_digest
          }]
        });
      }
      return { items };
    }
    if (envelope.stage === 'REVIEWER') {
      return {
        decisions: envelope.candidate_items.map(item => ({
          item_id: item.id,
          status: 'ACCEPT',
          reason: 'Pinned-source-linked production acceptance item'
        }))
      };
    }
    return { items: [] };
  };
}

function createUaScheduler(root) {
  let index = 0;
  return {
    mode: 'native-upstream-subagents',
    isolation: 'separate-contexts',
    async dispatch(role, payload) {
      const id = String(++index).padStart(3, '0');
      const inputPath = path.join(root, `ua-role-${id}.input.json`);
      const outputPath = path.join(root, `ua-role-${id}.output.json`);
      await fs.writeFile(inputPath, JSON.stringify({
        ...payload,
        acceptanceTarget: 'KNEEKURA-LAB'
      }));
      childProcess.execFileSync(
        process.execPath,
        [path.join(here, 'ua-target-acceptance-role.mjs'), role, inputPath, outputPath],
        {
          cwd: root,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          env: Object.fromEntries(Object.entries({
            PATH: process.env.PATH,
            SystemRoot: process.env.SystemRoot,
            WINDIR: process.env.WINDIR,
            TEMP: process.env.TEMP,
            TMP: process.env.TMP
          }).filter(([, value]) => value != null))
        }
      );
      return JSON.parse(await fs.readFile(outputPath, 'utf8'));
    }
  };
}

function archifyIr() {
  return {
    schema_version: 1,
    diagram_type: 'architecture',
    meta: {
      title: 'KNEEKURA-LAB — runtime truth to offline viewer',
      locale: 'en',
      quality_profile: 'showcase',
      repository: { url: TARGET_URL, revision: TARGET_SHA },
      views: [
        {
          id: 'truth-path',
          label: 'Truth path',
          focus: ['runtime', 'bridge', 'renderpack', 'renderframe', 'viewer', 'golden'],
          note: 'Follow runtime observations into self-contained replay artifacts and the offline viewer.'
        },
        {
          id: 'trust-boundary',
          label: 'Trust boundary',
          focus: ['runtime', 'renderframe', 'viewer'],
          note: 'Authoritative runtime evidence remains distinct from derived or predicted viewer-side interpretation.'
        }
      ]
    },
    layout: { mode: 'grid', origin: [40, 120], cols: 3, gapX: 70, gapY: 100, cellW: 180, cellH: 76 },
    components: [
      { id: 'runtime', type: 'backend', label: 'Minecraft / TLM / YSM', sublabel: 'runtime truth', row: 0, col: 0, sources: [{ path: 'README.md', line: 1 }] },
      { id: 'bridge', type: 'backend', label: 'Forge/TLM Bridge', sublabel: 'observation adapter', row: 0, col: 1, sources: [{ path: 'README.md', line: 1 }] },
      { id: 'renderpack', type: 'database', label: 'Render Pack', sublabel: 'self-contained assets', row: 0, col: 2, sources: [{ path: 'simlab/renderpack/README.md', line: 1 }] },
      { id: 'renderframe', type: 'security', label: 'Render Frame', sublabel: 'promoted evidence', row: 1, col: 0, sources: [{ path: 'simlab/renderframe/README.md', line: 1 }] },
      { id: 'viewer', type: 'frontend', label: 'Thin Viewer', sublabel: 'offline KNEEKURA IR', row: 1, col: 1, sources: [{ path: 'docs/KNEEKURA_RENDER_ARCHITECTURE_V1.md', line: 1 }] },
      { id: 'golden', type: 'security', label: 'Golden Oracle', sublabel: 'pixel comparison', row: 1, col: 2, sources: [{ path: 'simlab/golden/README.md', line: 1 }] }
    ],
    connections: [
      { id: 'runtime-bridge', from: 'runtime', to: 'bridge', variant: 'emphasis' },
      { id: 'bridge-renderpack', from: 'bridge', to: 'renderpack', variant: 'emphasis' },
      { id: 'runtime-renderframe', from: 'runtime', to: 'renderframe', variant: 'security' },
      { id: 'renderpack-viewer', from: 'renderpack', to: 'viewer', variant: 'emphasis' },
      { id: 'renderframe-viewer', from: 'renderframe', to: 'viewer', variant: 'security' },
      { id: 'viewer-golden', from: 'viewer', to: 'golden', variant: 'emphasis' }
    ],
    cards: [
      { dot: 'rose', title: 'Authority', items: ['Minecraft/runtime is the source of truth', 'Prediction never silently becomes authoritative evidence'] },
      { dot: 'cyan', title: 'Offline boundary', items: ['Viewer consumes KNEEKURA IR', 'Viewer does not require Minecraft, Forge, or YSM runtime'] },
      { dot: 'emerald', title: 'Verification', items: ['Golden infrastructure verifies comparison plumbing', 'Real YSM pixel parity remains a separate evidence claim'] }
    ]
  };
}

function runGit(cwd, args) {
  return childProcess.execFileSync('git', ['-c', 'core.hooksPath=NUL', '-C', cwd, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

function summarize(receipt) {
  return {
    status: receipt.status,
    claim_level: receipt.claimLevel,
    claim_satisfied: receipt.claimSatisfied,
    orchestration_mode: receipt.orchestrationMode,
    snapshot_id: receipt.snapshotId,
    coverage: receipt.coverage,
    acceptance: receipt.acceptance,
    artifacts: receipt.artifacts,
    warnings: receipt.warnings,
    errors: receipt.errors
  };
}

function digest(value) {
  return 'sha256:' + crypto.createHash('sha256').update(value).digest('hex');
}