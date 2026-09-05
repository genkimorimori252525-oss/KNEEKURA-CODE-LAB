import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import ELK from 'elkjs/lib/elk.bundled.js';

import { runTypeScriptSemanticVertical } from '../src/analyzer-fabric/typescript-vertical.mjs';
import { scanRepository } from '../src/core/scan.mjs';
import {
  assertHumanAnalysisSourcePayloadBudget,
  compileProductionRepositoryScaleHumanExplorerArtifact,
  createHumanAnalysisEvidencePack,
  createHumanAnalysisSourceBroker,
  createRepositoryScaleReadiness,
  HUMAN_ANALYSIS_PERFORMANCE_BUDGETS,
  HUMAN_ANALYSIS_PERFORMANCE_SCHEMA,
  HUMAN_ANALYSIS_REPLAY_LOCK_SCHEMA,
  planRepositoryDomainBatches,
  runRepositoryScaleProductionAuthoring,
  stableDigest,
  writeHumanAnalysisArtifact
} from '../src/human-analysis/index.mjs';
import { layoutExplorerUiModel } from '../src/presentation/explorer/layout.mjs';
import {
  createHumanExplorerSystemMap,
  searchHumanExplorerSystemMap
} from '../packages/human-explorer/src/system-map.mjs';

const exec = promisify(execFile);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const R3_ROOT = path.join(ROOT, 'dist', 'r3-love-github-production');
const OUTPUT_ROOT = path.join(ROOT, 'dist', 'r4-love-github-production');
const RECORD_PATH = path.join(ROOT, 'golden', 'human-analysis', 'love-github-r4-authoring.json');
const FIXED_COMMIT = '5d647785bfeee1b8892e9ba782b04a76f1b63fff';
const EXPECTED_INVENTORY_FILES = 87;
const EXPECTED_BATCHES = 16;
const cmp = (a, b) => String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
const sha = value => 'sha256:' + crypto.createHash('sha256').update(value).digest('hex');
let peakHeapBytes = process.memoryUsage().heapUsed;
const sampleHeap = () => {
  peakHeapBytes = Math.max(peakHeapBytes, process.memoryUsage().heapUsed);
};
const heapSampler = setInterval(sampleHeap, 25);
heapSampler.unref();

await import('./run-love-github-human-guide-production-r3.mjs');
sampleHeap();
assert(
  (globalThis.__KNEEKURA_R4_NPM_CI_INTERCEPTS__ ?? 0) >= 1,
  'R4 must force the nested fixed Love-Github R1/R3 generation path through npm ci'
);

const [experience, presentation, technicalViews, baseSources] = await Promise.all([
  readJson(path.join(R3_ROOT, 'experience.json')),
  readJson(path.join(R3_ROOT, 'presentation.json')),
  readJson(path.join(R3_ROOT, 'technical-views.json')),
  readJson(path.join(R3_ROOT, 'sources.json'))
]);

