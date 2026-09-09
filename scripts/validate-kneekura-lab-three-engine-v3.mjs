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
import { createHumanAnalysisEvidencePack, createHumanAnalysisSourceBroker } from '../src/human-analysis/index.mjs';
import {
  createSkillRunRoot,
  executeUaHelper,
  removeSkillRunRoot,
  runNativeKneekuraHumanGuide,
  runStableArchifyEngine,
  runStableUnderstandAnythingEngine,
  validateEngineRunReceipt
} from '../src/skill/index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const TARGET_REPOSITORY = 'genkimorimori252525-oss/KNEEKURA-LAB';
const TARGET_URL = `https://github.com/${TARGET_REPOSITORY}`;
const TARGET_SHA = 'e96e40ab0fc7a8995a1972d8f9defb2aa894ad0e';
const TARGET_GIT_ROOT = requiredEnv('KNEEKURA_LAB_GIT_ROOT');
const ARCHIFY_ROOT = requiredEnv('KNEEKURA_ARCHIFY_ROOT');
const ARCHIFY_SHA256 = requiredEnv('KNEEKURA_ARCHIFY_ARTIFACT_SHA256');
const UA_ROOT = requiredEnv('KNEEKURA_UA_ROOT');
const UA_DASHBOARD_ROOT = requiredEnv('KNEEKURA_UA_DASHBOARD_ROOT');
const SOURCE_PATHS = [
  'simlab/serve.mjs',
  'simlab/renderpack/compiler.mjs',
  'simlab/renderframe/final-vertex.mjs',
  'simlab/golden/oracle.mjs',
  'simlab/viewer/gl.js'
];

const repository = createRepositoryIdentity({
  root: TARGET_GIT_ROOT,
  remote: `${TARGET_URL}.git`,
  vcs: 'git',
  objectFormat: 'sha1'
});
const materialized = await materializeCommitAnalysisRoot(TARGET_GIT_ROOT, repository, TARGET_SHA);
const run = await createSkillRunRoot({ parent: os.tmpdir(), runId: 'kneekura-lab-three-engine-v1' });
const outputRoot = path.join(ROOT, 'dist', 'kneekura-lab-three-engine-acceptance');

