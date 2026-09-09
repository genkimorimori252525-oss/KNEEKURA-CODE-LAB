import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  compileProductionRepositoryScaleHumanExplorerArtifact,
  stableDigest,
  validateRepositoryScaleReadiness
} from '../src/human-analysis/index.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const R3_ROOT = path.join(ROOT, 'dist', 'r3-love-github-production');
const R4_ROOT = path.join(ROOT, 'dist', 'r4-love-github-production');
const GOLDEN_PATH = path.join(
  ROOT,
  'golden',
  'human-analysis',
  'love-github-r5-production-golden.json'
);
const R4_REPORT_PATH = path.join(R4_ROOT, 'r4-production-report.json');
const R5_REPORT_PATH = path.join(R4_ROOT, 'r5-production-golden-report.json');
const INDEX_PATH = path.join(R4_ROOT, 'index.html');
const MANIFEST_PATH = path.join(R4_ROOT, 'manifest.json');
const ZIP_PATH = path.join(R4_ROOT, 'love-github-r4-human-explorer.zip');
const R4_TITLE =
  'Love-Github Human Explorer — R4 repository-scale production';
const R3_REUSABLE_SIDECARS = new Set([
  'analysis.json',
  'coverage.json',
  'experience.json',
  'presentation.json',
  'technical-views.json'
]);
const PAYLOAD_MARKER =
  '<script id="kneekura-human-experience" type="application/octet-stream">';

const golden = await readJson(GOLDEN_PATH);
assert.equal(
  golden.schema,
  'kneekura.love-github-production-golden/v1'
);
assert.equal(
  golden.analyzed_repository,
  'genkimorimori252525-oss/Love-Github'
);

await runCommand(
  process.execPath,
  [path.join(ROOT, 'scripts', 'run-love-github-human-guide-production-r4.mjs')],
  {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_OPTIONS: '--max-old-space-size=960'
    }
  }
);

const r4Report = await readJson(R4_REPORT_PATH);
assertR4GoldenIdentity(r4Report, golden);

const [browserTask, offlineTask, adversarialTask, humanTask] =
  await Promise.all([
    Promise.resolve().then(() => runBrowserGolden(INDEX_PATH)),
    runOfflineGolden(),
    runAdversarialGolden(),
    runHumanGolden(r4Report, golden)
  ]);

const replayTask = await runSavedIrReplay(r4Report, golden);
const manifestDigest = await shaFile(MANIFEST_PATH);
const indexDigest = await shaFile(INDEX_PATH);
const zipDigest = await shaFile(ZIP_PATH);
const zipStat = await fs.stat(ZIP_PATH);

assert.equal(zipDigest, golden.expected.zip_digest);
assert.equal(zipStat.size, golden.expected.zip_bytes);

const report = {
  schema: 'kneekura.live-love-github-production-r5-golden/v1',
  product_commit: process.env.GITHUB_SHA ?? null,
  analyzed_repository: golden.analyzed_repository,
  analyzed_commit: golden.analyzed_commit,
  source_golden: {
    schema: golden.schema,
    source_ci_run: golden.source_ci_run,
    source_head_sha: golden.source_head_sha,
    golden_digest: stableDigest(golden)
  },
  repository_scale_readiness:
    r4Report.repository_scale_readiness,
  repository_scale_readiness_id:
    r4Report.repository_scale_readiness_id,
  artifact: {
    artifact_id: r4Report.artifact_id,
    manifest_digest: manifestDigest,
    index_digest: indexDigest,
    zip_digest: zipDigest,
    zip_bytes: zipStat.size
  },
  saved_ir_replay: replayTask,
  golden_tasks: {
    browser: browserTask,
    offline: offlineTask,
    adversarial: adversarialTask,
    human: humanTask
  },
  known_coverage_gaps: golden.known_coverage_gaps
};

await fs.writeFile(
  R5_REPORT_PATH,
  JSON.stringify(report, null, 2) + '\n',
  'utf8'
);
process.stdout.write(JSON.stringify(report, null, 2) + '\n');