const savedRecord = await readJson(RECORD_PATH);
assert.equal(savedRecord.schema, 'kneekura.saved-repository-scale-authoring/v1');
assert.equal(savedRecord.authoring_origin, 'SAVED_AI_AUTHORING_RUN');
assert.equal(savedRecord.repository, 'genkimorimori252525-oss/Love-Github');
assert.equal(savedRecord.commit, FIXED_COMMIT);
assert.equal(savedRecord.semantic_author.acceptance_fixture, false);
assert.equal(savedRecord.semantic_author.locale, 'ja-JP');

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'kneekura-r4-love-github-'));
const repoRoot = path.join(temp, 'repo');
try {
  const sourceRoot = await findLoveGithubRoot();
  await checkoutFixedSnapshot(sourceRoot, repoRoot, FIXED_COMMIT);
  const targetPackageRaw = await fs.readFile(path.join(repoRoot, 'package.json'), 'utf8');
  const targetLockRaw = await fs.readFile(path.join(repoRoot, 'package-lock.json'), 'utf8');
  const targetPackage = JSON.parse(targetPackageRaw);
  const kneekuraPackageRaw = await fs.readFile(path.join(ROOT, 'package.json'), 'utf8');
  const kneekuraLockRaw = await fs.readFile(path.join(ROOT, 'package-lock.json'), 'utf8');
  const kneekuraPackage = JSON.parse(kneekuraPackageRaw);

  await npm(repoRoot, ['ci', '--include=dev', '--no-audit', '--no-fund']);
  await npm(repoRoot, ['ls', '@types/node', '--depth=0']);
  await npm(repoRoot, ['run', 'typecheck']);
  const npmVersion = (await npm(repoRoot, ['--version'])).stdout.trim();
  sampleHeap();

  const require = createRequire(import.meta.url);
  const imported = require('@typescript/typescript6');
  const ts = typeof imported?.createProgram === 'function' ? imported : imported.default;
  assert.equal(String(ts.version), String(kneekuraPackage.devDependencies['@typescript/typescript6']));

  const vertical = await runTypeScriptSemanticVertical({
    rootDirectory: repoRoot,
    commitSha: FIXED_COMMIT,
    typescript: ts,
    expectedTypeScriptVersion: String(ts.version),
    requireClean: true
  });
  assert.equal(vertical.summary.canonical_claims, 0);
  const catalog = await buildCatalog(repoRoot, vertical.profile.files);
  assert.equal(catalog.length, EXPECTED_INVENTORY_FILES);
  assert.equal(vertical.summary.typescript_files, EXPECTED_INVENTORY_FILES);
  sampleHeap();

  const graph = await scanRepository(repoRoot, {
    repositoryIdentity: vertical.repository,
    snapshotIdentity: vertical.snapshot
  });
  const coverage = vertical.evidence_ledger.coverage;
  const result = {
    schema: 'core.analysis-result/v1',
    analysis_id: `analysis:love-github-r4:${FIXED_COMMIT.slice(0, 12)}`,
    session_id: 'session:love-github-r4-production',
    repository: vertical.repository,
    snapshot: vertical.snapshot,
    status: ['COMPLETE', 'BOUNDED'].includes(coverage.completeness) ? 'COMPLETE' : 'PARTIAL',
    coverage,
    claims: vertical.evidence_ledger.claims,
    evidence: vertical.evidence_ledger.evidence,
    unknowns: [],
    failures: vertical.execution.failures ?? []
  };
  const pack = createHumanAnalysisEvidencePack({
    repository: vertical.repository,
    snapshot: vertical.snapshot,
    graph,
    result,
    evidence: vertical.evidence_ledger.evidence,
    source_catalog: catalog
  });
  assert.equal(experience.repository.repository_id, pack.repository.repository_id);
  assert.equal(experience.repository.snapshot_id, pack.repository.snapshot_id);

  const broker = createHumanAnalysisSourceBroker(pack, {
    readSource: relative => fs.readFile(path.join(repoRoot, relative), 'utf8')
  });
  const batchPlan = planRepositoryDomainBatches(catalog, { maxFilesPerBatch: 64 });
  assert.equal(batchPlan.batches.length, EXPECTED_BATCHES);
  const savedByDomainPath = new Map(savedRecord.records.map(record => [
    `${record.domain}\0${record.representative_path}`,
    record
  ]));
  const authoringRecords = batchPlan.batches.map(batch => {
    const saved = savedByDomainPath.get(`${batch.domain}\0${batch.representative_path}`);
    if (!saved) throw new Error(`R4_SAVED_AUTHORING_RECORD_MISSING:${batch.domain}:${batch.representative_path}`);
    return { ...saved, batch_id: batch.batch_id };
  });
  assert.equal(authoringRecords.length, savedRecord.records.length);

  const authoring = await runRepositoryScaleProductionAuthoring({
    evidencePack: pack,
    sourceBroker: broker,
    batchPlan,
    records: authoringRecords,
    authorId: savedRecord.semantic_author.id,
    providerId: savedRecord.semantic_author.provider_id,
    locale: savedRecord.semantic_author.locale
  });
  assert.equal(authoring.ir.generation.mode, 'PRODUCTION');
  assert.equal(authoring.ir.generation.user_deliverable, true);
  assert.equal(authoring.ir.review.accepted_item_ids.length, EXPECTED_BATCHES);
  assert.equal(authoring.ir.review.rejected_item_ids.length, 0);
  assert.equal(authoring.read_receipts.filter(row => row.read_kind === 'FILE_RANGE').length, EXPECTED_BATCHES);
  sampleHeap();

  const mergedSources = [...baseSources.records, ...authoring.sources];
  const sourcePayload = assertHumanAnalysisSourcePayloadBudget(mergedSources);
  const replayLock = {
    schema: HUMAN_ANALYSIS_REPLAY_LOCK_SCHEMA,
    analyzed_commit: FIXED_COMMIT,
    node_version: process.version,
    npm_version: npmVersion,
    typescript_version: String(ts.version),
    vite_version: String(kneekuraPackage.devDependencies.vite),
    package_manifest_digest: sha(targetPackageRaw),
    lockfile_digest: sha(targetLockRaw),
    authoring_record_digest: stableDigest(savedRecord)
  };
  const readinessInput = {
    repository: pack.repository,
    sourceCatalog: catalog,
    scannerPaths: catalog.map(row => row.path),
    readReceipts: authoring.read_receipts,
    sources: mergedSources,
    batches: authoring.reviewed_batches,
    integrationReview: authoring.integration_review,
    replayLock
  };
  const passMetrics = Object.fromEntries(
    Object.keys(HUMAN_ANALYSIS_PERFORMANCE_BUDGETS).map(key => [key, 0])
  );
  const candidateScale = createRepositoryScaleReadiness({
    ...readinessInput,
    performance: {
      schema: HUMAN_ANALYSIS_PERFORMANCE_SCHEMA,
      metrics: passMetrics
    }
  });
  assert.equal(candidateScale.readiness.status, 'READY_REPOSITORY_SCALE');
  assert.equal(candidateScale.readiness.repository_scale_ready, true);
  assert.equal(candidateScale.inventory.total_files, EXPECTED_INVENTORY_FILES);
  assert.equal(candidateScale.batches.length, EXPECTED_BATCHES);
  assert.equal(candidateScale.coverage.scanner.covered_files, EXPECTED_INVENTORY_FILES);
  assert.equal(candidateScale.coverage.ai_read.covered_files, EXPECTED_BATCHES);

  let artifact = await compileProductionRepositoryScaleHumanExplorerArtifact({
    experience,
    sources: baseSources.records,
    presentation,
    technicalViews,
    repositoryScale: candidateScale,
    repositoryAuthoringIr: authoring.ir,
    repositorySources: authoring.sources,
    title: 'Love-Github Human Explorer — R4 repository-scale production'
  });
  sampleHeap();

  const offlinePayload = extractOfflinePayload(artifact.index_html);
  const systemMapStarted = performance.now();
  const systemMap = createHumanExplorerSystemMap({
    projection: experience.canonical.explorer_projection,
    offlinePayload
  });
  const systemMapBuildMs = performance.now() - systemMapStarted;
  assert.equal(systemMap.stats.source_catalog_files, EXPECTED_INVENTORY_FILES);
  const searchP95Ms = benchmarkSearch(systemMap, catalog);
  const layoutResult = await benchmarkEnlargedLayout();
  sampleHeap();

  await fs.rm(OUTPUT_ROOT, { recursive: true, force: true });
  const written = await writeHumanAnalysisArtifact({
    artifact,
    outDir: OUTPUT_ROOT,
    zipFile: 'love-github-r4-human-explorer.zip'
  });
  const startup = validateAndMeasureFileBrowser(written.index_path);
  sampleHeap();

  const firstArtifactId = artifact.artifact_id;
  const firstZipDigest = artifact.zip_digest;
  const firstZipBytes = artifact.zip_bytes.length;
  const replayArtifact = await compileProductionRepositoryScaleHumanExplorerArtifact({
    experience,
    sources: baseSources.records,
    presentation,
    technicalViews,
    repositoryScale: candidateScale,
    repositoryAuthoringIr: authoring.ir,
    repositorySources: authoring.sources,
    title: 'Love-Github Human Explorer — R4 repository-scale production'
  });
  sampleHeap();
  assert.equal(replayArtifact.artifact_id, firstArtifactId);
  assert.equal(replayArtifact.zip_digest, firstZipDigest);
  assert.equal(replayArtifact.zip_bytes.length, firstZipBytes);
  assert(replayArtifact.zip_bytes.equals(artifact.zip_bytes));

  clearInterval(heapSampler);
  sampleHeap();
  const measuredMetrics = {
    startup_ms: startup.startup_ms,
    search_p95_ms: searchP95Ms,
    layout_p95_ms: layoutResult.p95_ms,
    zip_bytes: firstZipBytes,
    peak_heap_bytes: peakHeapBytes
  };
  const measuredScale = createRepositoryScaleReadiness({
    ...readinessInput,
    performance: {
      schema: HUMAN_ANALYSIS_PERFORMANCE_SCHEMA,
      metrics: measuredMetrics
    }
  });
  assert.equal(measuredScale.readiness.status, 'READY_REPOSITORY_SCALE', JSON.stringify(measuredMetrics));
  assert.equal(measuredScale.readiness.repository_scale_ready, true);
  assert.equal(measuredScale.readiness_id, candidateScale.readiness_id);
  assert.equal(stableDigest(measuredScale), stableDigest(candidateScale));

  const report = {
    schema: 'kneekura.live-love-github-production-r4/v1',
    product_commit: process.env.GITHUB_SHA ?? null,
    analyzed_repository: savedRecord.repository,
    analyzed_commit: FIXED_COMMIT,
    generation_mode: authoring.ir.generation.mode,
    repository_scale_readiness: measuredScale.readiness.status,
    repository_scale_readiness_id: measuredScale.readiness_id,
    inventory_files: measuredScale.inventory.total_files,
    domain_batches: measuredScale.batches.length,
    accepted_domain_items: authoring.ir.review.accepted_item_ids.length,
    rejected_domain_items: authoring.ir.review.rejected_item_ids.length,
    direct_ai_file_reads: authoring.read_receipts.filter(row => row.read_kind === 'FILE_RANGE').length,
    scanner_coverage: measuredScale.coverage.scanner,
    ai_read_coverage: measuredScale.coverage.ai_read,
    offline_source_coverage: measuredScale.coverage.offline_source,
    source_payload: {
      records: sourcePayload.source_records,
      text_records: sourcePayload.text_records,
      total_text_bytes: sourcePayload.total_text_bytes,
      max_record_text_bytes: sourcePayload.max_record_text_bytes
    },
    replay_lock: measuredScale.replay_lock,
    target_toolchain: {
      required_node: targetPackage.engines?.node ?? null,
      typescript: targetPackage.devDependencies?.typescript ?? null,
      package_manifest_digest: sha(targetPackageRaw),
      lockfile_digest: sha(targetLockRaw),
      npm_ci_verified: true,
      nested_r1_r3_npm_ci_intercepts: globalThis.__KNEEKURA_R4_NPM_CI_INTERCEPTS__ ?? 0
    },
    generator_toolchain: {
      node: process.version,
      npm: npmVersion,
      analyzer_typescript: String(ts.version),
      vite: String(kneekuraPackage.devDependencies.vite),
      package_manifest_digest: sha(kneekuraPackageRaw),
      lockfile_digest: sha(kneekuraLockRaw)
    },
    performance_budget_profile: measuredScale.performance.budget_profile,
    performance_budgets: measuredScale.performance.budgets,
    performance_within_budget: measuredScale.performance.within_budget,
    measured_performance: measuredMetrics,
    system_map_build_ms: systemMapBuildMs,
    enlarged_layout_fixture: {
      nodes: layoutResult.nodes,
      edges: layoutResult.edges,
      samples: layoutResult.samples
    },
    deterministic_artifact_replay: true,
    file_browser_verified: true,
    artifact_id: firstArtifactId,
    zip_digest: firstZipDigest,
    zip_bytes: firstZipBytes
  };
  await fs.writeFile(
    path.join(OUTPUT_ROOT, 'r4-production-report.json'),
    JSON.stringify(report, null, 2) + '\n',
    'utf8'
  );
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  artifact = null;
} finally {
  clearInterval(heapSampler);
  await fs.rm(temp, { recursive: true, force: true });
}

