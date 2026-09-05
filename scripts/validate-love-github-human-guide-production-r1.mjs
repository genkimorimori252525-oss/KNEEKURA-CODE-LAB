import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { runTypeScriptSemanticVertical } from '../src/analyzer-fabric/typescript-vertical.mjs';
import { scanRepository } from '../src/core/scan.mjs';
import {
  buildStandaloneHumanExplorerShell,
  createHumanExperienceProjection
} from '../src/human-experience/index.mjs';
import {
  compileProductionHumanExperienceArtifact,
  createHumanAnalysisEvidencePack,
  createHumanAnalysisPresentationCompanion,
  createHumanAnalysisSourceBroker,
  createProductionSemanticAuthor,
  createReadTrackedProductionSemanticAuthor,
  runProductionHumanAnalysisSemanticPipeline,
  stableDigest,
  writeHumanAnalysisArtifact
} from '../src/human-analysis/index.mjs';
import { createExplorerProjection } from '../src/presentation/explorer/project.mjs';

const run = promisify(execFile);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const RECORD_PATH = path.join(
  ROOT,
  'golden',
  'human-analysis',
  'love-github-r1-authoring.json'
);
const OUTPUT_ROOT = path.join(ROOT, 'dist', 'r1-love-github-production');
const cmp = (a, b) => String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
const sha = text => 'sha256:' + crypto.createHash('sha256').update(text).digest('hex');
const exec = (command, args, options = {}) => run(command, args, {
  encoding: 'utf8',
  windowsHide: true,
  maxBuffer: 64 * 1024 * 1024,
  ...options
});

async function npm(cwd, args) {
  if (process.env.npm_execpath) {
    return exec(process.execPath, [process.env.npm_execpath, ...args], { cwd });
  }
  if (process.platform === 'win32') {
    return exec(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'npm', ...args], { cwd });
  }
  return exec('npm', args, { cwd });
}

async function exists(value) {
  try {
    await fs.access(value);
    return true;
  } catch {
    return false;
  }
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
    if (!(await exists(path.join(candidate, '.git')))) continue;
    try {
      const url = (await exec('git', ['-C', candidate, 'remote', 'get-url', 'origin'])).stdout.trim();
      if (/(?:^|[\\/:])Love-Github(?:\.git)?$/i.test(url)) {
        return path.resolve(candidate);
      }
    } catch {}
  }
  throw new Error('R1_LOVE_GITHUB_REPO_NOT_FOUND');
}

async function checkoutFixedSnapshot(sourceRoot, targetRoot, commitSha) {
  await exec('git', ['clone', '--no-hardlinks', '--no-checkout', sourceRoot, targetRoot]);
  try {
    await exec('git', ['-C', targetRoot, 'cat-file', '-e', `${commitSha}^{commit}`]);
  } catch {
    const url = (await exec('git', ['-C', sourceRoot, 'remote', 'get-url', 'origin'])).stdout.trim();
    await exec('git', ['-C', targetRoot, 'remote', 'set-url', 'origin', url]);
    await exec('git', ['-C', targetRoot, 'fetch', '--no-tags', 'origin', commitSha]);
  }
  await exec('git', ['-C', targetRoot, 'checkout', '--detach', commitSha]);
  const head = (await exec('git', ['-C', targetRoot, 'rev-parse', 'HEAD'])).stdout.trim().toLowerCase();
  if (head !== commitSha.toLowerCase()) {
    throw new Error(`R1_FIXED_SNAPSHOT_MISMATCH:${head}`);
  }
  return head;
}

async function loadRecord() {
  const record = JSON.parse(await fs.readFile(RECORD_PATH, 'utf8'));
  if (record.schema !== 'kneekura.saved-production-authoring/v1') {
    throw new Error('R1_AUTHORING_RECORD_SCHEMA_INVALID');
  }
  if (
    record.authoring_origin !== 'SAVED_AI_AUTHORING_RUN' ||
    record.semantic_author?.acceptance_fixture !== false ||
    record.semantic_author?.locale !== 'ja-JP'
  ) {
    throw new Error('R1_AUTHORING_RECORD_NOT_PRODUCTION_AI');
  }
  if (!/^[0-9a-f]{40}$/i.test(record.repository?.commit_sha ?? '')) {
    throw new Error('R1_AUTHORING_RECORD_COMMIT_INVALID');
  }
  return record;
}

