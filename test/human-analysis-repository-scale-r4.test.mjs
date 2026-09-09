import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createRepositoryScaleReadiness,
  HUMAN_ANALYSIS_PERFORMANCE_SCHEMA,
  HUMAN_ANALYSIS_REPLAY_LOCK_SCHEMA,
  stableDigest,
  validateRepositoryScaleReadiness
} from '../src/human-analysis/index.mjs';

const REPOSITORY = {
  repository_id: 'repo:sha256:' + '1'.repeat(64),
  snapshot_id: 'snapshot:sha256:' + '2'.repeat(64)
};

const CATALOG = [
  file('packages/a/src/a.ts', 'a'),
  file('packages/a/src/b.ts', 'b'),
  file('packages/b/src/c.ts', 'c'),
  file('packages/b/src/d.ts', 'd')
];

function file(path, char) {
  return {
    path,
    content_digest: 'sha256:' + char.repeat(64),
    line_count: 10
  };
}

function receipt(path, char, suffix) {
  const core = {
    schema: 'kneekura.human-analysis-read-receipt/v1',
    repository: structuredClone(REPOSITORY),
    evidence_pack_id: 'human-evidence-pack:' + 'e'.repeat(64),
    stage: 'ARCHITECTURE',
    source_ref: {
      kind: 'FILE_RANGE',
      path,
      start_line: 1,
      end_line: 2,
      content_digest: 'sha256:' + char.repeat(64)
    },
    read_kind: 'FILE_RANGE',
    content_digest: 'sha256:' + char.repeat(64),
    range_text_digest: 'sha256:' + suffix.repeat(64)
  };
  return {
    ...core,
    receipt_id:
      'read:' + stableDigest(core).slice('sha256:'.length)
  };
}

function source(path, char) {
  return {
    ref: {
      kind: 'FILE_RANGE',
      path,
      start_line: 1,
      end_line: 2,
      content_digest: 'sha256:' + char.repeat(64)
    },
    content_digest: 'sha256:' + char.repeat(64),
    text: 'line 1\nline 2'
  };
}

function replayLock(overrides = {}) {
  return {
    schema: HUMAN_ANALYSIS_REPLAY_LOCK_SCHEMA,
    analyzed_commit: 'f'.repeat(40),
    node_version: '20.20.2',
    npm_version: '10.8.2',
    typescript_version: '6.0.2',
    vite_version: '8.2.2',
    package_manifest_digest: 'sha256:' + '3'.repeat(64),
    lockfile_digest: 'sha256:' + '4'.repeat(64),
    authoring_record_digest: 'sha256:' + '5'.repeat(64),
    ...overrides
  };
}

function performance(overrides = {}) {
  return {
    schema: HUMAN_ANALYSIS_PERFORMANCE_SCHEMA,
    metrics: {
      startup_ms: 800,
      search_p95_ms: 12,
      layout_p95_ms: 650,
      zip_bytes: 80_000_000,
      peak_heap_bytes: 300_000_000,
      ...(overrides.metrics ?? {})
    }
  };
}

function readyInput() {
  return {
    repository: REPOSITORY,
    sourceCatalog: CATALOG,
    scannerPaths: CATALOG.slice(0, 3).map(row => row.path),
    readReceipts: [
      receipt(CATALOG[0].path, 'a', '6'),
      receipt(CATALOG[2].path, 'c', '7')
    ],
    sources: [
      source(CATALOG[0].path, 'a'),
      source(CATALOG[2].path, 'c')
    ],
    batches: [
      {
        batch_id: 'batch:a',
        domain: 'package-a',
        status: 'REVIEWED',
        paths: CATALOG.slice(0, 2).map(row => row.path)
      },
      {
        batch_id: 'batch:b',
        domain: 'package-b',
        status: 'REVIEWED',
        paths: CATALOG.slice(2).map(row => row.path)
      }
    ],
    integrationReview: {
      status: 'ACCEPTED',
      reviewed_batch_ids: ['batch:a', 'batch:b'],
      review_note: 'domain batches were integrated without upgrading derived interpretation to canonical fact'
    },
    replayLock: replayLock(),
    performance: performance()
  };
}