function assertR4GoldenIdentity(reportValue, goldenValue) {
  assert.equal(
    reportValue.schema,
    'kneekura.live-love-github-production-r4/v1'
  );
  assert.equal(
    reportValue.analyzed_repository,
    goldenValue.analyzed_repository
  );
  assert.equal(reportValue.analyzed_commit, goldenValue.analyzed_commit);
  assert.equal(reportValue.generation_mode, 'PRODUCTION');
  assert.equal(
    reportValue.repository_scale_readiness,
    'READY_REPOSITORY_SCALE'
  );
  assert.equal(
    reportValue.repository_scale_readiness_id,
    goldenValue.expected.repository_scale_readiness_id
  );
  assert.equal(
    reportValue.inventory_files,
    goldenValue.expected.inventory_files
  );
  assert.equal(
    reportValue.domain_batches,
    goldenValue.expected.domain_batches
  );
  assert.equal(
    reportValue.accepted_domain_items,
    goldenValue.expected.accepted_domain_items
  );
  assert.equal(
    reportValue.rejected_domain_items,
    goldenValue.expected.rejected_domain_items
  );
  assert.equal(
    reportValue.direct_ai_file_reads,
    goldenValue.expected.direct_ai_file_reads
  );
  assert.equal(
    reportValue.scanner_coverage.covered_files,
    goldenValue.expected.scanner_covered_files
  );
  assert.equal(
    reportValue.scanner_coverage.total_files,
    goldenValue.expected.inventory_files
  );
  assert.equal(
    reportValue.ai_read_coverage.covered_files,
    goldenValue.expected.ai_read_covered_files
  );
  assert.equal(
    reportValue.ai_read_coverage.total_files,
    goldenValue.expected.inventory_files
  );
  assert.equal(
    reportValue.offline_source_coverage.covered_files,
    goldenValue.expected.offline_source_covered_files
  );
  assert.equal(
    reportValue.offline_source_coverage.total_files,
    goldenValue.expected.inventory_files
  );
  assert.equal(reportValue.artifact_id, goldenValue.expected.artifact_id);
  assert.equal(reportValue.zip_digest, goldenValue.expected.zip_digest);
  assert.equal(reportValue.zip_bytes, goldenValue.expected.zip_bytes);
  assert.equal(reportValue.deterministic_artifact_replay, true);
  assert.equal(reportValue.file_browser_verified, true);
  assert.equal(reportValue.isolated_r3_sidecar_reuse, true);
  assert.equal(
    reportValue.performance_budgets.peak_heap_bytes,
    goldenValue.expected.peak_heap_budget_bytes
  );
  assert.equal(
    reportValue.performance_within_budget.peak_heap_bytes,
    true
  );
}

async function runSavedIrReplay(r4Report, goldenValue) {
  const [
    experience,
    presentation,
    technicalViews,
    baseSources,
    repositoryScale,
    repositoryAuthoringIr,
    mergedSources
  ] = await Promise.all([
    readJson(path.join(R3_ROOT, 'experience.json')),
    readJson(path.join(R3_ROOT, 'presentation.json')),
    readJson(path.join(R3_ROOT, 'technical-views.json')),
    readJson(path.join(R3_ROOT, 'sources.json')),
    readJson(path.join(R4_ROOT, 'repository-scale.json')),
    readJson(path.join(R4_ROOT, 'repository-authoring-analysis.json')),
    readJson(path.join(R4_ROOT, 'sources.json'))
  ]);

  assert.equal(validateRepositoryScaleReadiness(repositoryScale), true);
  assert.equal(
    repositoryScale.readiness_id,
    goldenValue.expected.repository_scale_readiness_id
  );

  const prebuiltTechnicalBase =
    await loadR3TechnicalBase(baseSources);
  const baseKeys = new Set(
    baseSources.records.map(record => sourceKey(record.ref))
  );
  const repositorySources = mergedSources.records.filter(
    record => !baseKeys.has(sourceKey(record.ref))
  );

  let replayArtifact =
    await compileProductionRepositoryScaleHumanExplorerArtifact({
      experience,
      sources: baseSources.records,
      presentation,
      technicalViews,
      repositoryScale,
      repositoryAuthoringIr,
      repositorySources,
      title: R4_TITLE,
      prebuiltTechnicalBase
    });

  assert.equal(
    replayArtifact.artifact_id,
    goldenValue.expected.artifact_id
  );
  assert.equal(
    replayArtifact.artifact_id,
    r4Report.artifact_id
  );
  assert.equal(
    replayArtifact.zip_digest,
    goldenValue.expected.zip_digest
  );
  assert.equal(
    replayArtifact.zip_digest,
    r4Report.zip_digest
  );
  assert.equal(
    replayArtifact.zip_bytes.length,
    goldenValue.expected.zip_bytes
  );

  const replayIndexDigest = shaBytes(
    Buffer.from(replayArtifact.index_html, 'utf8')
  );
  const diskIndexDigest = await shaFile(INDEX_PATH);
  assert.equal(replayIndexDigest, diskIndexDigest);

  const result = {
    deterministic: true,
    semantic_author_reexecuted: false,
    repository_authoring_ir_digest:
      repositoryAuthoringIr.ir_digest,
    repository_authoring_ir_file_digest:
      await shaFile(
        path.join(R4_ROOT, 'repository-authoring-analysis.json')
      ),
    replay_artifact_id: replayArtifact.artifact_id,
    replay_index_digest: replayIndexDigest,
    replay_zip_digest: replayArtifact.zip_digest,
    replay_zip_bytes: replayArtifact.zip_bytes.length,
    repository_source_records: repositorySources.length
  };
  replayArtifact = null;
  return result;
}