try {
  const canonicalRoot = materialized.root;
  const snapshot = materialized.snapshotIdentity;
  assert.equal(snapshot.kind, 'COMMIT');
  assert.equal(snapshot.base_commit, TARGET_SHA);
  assert.equal(materialized.integrity.replace_objects_disabled, true);
  assert.equal(materialized.integrity.lazy_fetch_disabled, true);
  const materializedSet = new Set(materialized.materialized_files);
  for (const source of SOURCE_PATHS) assert(materializedSet.has(source), `canonical source missing: ${source}`);

  const graph = await scanRepository(canonicalRoot, { repositoryIdentity: repository, snapshotIdentity: snapshot });
  const coverage = {
    schema: 'core.coverage/v1',
    completeness: 'BOUNDED',
    entries: [{ id: 'repository:pinned-analyzable-view', role: 'PRIMARY', status: 'ANALYZED' }]
  };
  const analysisResult = {
    schema: 'core.analysis-result/v1',
    analysis_id: `analysis:kneekura-lab-skill-v1:${TARGET_SHA.slice(0, 12)}`,
    session_id: 'session:kneekura-lab-skill-v1',
    repository,
    snapshot,
    status: 'COMPLETE',
    coverage,
    claims: [], evidence: [], unknowns: [], failures: []
  };
  const sourceCatalog = [];
  for (const relative of SOURCE_PATHS) {
    const text = await fs.readFile(path.join(canonicalRoot, relative), 'utf8');
    sourceCatalog.push({ path: relative, content_digest: digest(text), line_count: text.split(/\r?\n/).length });
  }
  const pack = createHumanAnalysisEvidencePack({ repository, snapshot, graph, result: analysisResult, evidence: [], source_catalog: sourceCatalog });
  const broker = createHumanAnalysisSourceBroker(pack, { readSource: relative => fs.readFile(path.join(canonicalRoot, relative), 'utf8') });
  const explorerProjection = createExplorerProjection({ graph, result: analysisResult });
  const scopeDigest = digest(`KNEEKURA-LAB\0${TARGET_SHA}\0KNEEKURA_ANALYZABLE_PATHS\0three-engine-v1`);

  const kneekura = await runNativeKneekuraHumanGuide({
    evidencePack: pack,
    sourceBroker: broker,
    explorerProjection,
    semanticAuthorHost: createKneekuraAuthor(),
    semanticAuthorId: 'chatgpt-kneekura-lab-acceptance',
    semanticProviderId: 'chatgpt',
    locale: 'ja-JP',
    request: {
      question: 'KNEEKURA-LABの実機観測からoffline Viewerまでの主要コード境界を説明する',
      audience: 'HUMAN',
      target_repository: TARGET_REPOSITORY,
      target_revision: TARGET_SHA,
      source_scope: 'KNEEKURA_ANALYZABLE_PATHS'
    },
    attemptId: 'kneekura-lab-kneekura-v1',
    scopeDigest,
    minimumClaimLevel: 'NATIVE',
    title: 'KNEEKURA-LAB — KNEEKURA Human Guide acceptance'
  });
  assert.equal(kneekura.receipt.status, 'SUCCESS');
  assertReceipt(kneekura.receipt, snapshot.snapshot_id, scopeDigest, 'kneekura');

  const uaView = path.join(run.root, 'views', 'understand-anything');
  await fs.mkdir(path.dirname(uaView), { recursive: true });
  await fs.cp(canonicalRoot, uaView, { recursive: true, force: false, errorOnExist: true });
  runGit(uaView, ['init']);
  runGit(uaView, ['config', 'core.autocrlf', 'false']);
  runGit(uaView, ['config', 'commit.gpgSign', 'false']);
  runGit(uaView, ['config', 'user.email', 'acceptance@example.invalid']);
  runGit(uaView, ['config', 'user.name', 'KNEEKURA Acceptance']);
  runGit(uaView, ['add', '--all']);
  runGit(uaView, ['commit', '--no-gpg-sign', '-m', 'private analysis view']);

  const preScanPath = path.join(run.root, 'ua-prescan.json');
  const uaSkillDir = path.join(UA_ROOT, 'understand-anything-plugin', 'skills', 'understand');
  const preScan = await executeUaHelper({ helper: 'scan-project', skillDir: uaSkillDir, targetRoot: uaView, args: [uaView, preScanPath] });
  assert.equal(preScan.status, 0);
  const preScanJson = JSON.parse(await fs.readFile(preScanPath, 'utf8'));
  assert.equal(preScanJson.scriptCompleted, true);
  const analysisViewManifest = { entries: preScanJson.files.map(file => ({ path: file.path, classification: 'semantic-input' })) };
  const ua = await runStableUnderstandAnythingEngine({
    uaRoot: UA_ROOT,
    dashboardRoot: UA_DASHBOARD_ROOT,
    dashboardAcceptance: {
      status: 'SKIPPED',
      reason: 'Dashboard bytes are included, but this target acceptance does not promote a build-only check into browser acceptance.'
    },
    targetRoot: uaView,
    targetSnapshotId: snapshot.snapshot_id,
    targetRevision: TARGET_SHA,
    analysisViewPrivate: true,
    analysisViewManifest,
    semanticScheduler: createUaScheduler(run.root),
    runRoot: run.root,
    attemptId: 'kneekura-lab-ua-v1',
    scopeDigest,
    minimumClaimLevel: 'NATIVE',
    hostCapabilities: { semanticSubagentIsolation: true, targetAcceptanceRoleProcesses: true }
  });
  assert.equal(ua.receipt.status, 'SUCCESS');
  assert.equal(ua.receipt.claimLevel, 'NATIVE');
  assert.equal(ua.receipt.claimSatisfied, true);
  assert.deepEqual(ua.receipt.coverage.missing_host_semantic_inputs, []);
  assertReceipt(ua.receipt, snapshot.snapshot_id, scopeDigest, 'understand-anything');

  // Archify's upstream repository-evidence verifier intentionally requires a
  // Git top-level with the authored origin and exact commit object. Use the
  // single exact object-store repository that also fed the hardened canonical
  // materializer; do not create or inspect a second checkout.
  const archify = await runStableArchifyEngine({
    archifyRoot: ARCHIFY_ROOT,
    archifyArtifactSha256: ARCHIFY_SHA256,
    targetRoot: TARGET_GIT_ROOT,
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
      reason: 'Automated upstream visual-check runs in CI; human perceptual review remains a separate acceptance axis.'
    }
  });
  assert.equal(archify.receipt.status, 'SUCCESS');
  assert.equal(archify.receipt.acceptance.browser_visual_check.status, 'PASS');
  assert.equal(archify.receipt.coverage.target_repository_binding, true);
  assertReceipt(archify.receipt, snapshot.snapshot_id, scopeDigest, 'archify');

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
      source_scope: 'KNEEKURA_ANALYZABLE_PATHS',
      materialized_files: materialized.materialized_files.length,
      semantic_reference_files: SOURCE_PATHS,
      git_object_integrity: materialized.integrity
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
  for (const [name, receipt] of [['kneekura', kneekura.receipt], ['understand-anything', ua.receipt], ['archify', archify.receipt]]) {
    await fs.writeFile(path.join(outputRoot, `${name}.receipt.json`), JSON.stringify(receipt, null, 2) + '\n');
  }
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
} finally {
  await materialized.cleanup();
  await removeSkillRunRoot(run.root, { expectedRunId: 'kneekura-lab-three-engine-v1' });
}