async function npm(cwd, args) {
  if (process.env.npm_execpath) {
    return exec(process.execPath, [process.env.npm_execpath, ...args], {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024
    });
  }
  if (process.platform === 'win32') {
    return exec(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'npm', ...args], {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024
    });
  }
  return exec('npm', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  });
}

async function findLoveGithubRoot() {
  const home = os.homedir();
  const candidates = [
    process.env.LOVE_GITHUB_ROOT,
    path.join(home, 'Downloads', 'Love-Github'),
    path.join(home, 'Downloads', 'love-github'),
    path.join(home, 'Desktop', 'Love-Github'),
    path.join(home, 'Documents', 'Love-Github')
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (!fsSync.existsSync(path.join(candidate, '.git'))) continue;
    try {
      const remote = (await exec('git', ['-C', candidate, 'remote', 'get-url', 'origin'], {
        encoding: 'utf8', windowsHide: true
      })).stdout.trim();
      if (/(?:^|[\\/:])Love-Github(?:\.git)?$/i.test(remote)) return path.resolve(candidate);
    } catch {}
  }
  throw new Error('R4_LOVE_GITHUB_REPO_NOT_FOUND');
}

async function checkoutFixedSnapshot(sourceRoot, targetRoot, commitSha) {
  await exec('git', ['clone', '--no-hardlinks', '--no-checkout', sourceRoot, targetRoot], {
    encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024
  });
  try {
    await exec('git', ['-C', targetRoot, 'cat-file', '-e', `${commitSha}^{commit}`], {
      encoding: 'utf8', windowsHide: true
    });
  } catch {
    const remote = (await exec('git', ['-C', sourceRoot, 'remote', 'get-url', 'origin'], {
      encoding: 'utf8', windowsHide: true
    })).stdout.trim();
    await exec('git', ['-C', targetRoot, 'remote', 'set-url', 'origin', remote], { encoding: 'utf8', windowsHide: true });
    await exec('git', ['-C', targetRoot, 'fetch', '--no-tags', 'origin', commitSha], {
      encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024
    });
  }
  await exec('git', ['-C', targetRoot, 'checkout', '--detach', commitSha], {
    encoding: 'utf8', windowsHide: true
  });
  const head = (await exec('git', ['-C', targetRoot, 'rev-parse', 'HEAD'], {
    encoding: 'utf8', windowsHide: true
  })).stdout.trim().toLowerCase();
  assert.equal(head, commitSha.toLowerCase());
}