async function runOfflineGolden() {
  const manifest = await readJson(MANIFEST_PATH);
  assert.equal(
    manifest.schema,
    'kneekura.human-analysis-artifact-manifest/v1'
  );
  assert.equal(manifest.renderer_surface, 'HUMAN_EXPLORER_V2');
  assert.equal(
    manifest.security.external_network_required,
    false
  );
  assert.equal(
    manifest.security.embedded_payload_encoding,
    'BASE64_GZIP_JSON_ENVELOPE'
  );
  assert(
    String(manifest.security.csp).includes("default-src 'none'")
  );

  const head = await readHead(INDEX_PATH, 2 * 1024 * 1024);
  assert(!/<script\b[^>]*\bsrc\s*=/i.test(head));
  assert(!/<link\b[^>]*\bhref\s*=/i.test(head));
  assert(head.includes('Content-Security-Policy'));

  const indexMeta = manifest.files.find(
    file => file.path === 'index.html'
  );
  assert(indexMeta, 'R5 manifest must include index.html');
  const indexDigest = await shaFile(INDEX_PATH);
  const indexStat = await fs.stat(INDEX_PATH);
  assert.equal(indexDigest, indexMeta.digest);
  assert.equal(indexStat.size, indexMeta.bytes);

  return {
    verified: true,
    renderer_surface: manifest.renderer_surface,
    external_network_required:
      manifest.security.external_network_required,
    csp: manifest.security.csp,
    embedded_payload_encoding:
      manifest.security.embedded_payload_encoding,
    index_digest: indexDigest,
    index_bytes: indexStat.size
  };
}

async function runAdversarialGolden() {
  const repositoryScale = await readJson(
    path.join(R4_ROOT, 'repository-scale.json')
  );
  assert.equal(validateRepositoryScaleReadiness(repositoryScale), true);
  const tampered = structuredClone(repositoryScale);
  tampered.coverage.ai_read.ratio = 1;
  assert.throws(
    () => validateRepositoryScaleReadiness(tampered),
    /digest mismatch/
  );

  const tests = [
    'test/human-experience-identity-adversarial.test.mjs',
    'test/human-analysis-repository-scale-r4.test.mjs',
    'test/human-analysis-r4-resource-budgets.test.mjs'
  ];
  await runCommand(
    process.execPath,
    ['--test', ...tests],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        NODE_OPTIONS: '--max-old-space-size=960'
      }
    }
  );
  return {
    verified: true,
    tampered_repository_scale_rejected: true,
    test_files: tests
  };
}