async function resolveSavedRanges(record, root) {
  const fileCache = new Map();
  const resolved = {};
  for (const [key, spec] of Object.entries(record.source_ranges ?? {})) {
    const relative = String(spec.path).replaceAll('\\', '/');
    let lines = fileCache.get(relative);
    if (!lines) {
      const raw = await fs.readFile(path.join(root, relative), 'utf8');
      lines = raw.split(/\r?\n/);
      fileCache.set(relative, lines);
    }
    const startIndex = uniqueLineIndex(lines, spec.start_contains, `${key}.start_contains`);
    const endBeforeIndex = uniqueLineIndex(lines, spec.end_before_contains, `${key}.end_before_contains`);
    const startLine = startIndex + 1;
    const endLine = endBeforeIndex;
    if (endLine < startLine) {
      throw new Error(`R1_AUTHORING_RANGE_INVALID:${key}:${startLine}-${endLine}`);
    }
    resolved[key] = {
      key,
      path: relative,
      start_line: startLine,
      end_line: endLine
    };
  }
  return resolved;
}

function uniqueLineIndex(lines, needle, label) {
  const text = String(needle ?? '');
  if (!text) throw new Error(`R1_AUTHORING_ANCHOR_EMPTY:${label}`);
  const matches = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].includes(text)) matches.push(index);
  }
  if (matches.length !== 1) {
    throw new Error(`R1_AUTHORING_ANCHOR_NOT_UNIQUE:${label}:${matches.length}`);
  }
  return matches[0];
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

function createSavedProductionAuthor(record, resolvedRanges) {
  const expected = new Map();
  for (const [stage, items] of Object.entries(record.stages ?? {})) {
    for (const item of items) {
      expected.set(`${stage}\0${item.title}`, item);
    }
  }
  return createProductionSemanticAuthor({
    id: record.semantic_author.id,
    locale: record.semantic_author.locale,
    provider_id: record.semantic_author.provider_id,
    run: async (envelope, sourceBroker) => {
      if (envelope.repository?.snapshot_id == null) {
        throw new Error('R1_AUTHOR_ENVELOPE_SNAPSHOT_MISSING');
      }
      if (envelope.stage === 'REVIEWER') {
        return {
          decisions: envelope.candidate_items.map(candidate => {
            const saved = expected.get(`${candidate.stage}\0${candidate.title}`);
            const valid = Boolean(
              saved &&
              candidate.kind === saved.kind &&
              candidate.semantic_class === 'AI_INTERPRETATION' &&
              candidate.body === saved.body &&
              candidate.source_refs?.length > 0
            );
            return {
              item_id: candidate.id,
              status: valid ? 'ACCEPT' : 'REJECT',
              reason: valid
                ? '保存済みAI著述と一致し、固定snapshotのSource Brokerで根拠範囲を再解決した。'
                : '保存済みAI著述またはSource Broker根拠と一致しない。'
            };
          })
        };
      }
      const specs = record.stages?.[envelope.stage] ?? [];
      const items = [];
      for (const spec of specs) {
        const refs = [];
        for (const sourceKey of spec.source_keys ?? []) {
          const range = resolvedRanges[sourceKey];
          if (!range) throw new Error(`R1_AUTHORING_SOURCE_KEY_UNKNOWN:${sourceKey}`);
          const read = await sourceBroker.readFileRange({
            kind: 'FILE_RANGE',
            path: range.path,
            start_line: range.start_line,
            end_line: range.end_line
          });
          refs.push({
            kind: 'FILE_RANGE',
            path: read.path,
            start_line: read.start_line,
            end_line: read.end_line,
            content_digest: read.content_digest
          });
        }
        items.push({
          kind: spec.kind,
          semantic_class: spec.semantic_class,
          title: spec.title,
          body: spec.body,
          source_refs: refs,
          ...(spec.ordering_key == null ? {} : { ordering_key: spec.ordering_key })
        });
      }
      return { items };
    }
  });
}