async function buildCatalog(root, files) {
  const rows = [];
  for (const file of files) {
    if (file.primary_language !== 'TYPESCRIPT') continue;
    const raw = await fs.readFile(path.join(root, file.path), 'utf8');
    rows.push({
      path: file.path,
      content_digest: sha(raw),
      line_count: raw.split(/\r?\n/).length
    });
  }
  return rows.sort((a, b) => cmp(a.path, b.path));
}

function extractOfflinePayload(html) {
  const marker = '<script id="kneekura-human-experience" type="application/octet-stream">';
  const start = html.indexOf(marker);
  assert(start >= 0, 'R4 offline payload marker is missing');
  const bodyStart = start + marker.length;
  const end = html.indexOf('</script>', bodyStart);
  assert(end >= 0, 'R4 offline payload terminator is missing');
  return JSON.parse(Buffer.from(html.slice(bodyStart, end).trim(), 'base64').toString('utf8'));
}

function benchmarkSearch(systemMap, catalog) {
  const samples = [];
  for (let cycle = 0; cycle < 5; cycle += 1) {
    for (const entry of catalog) {
      const started = performance.now();
      const results = searchHumanExplorerSystemMap(systemMap, entry.path, { limit: 20 });
      samples.push(performance.now() - started);
      assert(results.some(row => row.path === entry.path), `R4 System Map search missed inventory path: ${entry.path}`);
    }
  }
  return percentile95(samples);
}