test('R4 repository-scale readiness keeps scanner, AI-read and offline-source coverage separate', () => {
  const value = createRepositoryScaleReadiness(readyInput());
  assert.equal(value.readiness.status, 'READY_REPOSITORY_SCALE');
  assert.equal(value.readiness.repository_scale_ready, true);
  assert.equal(value.coverage.scanner.covered_files, 3);
  assert.equal(value.coverage.scanner.ratio, 0.75);
  assert.equal(value.coverage.ai_read.covered_files, 2);
  assert.equal(value.coverage.ai_read.ratio, 0.5);
  assert.equal(value.coverage.offline_source.covered_files, 2);
  assert.equal(value.coverage.offline_source.ratio, 0.5);
  assert.equal(value.batches[0].direct_ai_read_paths.length, 1);
  assert.equal(value.batches[1].direct_ai_read_paths.length, 1);
  assert.equal(validateRepositoryScaleReadiness(value), true);
});

test('R4 performance measurements do not make the digest nondeterministic when budget outcomes are unchanged', () => {
  const first = readyInput();
  first.performance = performance({ metrics: { startup_ms: 450, search_p95_ms: 8 } });
  const second = readyInput();
  second.performance = performance({ metrics: { startup_ms: 920, search_p95_ms: 21 } });
  const a = createRepositoryScaleReadiness(first);
  const b = createRepositoryScaleReadiness(second);
  assert.equal(a.readiness_id, b.readiness_id);
  assert.deepEqual(a.performance, b.performance);
  assert.equal(Object.hasOwn(a.performance, 'metrics'), false);
});

test('R4 requires every inventory file to belong to exactly one domain batch', () => {
  const missing = readyInput();
  missing.batches[1].paths = [CATALOG[2].path];
  const value = createRepositoryScaleReadiness(missing);
  assert.equal(value.readiness.repository_scale_ready, false);
  assert(value.readiness.gaps.includes('INVENTORY_NOT_PARTITIONED_BY_BATCHES'));

  const duplicate = readyInput();
  duplicate.batches[1].paths.push(CATALOG[1].path);
  assert.throws(
    () => createRepositoryScaleReadiness(duplicate),
    /assigned to multiple batches/
  );
});

test('R4 does not pretend a reviewed batch was AI-inspected when it has no direct read', () => {
  const input = readyInput();
  input.readReceipts = [receipt(CATALOG[0].path, 'a', '6')];
  input.sources = [source(CATALOG[0].path, 'a')];
  const value = createRepositoryScaleReadiness(input);
  assert.equal(value.readiness.repository_scale_ready, false);
  assert(value.readiness.gaps.includes('BATCH_WITHOUT_DIRECT_AI_READ:batch:b'));
});

test('R4 requires AI-read source ranges to remain available in the offline artifact', () => {
  const input = readyInput();
  input.sources = [source(CATALOG[0].path, 'a')];
  const value = createRepositoryScaleReadiness(input);
  assert.equal(value.readiness.repository_scale_ready, false);
  assert(value.readiness.gaps.includes(`AI_READ_SOURCE_NOT_OFFLINE:${CATALOG[2].path}`));
});

test('R4 readiness fails closed without a lockfile digest or when fixed performance budgets are exceeded', () => {
  const unlocked = readyInput();
  unlocked.replayLock = replayLock({ lockfile_digest: null });
  const unlockedValue = createRepositoryScaleReadiness(unlocked);
  assert(unlockedValue.readiness.gaps.includes('REPLAY_LOCKFILE_DIGEST_MISSING'));

  const slow = readyInput();
  slow.performance = performance({ metrics: { search_p95_ms: 251 } });
  const slowValue = createRepositoryScaleReadiness(slow);
  assert(slowValue.readiness.gaps.includes('PERFORMANCE_BUDGET_EXCEEDED:search_p95_ms'));
});

test('R4 rejects callers that attempt to raise the fixed performance budgets', () => {
  const input = readyInput();
  input.performance.budgets = {
    startup_ms: 100_000,
    search_p95_ms: 100_000,
    layout_p95_ms: 100_000,
    zip_bytes: 9_000_000_000,
    peak_heap_bytes: 9_000_000_000
  };
  assert.throws(
    () => createRepositoryScaleReadiness(input),
    /budgets must match R4_DEFAULT_V1/
  );
});

test('R4 readiness is digest-protected and never acquires canonical authority', () => {
  const value = createRepositoryScaleReadiness(readyInput());
  assert.equal(value.authority.canonical_authority, false);
  assert.equal(value.authority.derived_readiness_only, true);
  const tampered = structuredClone(value);
  tampered.coverage.ai_read.ratio = 1;
  assert.throws(
    () => validateRepositoryScaleReadiness(tampered),
    /digest mismatch/
  );
});