async function materializeSources(ir, broker) {
  const rows = new Map();
  for (const item of ir.items) {
    for (const ref of item.source_refs ?? []) {
      const key = sourceKey(ref);
      if (rows.has(key)) continue;
      if (ref.kind === 'FILE_RANGE') {
        const value = await broker.readFileRange(ref);
        rows.set(key, {
          ref: structuredClone(ref),
          instruction_authority: false,
          trust_class: value.trust_class,
          content_digest: value.content_digest,
          text: value.text
        });
      } else {
        const value = broker.resolveCanonicalRef(ref);
        rows.set(key, {
          ref: structuredClone(ref),
          instruction_authority: false,
          trust_class: value.trust_class,
          record: value.record
        });
      }
    }
  }
  return [...rows.entries()]
    .sort((a, b) => cmp(a[0], b[0]))
    .map(([, value]) => value);
}

function buildTypedPresentation(record, resolvedRanges, ir, pack, sources, receipts) {
  const byStageTitle = new Map(ir.items.map(item => [`${item.stage}\0${item.title}`, item]));
  const itemFor = (stage, saved) => {
    const item = byStageTitle.get(`${stage}\0${saved.title}`);
    if (!item) throw new Error(`R1_PRESENTATION_ITEM_MISSING:${stage}:${saved.key}`);
    return item;
  };
  const architecture = record.stages.ARCHITECTURE;
  const overviewSpec = architecture.find(item => item.role === 'OVERVIEW');
  const componentSpecs = architecture.filter(item => item.role === 'COMPONENT');
  const flowSpec = record.stages.FLOW[0];
  const flowItem = itemFor('FLOW', flowSpec);
  const refFor = (item, rangeKey) => {
    const range = resolvedRanges[rangeKey];
    const ref = item.source_refs.find(candidate =>
      candidate.kind === 'FILE_RANGE' &&
      candidate.path === range.path &&
      candidate.start_line === range.start_line &&
      candidate.end_line === range.end_line
    );
    if (!ref) throw new Error(`R1_PRESENTATION_SOURCE_REF_MISSING:${rangeKey}`);
    return ref;
  };
  const flowPresentation = flowSpec.presentation;
  return createHumanAnalysisPresentationCompanion({
    ir,
    evidencePack: pack,
    sources,
    readReceipts: receipts,
    scope: structuredClone(record.scope),
    overview_item_id: itemFor('ARCHITECTURE', overviewSpec).id,
    components: componentSpecs.map(spec => {
      const item = itemFor('ARCHITECTURE', spec);
      return {
        item_id: item.id,
        name: spec.presentation.name,
        responsibility: spec.presentation.responsibility,
        member_refs: item.source_refs
      };
    }),
    flows: [{
      item_id: flowItem.id,
      name: flowPresentation.name,
      entry_step_id: flowPresentation.entry_step_id,
      steps: flowPresentation.steps.map(step => ({
        step_id: step.step_id,
        label: step.label,
        source_refs: step.source_keys.map(key => refFor(flowItem, key))
      })),
      transitions: flowPresentation.transitions.map(transition => ({
        from_step_id: transition.from_step_id,
        to_step_id: transition.to_step_id,
        kind: transition.kind,
        source_refs: transition.source_keys.map(key => refFor(flowItem, key))
      }))
    }],
    tour: record.stages.TOUR.map(spec => {
      const item = itemFor('TOUR', spec);
      return {
        item_id: item.id,
        order: spec.presentation_order,
        target_refs: item.source_refs
      };
    })
  });
}

function sourceKey(ref) {
  return ref.kind === 'FILE_RANGE'
    ? [ref.kind, ref.path, ref.start_line, ref.end_line, ref.content_digest].join(':')
    : `${ref.kind}:${ref.id}`;
}

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe')
  ].filter(Boolean);
  const found = candidates.find(candidate => fsSync.existsSync(candidate));
  if (!found) throw new Error('R1_CHROME_NOT_FOUND');
  return found;
}