async function benchmarkEnlargedLayout() {
  const nodes = 300;
  const edges = 600;
  const model = createSyntheticUiModel(nodes, edges);
  const elk = new ELK();
  const samples = [];
  for (let index = 0; index < 3; index += 1) {
    const started = performance.now();
    const layout = await layoutExplorerUiModel(model, elk);
    samples.push(performance.now() - started);
    assert.equal(layout.nodes.length, nodes);
    assert.equal(layout.edges.length, edges);
  }
  return { nodes, edges, samples, p95_ms: percentile95(samples) };
}

function createSyntheticUiModel(nodeCount, edgeCount) {
  const nodes = Array.from({ length: nodeCount }, (_, index) => ({
    id: `r4-node-${String(index).padStart(4, '0')}`,
    canonical_index: index,
    position: { x: 0, y: 0 },
    width: 240,
    height: 72,
    data: {
      label: `R4 enlarged node ${index}`,
      canonical_kind: 'fixture:symbol',
      display_family: 'R4_ENLARGED',
      canonical_node_id: `r4-node-${String(index).padStart(4, '0')}`
    }
  }));
  const edges = [];
  for (let index = 0; index < edgeCount; index += 1) {
    const sourceIndex = index % nodeCount;
    const targetIndex = (sourceIndex + 1 + Math.floor(index / nodeCount)) % nodeCount;
    edges.push({
      id: `r4-edge-${String(index).padStart(4, '0')}`,
      canonical_index: index,
      source: nodes[sourceIndex].id,
      target: nodes[targetIndex].id,
      data: {
        canonical_edge_id: `r4-edge-${String(index).padStart(4, '0')}`,
        canonical_type: 'FIXTURE_RELATION'
      }
    });
  }
  return {
    schema: 'kneekura.explorer-ui-model/v1',
    projection_schema: 'kneekura.explorer-projection/v1',
    source: { repository_id: 'fixture:r4', snapshot_id: 'fixture:r4:enlarged' },
    nodes,
    edges
  };
}