async function runHumanGolden(r4Report, goldenValue) {
  const [
    experience,
    presentation,
    technicalViews,
    repositoryAuthoringIr
  ] = await Promise.all([
    readJson(path.join(R3_ROOT, 'experience.json')),
    readJson(path.join(R3_ROOT, 'presentation.json')),
    readJson(path.join(R3_ROOT, 'technical-views.json')),
    readJson(path.join(R4_ROOT, 'repository-authoring-analysis.json'))
  ]);

  assert.equal(
    presentation.schema,
    'kneekura.human-analysis-presentation/v1'
  );
  assert.equal(
    technicalViews.schema,
    'kneekura.human-analysis-technical-views/v1'
  );
  assert.equal(
    repositoryAuthoringIr.generation.mode,
    'PRODUCTION'
  );
  assert.equal(
    repositoryAuthoringIr.generation.user_deliverable,
    true
  );
  assert.equal(
    repositoryAuthoringIr.review.rejected_item_ids.length,
    0
  );

  const canonicalGraphNodes =
    experience.canonical.explorer_projection.canonical.graph.nodes.length;
  const canonicalClaims =
    experience.canonical.explorer_projection.canonical.result.claims
      ?.length ?? 0;

  assert.equal(
    canonicalGraphNodes,
    goldenValue.expected.canonical_graph_nodes
  );
  assert.equal(
    canonicalClaims,
    goldenValue.expected.canonical_claims
  );

  const components = presentation.components ?? [];
  const flows = presentation.flows ?? [];
  assert(components.length >= 3);
  assert(flows.length >= 1);

  for (const viewName of [
    'architecture',
    'workflow',
    'sequence',
    'data_flow',
    'lifecycle'
  ]) {
    assert(
      technicalViews[viewName],
      `R5 technical view missing: ${viewName}`
    );
  }

  const knownCoverageGaps = [
    {
      id: 'DIRECT_AI_READ_REPRESENTATIVE_NOT_EXHAUSTIVE',
      covered_files: r4Report.ai_read_coverage.covered_files,
      total_files: r4Report.ai_read_coverage.total_files
    },
    {
      id: 'OFFLINE_SOURCE_MATERIALIZATION_PARTIAL',
      covered_files:
        r4Report.offline_source_coverage.covered_files,
      total_files:
        r4Report.offline_source_coverage.total_files
    },
    {
      id: 'CANONICAL_CORE_FACTS_BOUNDED',
      canonical_graph_nodes: canonicalGraphNodes,
      canonical_claims: canonicalClaims
    }
  ];

  assert.deepEqual(
    knownCoverageGaps,
    goldenValue.known_coverage_gaps.map(gap => {
      const clone = structuredClone(gap);
      delete clone.explanation;
      return clone;
    })
  );

  return {
    verified: true,
    locale:
      repositoryAuthoringIr.generation.semantic_author.locale,
    components: components.length,
    flows: flows.length,
    technical_view_families: 5,
    canonical_graph_nodes: canonicalGraphNodes,
    canonical_claims: canonicalClaims,
    known_coverage_gaps: knownCoverageGaps
  };
}

function runBrowserGolden(indexPath) {
  const chrome = findChrome();
  const root = fsSync.mkdtempSync(
    path.join(os.tmpdir(), 'kneekura-r5-browser-')
  );
  const profile = path.join(root, 'chrome-profile');
  const domPath = path.join(root, 'dom.html');
  let outputFd = null;
  try {
    outputFd = fsSync.openSync(domPath, 'w');
    const launched = childProcess.spawnSync(
      chrome,
      [
        '--headless=new',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-background-networking',
        '--no-first-run',
        '--no-default-browser-check',
        '--virtual-time-budget=8000',
        `--user-data-dir=${profile}`,
        '--dump-dom',
        pathToFileURL(indexPath).href
      ],
      {
        timeout: 90000,
        windowsHide: true,
        stdio: ['ignore', outputFd, 'pipe']
      }
    );
    fsSync.closeSync(outputFd);
    outputFd = null;
    if (launched.error) throw launched.error;
    if (launched.status !== 0) {
      throw new Error(
        `R5_CHROME_FAILED:${launched.status}:` +
        String(launched.stderr ?? '').slice(-3000)
      );
    }
    const renderedPrefix =
      readPrefixBeforeMarker(domPath, PAYLOAD_MARKER);
    const expected = [
      'KNEEKURA コードエクスプローラー',
      'リポジトリ規模の解析',
      'Repository-scale readiness',
      '87 files',
      'Domain batches',
      'Replay / performance gate',
      'packages/agent-api/src/mcp.ts',
      '技術ビュー'
    ];
    for (const value of expected) {
      assert(
        renderedPrefix.includes(value),
        `R5 rendered browser golden missing: ${value}`
      );
    }
    return {
      verified: true,
      file_url: true,
      rendered_before_embedded_payload: true,
      expected_strings: expected,
      rendered_prefix_bytes:
        Buffer.byteLength(renderedPrefix, 'utf8')
    };
  } finally {
    if (outputFd !== null) {
      try {
        fsSync.closeSync(outputFd);
      } catch {}
    }
    fsSync.rmSync(root, { recursive: true, force: true });
  }
}