function createKneekuraAuthor() {
  const specs = [
    ['simlab/serve.mjs', 'SimLab service boundary', 'The SimLab service layer exposes analysis and viewer-facing repository functions without making the Viewer the source of runtime truth.'],
    ['simlab/renderpack/compiler.mjs', 'Render Pack compiler', 'The Render Pack compiler turns captured/static rendering inputs into a self-contained replay asset boundary.'],
    ['simlab/renderframe/final-vertex.mjs', 'Render Frame final-vertex path', 'The final-vertex path validates replay-critical captured rendering evidence before authoritative promotion.'],
    ['simlab/golden/oracle.mjs', 'Golden Oracle', 'The Golden Oracle is the comparison boundary used to test Viewer output against reference evidence.'],
    ['simlab/viewer/gl.js', 'Viewer renderer', 'The Viewer renderer consumes KNEEKURA-side representations for offline visualization rather than becoming runtime authority.']
  ];
  return async (envelope, broker) => {
    if (envelope.stage === 'ARCHITECTURE') {
      const items = [];
      for (const [relative, title, body] of specs) {
        const row = await broker.readFileRange({ kind: 'FILE_RANGE', path: relative, start_line: 1, end_line: 24 });
        items.push({
          kind: 'ARCHITECTURE_COMPONENT',
          semantic_class: 'AI_INTERPRETATION',
          title,
          body,
          source_refs: [{ kind: 'FILE_RANGE', path: row.path, start_line: row.start_line, end_line: row.end_line, content_digest: row.content_digest }]
        });
      }
      return { items };
    }
    if (envelope.stage === 'REVIEWER') {
      return { decisions: envelope.candidate_items.map(item => ({ item_id: item.id, status: 'ACCEPT', reason: 'Pinned-source-linked production acceptance item' })) };
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
      await fs.writeFile(inputPath, JSON.stringify({ ...payload, acceptanceTarget: 'KNEEKURA-LAB' }));
      childProcess.execFileSync(process.execPath, [path.join(HERE, 'ua-target-acceptance-role.mjs'), role, inputPath, outputPath], {
        cwd: root,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: Object.fromEntries(Object.entries({ PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, TEMP: process.env.TEMP, TMP: process.env.TMP }).filter(([, value]) => value != null))
      });
      return JSON.parse(await fs.readFile(outputPath, 'utf8'));
    }
  };
}