function percentile95(values) {
  assert(values.length > 0);
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
}

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe')
  ].filter(Boolean);
  const found = candidates.find(candidate => fsSync.existsSync(candidate));
  if (!found) throw new Error('R4_CHROME_NOT_FOUND');
  return found;
}

function validateAndMeasureFileBrowser(indexPath) {
  const profile = path.join(os.tmpdir(), `kneekura-r4-chrome-${process.pid}`);
  const started = performance.now();
  const launched = spawnSync(
    findChrome(),
    [
      '--headless=new', '--disable-gpu', '--disable-extensions', '--disable-background-networking',
      '--no-first-run', '--no-default-browser-check', '--virtual-time-budget=8000',
      `--user-data-dir=${profile}`, '--dump-dom', pathToFileURL(indexPath).href
    ],
    { encoding: 'utf8', timeout: 90000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }
  );
  const startupMs = performance.now() - started;
  try {
    if (launched.error) throw launched.error;
    if (launched.status !== 0) {
      throw new Error(`R4_CHROME_FAILED:${launched.status}:${String(launched.stderr ?? '').slice(-3000)}`);
    }
    const dom = String(launched.stdout ?? '');
    for (const expected of [
      'KNEEKURA コードエクスプローラー',
      'リポジトリ規模の解析',
      'Repository-scale readiness',
      '87 files',
      'Domain batches',
      'Replay / performance gate',
      'packages/agent-api/src/mcp.ts',
      '技術ビュー'
    ]) {
      assert(dom.includes(expected), `R4 rendered DOM missing: ${expected}`);
    }
    assert(!dom.includes('Explorer presentation failed.'));
    return { startup_ms: startupMs };
  } finally {
    fsSync.rmSync(profile, { recursive: true, force: true });
  }
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}