async function loadR3TechnicalBase(sourceBundle) {
  const manifest = await readJson(
    path.join(R3_ROOT, 'manifest.json')
  );
  const files = [];
  for (const meta of manifest.files ?? []) {
    if (!R3_REUSABLE_SIDECARS.has(meta.path)) continue;
    files.push({
      path: meta.path,
      content: await fs.readFile(
        path.join(R3_ROOT, meta.path),
        'utf8'
      )
    });
  }
  const paths = new Set(files.map(file => file.path));
  for (const required of R3_REUSABLE_SIDECARS) {
    assert(
      paths.has(required),
      `R5 R3 sidecar missing: ${required}`
    );
  }
  return { manifest, files, sourceBundle };
}

function sourceKey(ref) {
  if (!ref || typeof ref !== 'object') return null;
  if (String(ref.kind).toUpperCase() === 'FILE_RANGE') {
    return [
      'FILE_RANGE',
      ref.path,
      ref.start_line,
      ref.end_line,
      ref.content_digest ?? ''
    ].join(':');
  }
  return (
    `${String(ref.kind ?? '').toUpperCase()}:` +
    String(ref.id ?? '')
  );
}

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    process.env.LOCALAPPDATA &&
      path.join(
        process.env.LOCALAPPDATA,
        'Google',
        'Chrome',
        'Application',
        'chrome.exe'
      ),
    process.env.PROGRAMFILES &&
      path.join(
        process.env.PROGRAMFILES,
        'Google',
        'Chrome',
        'Application',
        'chrome.exe'
      ),
    process.env['PROGRAMFILES(X86)'] &&
      path.join(
        process.env['PROGRAMFILES(X86)'],
        'Google',
        'Chrome',
        'Application',
        'chrome.exe'
      )
  ].filter(Boolean);
  const found = candidates.find(candidate =>
    fsSync.existsSync(candidate)
  );
  if (!found) throw new Error('R5_CHROME_NOT_FOUND');
  return found;
}

function readPrefixBeforeMarker(filePath, marker) {
  const fd = fsSync.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const decoder = new TextDecoder();
  let carry = '';
  let output = '';
  try {
    while (true) {
      const bytes = fsSync.readSync(
        fd,
        buffer,
        0,
        buffer.length,
        null
      );
      if (bytes === 0) break;
      const text =
        carry +
        decoder.decode(buffer.subarray(0, bytes), {
          stream: true
        });
      const index = text.indexOf(marker);
      if (index >= 0) {
        output += text.slice(0, index);
        return output;
      }
      const keep = Math.max(
        0,
        text.length - marker.length + 1
      );
      output += text.slice(0, keep);
      if (Buffer.byteLength(output, 'utf8') > 32 * 1024 * 1024) {
        throw new Error('R5_BROWSER_PREFIX_TOO_LARGE');
      }
      carry = text.slice(keep);
    }
    output += carry + decoder.decode();
  } finally {
    fsSync.closeSync(fd);
  }
  throw new Error('R5_BROWSER_PAYLOAD_MARKER_MISSING');
}

async function readHead(filePath, maxBytes) {
  const file = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await file.read(
      buffer,
      0,
      buffer.length,
      0
    );
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await file.close();
  }
}

async function shaFile(filePath) {
  const hash = crypto.createHash('sha256');
  const stream = fsSync.createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return 'sha256:' + hash.digest('hex');
}

function shaBytes(bytes) {
  return (
    'sha256:' +
    crypto.createHash('sha256').update(bytes).digest('hex')
  );
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

function runCommand(file, args, { cwd, env }) {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(file, args, {
      cwd,
      env,
      windowsHide: true,
      stdio: 'inherit'
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `R5_COMMAND_FAILED:${path.basename(file)}:` +
          `${code ?? 'null'}:${signal ?? 'none'}`
        )
      );
    });
  });
}