function archifyIr() {
  return {
    schema_version: 1,
    diagram_type: 'architecture',
    meta: {
      title: 'KNEEKURA-LAB — analyzable code path to offline viewer',
      locale: 'en',
      quality_profile: 'showcase',
      repository: { url: TARGET_URL, revision: TARGET_SHA },
      views: [
        { id: 'replay-path', label: 'Replay path', focus: ['serve','renderpack','renderframe','viewer','golden'], note: 'Follow the pinned analyzable code path through compilation, replay data, viewer rendering, and comparison.' },
        { id: 'authority-boundary', label: 'Authority boundary', focus: ['renderframe','viewer','golden'], note: 'Captured evidence and Viewer-side rendering remain separate authority classes.' }
      ]
    },
    layout: { mode: 'grid', origin: [40, 120], cols: 5, gapX: 55, gapY: 90, cellW: 155, cellH: 72 },
    components: [
      { id: 'serve', type: 'backend', label: 'SimLab Service', sublabel: 'analysis/viewer entry', row: 0, col: 0, sources: [{ path: 'simlab/serve.mjs', line: 1 }] },
      { id: 'renderpack', type: 'database', label: 'Render Pack', sublabel: 'self-contained assets', row: 0, col: 1, sources: [{ path: 'simlab/renderpack/compiler.mjs', line: 1 }] },
      { id: 'renderframe', type: 'security', label: 'Render Frame', sublabel: 'captured evidence', row: 0, col: 2, sources: [{ path: 'simlab/renderframe/final-vertex.mjs', line: 1 }] },
      { id: 'viewer', type: 'frontend', label: 'Viewer Renderer', sublabel: 'offline visualization', row: 0, col: 3, sources: [{ path: 'simlab/viewer/gl.js', line: 1 }] },
      { id: 'golden', type: 'security', label: 'Golden Oracle', sublabel: 'comparison gate', row: 0, col: 4, sources: [{ path: 'simlab/golden/oracle.mjs', line: 1 }] }
    ],
    connections: [
      { id: 'serve-renderpack', from: 'serve', to: 'renderpack', variant: 'emphasis' },
      { id: 'renderpack-renderframe', from: 'renderpack', to: 'renderframe', variant: 'emphasis' },
      { id: 'renderframe-viewer', from: 'renderframe', to: 'viewer', variant: 'security' },
      { id: 'viewer-golden', from: 'viewer', to: 'golden', variant: 'emphasis' }
    ],
    cards: [
      { dot: 'rose', title: 'Truth', items: ['Exact target revision is preserved', 'Viewer interpretation is not promoted by consensus'] },
      { dot: 'cyan', title: 'Scope', items: ['This acceptance uses KNEEKURA analyzable paths', 'Coverage is explicit rather than pretending docs/binaries were analyzed'] },
      { dot: 'emerald', title: 'Verification', items: ['Upstream validate/deliver/visual-check remain native Archify receipts', 'Human perceptual review stays a separate axis'] }
    ]
  };
}

function runGit(cwd, args) {
  return childProcess.execFileSync('git', ['-c', 'core.hooksPath=NUL', '-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
}

function assertReceipt(receipt, snapshotId, scopeDigest, engineId) {
  assert.equal(receipt.engineId, engineId);
  assert.equal(receipt.snapshotId, snapshotId);
  assert.equal(receipt.scopeDigest, scopeDigest);
  assert.equal(validateEngineRunReceipt(receipt), true);
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

function requiredEnv(name) {
  const value = String(process.env[name] ?? '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function digest(value) {
  return 'sha256:' + crypto.createHash('sha256').update(value).digest('hex');
}