function validateFileBrowser(indexPath) {
  const profile = path.join(os.tmpdir(), `kneekura-r1-chrome-${process.pid}`);
  const launched = spawnSync(
    findChrome(),
    [
      '--headless=new',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-background-networking',
      '--no-first-run',
      '--no-default-browser-check',
      '--virtual-time-budget=7000',
      `--user-data-dir=${profile}`,
      '--dump-dom',
      pathToFileURL(indexPath).href
    ],
    {
      encoding: 'utf8',
      timeout: 90000,
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024
    }
  );
  try {
    if (launched.error) throw launched.error;
    if (launched.status !== 0) {
      throw new Error(`R1_CHROME_FAILED:${launched.status}:${String(launched.stderr ?? '').slice(-3000)}`);
    }
    const dom = String(launched.stdout ?? '');
    for (const expected of [
      'KNEEKURA コードエクスプローラー',
      'AIによるコード案内',
      'Love-Githubの安全な公開経路',
      'packages/orchestration/src/agent-service.ts'
    ]) {
      assert(dom.includes(expected), `R1 rendered DOM missing: ${expected}`);
    }
    assert(!dom.includes('Explorer presentation failed.'));
  } finally {
    fsSync.rmSync(profile, { recursive: true, force: true });
  }
}

async function main() {
  const record = await loadRecord();
  const fixedCommit = record.repository.commit_sha.toLowerCase();
  const sourceRoot = await findLoveGithubRoot();
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'kneekura-r1-love-github-'));
  const repoRoot = path.join(temp, 'repo');
  try {
    await checkoutFixedSnapshot(sourceRoot, repoRoot, fixedCommit);
    const resolvedRanges = await resolveSavedRanges(record, repoRoot);
    await npm(repoRoot, ['install', '--no-audit', '--no-fund', '--package-lock=false']);
    await npm(repoRoot, ['run', 'typecheck']);

    const require = createRequire(import.meta.url);
    const imported = require('@typescript/typescript6');
    const ts = typeof imported?.createProgram === 'function' ? imported : imported.default;
    const vertical = await runTypeScriptSemanticVertical({
      rootDirectory: repoRoot,
      commitSha: fixedCommit,
      typescript: ts,
      expectedTypeScriptVersion: String(ts.version),
      requireClean: true
    });
    if (vertical.summary.typescript_files <= 0 || vertical.summary.evidence <= 0) {
      throw new Error('R1_TYPESCRIPT_VERTICAL_EMPTY');
    }
    if (vertical.summary.canonical_claims !== 0) {
      throw new Error('R1_CANONICAL_CLAIM_VIOLATION');
    }

    const graph = await scanRepository(repoRoot, {
      repositoryIdentity: vertical.repository,
      snapshotIdentity: vertical.snapshot
    });
    const coverage = vertical.evidence_ledger.coverage;
    const result = {
      schema: 'core.analysis-result/v1',
      analysis_id: `analysis:love-github-r1:${fixedCommit.slice(0, 12)}`,
      session_id: 'session:love-github-r1-production',
      repository: vertical.repository,
      snapshot: vertical.snapshot,
      status: ['COMPLETE', 'BOUNDED'].includes(coverage.completeness)
        ? 'COMPLETE'
        : 'PARTIAL',
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
      source_catalog: await buildCatalog(repoRoot, vertical.profile.files)
    });
    const broker = createHumanAnalysisSourceBroker(pack, {
      readSource: relative => fs.readFile(path.join(repoRoot, relative), 'utf8')
    });
    const baseAuthor = createSavedProductionAuthor(record, resolvedRanges);
    const tracked = createReadTrackedProductionSemanticAuthor(baseAuthor);
    const ir = await runProductionHumanAnalysisSemanticPipeline({
      evidencePack: pack,
      sourceBroker: broker,
      semanticAuthor: tracked.semanticAuthor,
      request: {
        question: 'workspace変更を安全にGitHubへ公開する代表経路を日本語で案内して',
        audience: 'HUMAN',
        scope: {
          type: 'BOUNDED_PREVIEW',
          paths: record.scope.declared_paths
        }
      }
    });
    if (ir.generation?.mode !== 'PRODUCTION' || ir.generation?.user_deliverable !== true) {
      throw new Error('R1_PRODUCTION_MODE_VIOLATION');
    }
    if (ir.review?.rejected_item_ids?.length) {
      throw new Error(`R1_SAVED_REVIEW_REJECTED:${ir.review.rejected_item_ids.join(',')}`);
    }
    const receipts = tracked.getReadReceipts();
    const sources = await materializeSources(ir, broker);
    const presentation = buildTypedPresentation(
      record,
      resolvedRanges,
      ir,
      pack,
      sources,
      receipts
    );
    if (
      presentation.readiness.status !== 'READY_BOUNDED_PREVIEW' ||
      presentation.readiness.repository_scale_ready !== false
    ) {
      throw new Error(`R1_READINESS_INVALID:${presentation.readiness.status}`);
    }

    const explorerProjection = createExplorerProjection({ graph, result });
    const experience = createHumanExperienceProjection({
      explorerProjection,
      evidencePack: pack,
      humanAnalysisIr: ir,
      locale: 'ja-JP'
    });
    const shell = await buildStandaloneHumanExplorerShell();
    const compile = () => compileProductionHumanExperienceArtifact({
      experience,
      sources,
      presentation,
      title: 'Love-Github Human Explorer — R1 bounded production preview',
      explorerShell: shell
    });
    const one = await compile();
    const two = await compile();
    if (
      one.artifact_id !== two.artifact_id ||
      one.index_html !== two.index_html ||
      !one.zip_bytes.equals(two.zip_bytes) ||
      one.zip_digest !== two.zip_digest
    ) {
      throw new Error('R1_PRODUCTION_REPLAY_NONDETERMINISTIC');
    }
    if (one.manifest.semantic_readiness?.status !== 'READY_BOUNDED_PREVIEW') {
      throw new Error('R1_ARTIFACT_READINESS_MISSING');
    }
    if (!one.files.some(file => file.path === 'presentation.json')) {
      throw new Error('R1_PRESENTATION_FILE_MISSING');
    }

    await fs.rm(OUTPUT_ROOT, { recursive: true, force: true });
    const written = await writeHumanAnalysisArtifact({
      artifact: one,
      outDir: OUTPUT_ROOT,
      zipFile: 'love-github-r1-human-explorer.zip'
    });
    validateFileBrowser(written.index_path);

    const report = {
      schema: 'kneekura.live-love-github-production-r1/v1',
      product_commit: null,
      analyzed_repository: record.repository.full_name,
      analyzed_commit: fixedCommit,
      saved_authoring_run_id: record.authoring_run_id,
      saved_authoring_record_digest: stableDigest(record),
      semantic_author: ir.generation.semantic_author,
      generation_mode: ir.generation.mode,
      core_canonical_claims: vertical.summary.canonical_claims,
      core_coverage: vertical.summary.core_coverage_completeness,
      canonical_graph_nodes: graph.nodes.length,
      canonical_graph_edges: graph.edges.length,
      typescript_files: vertical.summary.typescript_files,
      human_analysis_items: ir.items.length,
      accepted_items: ir.review.accepted_item_ids.length,
      rejected_items: ir.review.rejected_item_ids.length,
      ai_read_receipts: receipts.length,
      direct_ai_file_reads: receipts.filter(item => item.read_kind === 'FILE_RANGE').length,
      typed_components: presentation.components.length,
      typed_flows: presentation.flows.length,
      typed_tour_steps: presentation.tour.length,
      bounded_preview_ready: presentation.readiness.bounded_preview_ready,
      repository_scale_ready: presentation.readiness.repository_scale_ready,
      readiness_gaps: presentation.readiness.gaps,
      presentation_id: presentation.presentation_id,
      human_experience_projection_id: experience.projection_id,
      artifact_id: one.artifact_id,
      zip_digest: one.zip_digest,
      zip_bytes: one.zip_bytes.length,
      deterministic_saved_replay: true,
      file_browser_verified: true
    };
    await fs.writeFile(
      path.join(OUTPUT_ROOT, 'r1-production-report.json'),
      JSON.stringify(report, null, 2) + '\n',
      'utf8'
    );
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}

await main();