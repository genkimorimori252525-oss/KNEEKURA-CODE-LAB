import {
  stableDigest,
  validateSourceRef
} from './schema.mjs';
import {
  HUMAN_ANALYSIS_READ_RECEIPT_SCHEMA,
  validateHumanAnalysisReadReceipt
} from './author-read-trace.mjs';

export const HUMAN_ANALYSIS_REPOSITORY_SCALE_SCHEMA =
  'kneekura.human-analysis-repository-scale/v1';
export const HUMAN_ANALYSIS_REPLAY_LOCK_SCHEMA =
  'kneekura.human-analysis-replay-lock/v1';
export const HUMAN_ANALYSIS_PERFORMANCE_SCHEMA =
  'kneekura.human-analysis-performance/v1';
export const HUMAN_ANALYSIS_PERFORMANCE_BUDGET_PROFILE =
  'R4_DEFAULT_V1';
export const HUMAN_ANALYSIS_PERFORMANCE_BUDGETS = Object.freeze({
  startup_ms: 10_000,
  search_p95_ms: 250,
  layout_p95_ms: 5_000,
  zip_bytes: 400_000_000,
  peak_heap_bytes: 1_000_000_000
});

const READY = 'READY_REPOSITORY_SCALE';
const NOT_READY = 'NOT_READY';

export function createRepositoryScaleReadiness({
  repository,
  sourceCatalog,
  scannerPaths = [],
  readReceipts = [],
  sources = [],
  batches = [],
  integrationReview,
  replayLock,
  performance
} = {}) {
  const identity = normalizeRepository(repository);
  const catalog = normalizeCatalog(sourceCatalog);
  const catalogByPath = new Map(catalog.map(row => [row.path, row]));
  const scanner = normalizePathSet(scannerPaths, catalogByPath, 'scannerPaths');
  const receipts = normalizeReceipts(readReceipts, identity, catalogByPath);
  const aiReadPaths = unique(
    receipts
      .filter(row => row.read_kind === 'FILE_RANGE')
      .map(row => normalizePath(row.source_ref.path))
  ).sort(compareText);
  const materializedPaths = materializedFilePaths(sources, catalogByPath);
  const normalizedBatches = normalizeBatches(batches, catalogByPath, aiReadPaths);
  const normalizedReview = normalizeIntegrationReview(
    integrationReview,
    normalizedBatches
  );
  const normalizedReplayLock = normalizeReplayLock(replayLock);
  const normalizedPerformance = normalizePerformance(performance);

  const gaps = [];
  const batchedPaths = normalizedBatches.flatMap(batch => batch.paths);
  if (!sameStrings(batchedPaths, catalog.map(row => row.path))) {
    gaps.push('INVENTORY_NOT_PARTITIONED_BY_BATCHES');
  }
  for (const batch of normalizedBatches) {
    if (batch.status !== 'REVIEWED') {
      gaps.push(`BATCH_NOT_REVIEWED:${batch.batch_id}`);
    }
    if (batch.direct_ai_read_paths.length === 0) {
      gaps.push(`BATCH_WITHOUT_DIRECT_AI_READ:${batch.batch_id}`);
    }
  }
  if (normalizedReview.status !== 'ACCEPTED') {
    gaps.push('INTEGRATION_REVIEW_NOT_ACCEPTED');
  }
  const expectedBatchIds = normalizedBatches.map(row => row.batch_id).sort(compareText);
  if (!sameStrings(normalizedReview.reviewed_batch_ids, expectedBatchIds)) {
    gaps.push('INTEGRATION_REVIEW_BATCH_COVERAGE_INCOMPLETE');
  }
  for (const pathValue of aiReadPaths) {
    if (!materializedPaths.includes(pathValue)) {
      gaps.push(`AI_READ_SOURCE_NOT_OFFLINE:${pathValue}`);
    }
  }
  if (!normalizedReplayLock.lockfile_digest) {
    gaps.push('REPLAY_LOCKFILE_DIGEST_MISSING');
  }
  for (const [metric, within] of Object.entries(normalizedPerformance.within_budget)) {
    if (!within) gaps.push(`PERFORMANCE_BUDGET_EXCEEDED:${metric}`);
  }

  const core = {
    schema: HUMAN_ANALYSIS_REPOSITORY_SCALE_SCHEMA,
    repository: identity,
    authority: {
      canonical_authority: false,
      may_mint_canonical_nodes: false,
      may_mint_canonical_edges: false,
      may_mint_canonical_claims: false,
      derived_readiness_only: true
    },
    inventory: {
      total_files: catalog.length,
      files: catalog
    },
    batches: normalizedBatches,
    integration_review: normalizedReview,
    coverage: {
      scanner: coverageAxis(scanner.length, catalog.length, scanner),
      ai_read: coverageAxis(aiReadPaths.length, catalog.length, aiReadPaths),
      offline_source: coverageAxis(
        materializedPaths.length,
        catalog.length,
        materializedPaths
      )
    },
    replay_lock: normalizedReplayLock,
    performance: normalizedPerformance,
    readiness: {
      status: gaps.length ? NOT_READY : READY,
      repository_scale_ready: gaps.length === 0,
      gaps: unique(gaps).sort(compareText)
    }
  };
  const result = {
    ...core,
    readiness_id:
      'repository-scale:' + stableDigest(core).slice('sha256:'.length)
  };
  validateRepositoryScaleReadiness(result);
  return deepFreeze(result);
}

export function validateRepositoryScaleReadiness(value) {
  if (!value || value.schema !== HUMAN_ANALYSIS_REPOSITORY_SCALE_SCHEMA) {
    throw new TypeError(
      `repository-scale readiness must use ${HUMAN_ANALYSIS_REPOSITORY_SCALE_SCHEMA}`
    );
  }
  normalizeRepository(value.repository);
  const authority = value.authority ?? {};
  for (const key of [
    'canonical_authority',
    'may_mint_canonical_nodes',
    'may_mint_canonical_edges',
    'may_mint_canonical_claims'
  ]) {
    if (authority[key] !== false) {
      throw new TypeError(`repository-scale authority must remain false: ${key}`);
    }
  }
  if (authority.derived_readiness_only !== true) {
    throw new TypeError('repository-scale readiness must remain derived-only');
  }
  if (!Array.isArray(value.inventory?.files) || !Array.isArray(value.batches)) {
    throw new TypeError('repository-scale inventory/batches are required');
  }
  if (!value.coverage?.scanner || !value.coverage?.ai_read || !value.coverage?.offline_source) {
    throw new TypeError('repository-scale coverage axes are required');
  }
  if (value.replay_lock?.schema !== HUMAN_ANALYSIS_REPLAY_LOCK_SCHEMA) {
    throw new TypeError('repository-scale replay lock schema is invalid');
  }
  if (value.performance?.schema !== HUMAN_ANALYSIS_PERFORMANCE_SCHEMA) {
    throw new TypeError('repository-scale performance schema is invalid');
  }
  if (
    value.performance.budget_profile !== HUMAN_ANALYSIS_PERFORMANCE_BUDGET_PROFILE ||
    !sameMetricObject(value.performance.budgets, HUMAN_ANALYSIS_PERFORMANCE_BUDGETS)
  ) {
    throw new TypeError('repository-scale performance budget profile drift');
  }
  for (const key of Object.keys(HUMAN_ANALYSIS_PERFORMANCE_BUDGETS)) {
    if (typeof value.performance.within_budget?.[key] !== 'boolean') {
      throw new TypeError(`repository-scale performance assessment is missing: ${key}`);
    }
  }
  if (!['READY_REPOSITORY_SCALE', 'NOT_READY'].includes(value.readiness?.status)) {
    throw new TypeError('repository-scale readiness status is invalid');
  }
  if (
    value.readiness.repository_scale_ready !==
    (value.readiness.status === READY)
  ) {
    throw new TypeError('repository-scale readiness boolean/status mismatch');
  }
  const clone = structuredClone(value);
  delete clone.readiness_id;
  const expected =
    'repository-scale:' + stableDigest(clone).slice('sha256:'.length);
  if (value.readiness_id !== expected) {
    throw new TypeError('repository-scale readiness digest mismatch');
  }
  return true;
}

function normalizeRepository(repository) {
  const repositoryId = requiredText(
    repository?.repository_id,
    'repository.repository_id'
  );
  const snapshotId = requiredText(
    repository?.snapshot_id,
    'repository.snapshot_id'
  );
  return {
    repository_id: repositoryId,
    snapshot_id: snapshotId
  };
}

function normalizeCatalog(sourceCatalog) {
  if (!Array.isArray(sourceCatalog) || sourceCatalog.length === 0) {
    throw new TypeError('repository-scale sourceCatalog must be a non-empty array');
  }
  const seen = new Set();
  return sourceCatalog.map((row, index) => {
    const pathValue = normalizePath(row?.path);
    if (seen.has(pathValue)) {
      throw new TypeError(`duplicate repository-scale catalog path: ${pathValue}`);
    }
    seen.add(pathValue);
    const digest = String(row?.content_digest ?? '').toLowerCase();
    if (!/^sha256:[0-9a-f]{64}$/.test(digest)) {
      throw new TypeError(`invalid repository-scale catalog digest: ${pathValue}`);
    }
    const lineCount = Number(row?.line_count);
    if (!Number.isInteger(lineCount) || lineCount < 1) {
      throw new TypeError(`invalid repository-scale line count: ${pathValue}`);
    }
    return {
      path: pathValue,
      content_digest: digest,
      line_count: lineCount,
      inventory_index: index
    };
  }).sort((a, b) => compareText(a.path, b.path));
}

function normalizePathSet(paths, catalogByPath, label) {
  if (!Array.isArray(paths)) throw new TypeError(`${label} must be an array`);
  const values = unique(paths.map(normalizePath)).sort(compareText);
  for (const pathValue of values) {
    if (!catalogByPath.has(pathValue)) {
      throw new TypeError(`${label} contains path outside inventory: ${pathValue}`);
    }
  }
  return values;
}

function normalizeReceipts(receipts, identity, catalogByPath) {
  if (!Array.isArray(receipts)) {
    throw new TypeError('readReceipts must be an array');
  }
  const seen = new Set();
  return receipts.map(receipt => {
    if (receipt?.schema !== HUMAN_ANALYSIS_READ_RECEIPT_SCHEMA) {
      throw new TypeError('repository-scale read receipt schema is invalid');
    }
    validateHumanAnalysisReadReceipt(receipt);
    if (
      receipt.repository?.repository_id !== identity.repository_id ||
      receipt.repository?.snapshot_id !== identity.snapshot_id
    ) {
      throw new TypeError('repository-scale read receipt identity mismatch');
    }
    if (seen.has(receipt.receipt_id)) {
      throw new TypeError(`duplicate repository-scale read receipt: ${receipt.receipt_id}`);
    }
    seen.add(receipt.receipt_id);
    if (receipt.read_kind === 'FILE_RANGE') {
      validateSourceRef(receipt.source_ref);
      const pathValue = normalizePath(receipt.source_ref.path);
      const catalog = catalogByPath.get(pathValue);
      if (
        !catalog ||
        catalog.content_digest !== String(receipt.source_ref.content_digest).toLowerCase()
      ) {
        throw new TypeError(`repository-scale read receipt outside inventory: ${pathValue}`);
      }
    }
    return structuredClone(receipt);
  }).sort((a, b) => compareText(a.receipt_id, b.receipt_id));
}

function materializedFilePaths(sources, catalogByPath) {
  if (!Array.isArray(sources)) throw new TypeError('sources must be an array');
  const paths = new Set();
  for (const source of sources) {
    if (!source?.ref) continue;
    const kind = String(source.ref.kind ?? '').toUpperCase();
    if (kind !== 'FILE_RANGE' || typeof source.text !== 'string') continue;
    validateSourceRef(source.ref);
    const pathValue = normalizePath(source.ref.path);
    const catalog = catalogByPath.get(pathValue);
    if (!catalog) {
      throw new TypeError(`materialized source outside inventory: ${pathValue}`);
    }
    if (
      catalog.content_digest !== String(source.ref.content_digest ?? '').toLowerCase() ||
      catalog.content_digest !== String(source.content_digest ?? '').toLowerCase()
    ) {
      throw new TypeError(`materialized source digest mismatch: ${pathValue}`);
    }
    paths.add(pathValue);
  }
  return [...paths].sort(compareText);
}

function normalizeBatches(batches, catalogByPath, aiReadPaths) {
  if (!Array.isArray(batches) || batches.length === 0) {
    throw new TypeError('repository-scale batches must be a non-empty array');
  }
  const seenBatchIds = new Set();
  const assignedPaths = new Set();
  const aiReadSet = new Set(aiReadPaths);
  return batches.map((batch, index) => {
    const batchId = requiredText(batch?.batch_id, `batches[${index}].batch_id`);
    if (seenBatchIds.has(batchId)) {
      throw new TypeError(`duplicate repository-scale batch: ${batchId}`);
    }
    seenBatchIds.add(batchId);
    const domain = requiredText(batch?.domain, `batches[${index}].domain`);
    const paths = normalizePathSet(
      batch?.paths,
      catalogByPath,
      `batches[${index}].paths`
    );
    if (paths.length === 0) {
      throw new TypeError(`repository-scale batch has no paths: ${batchId}`);
    }
    for (const pathValue of paths) {
      if (assignedPaths.has(pathValue)) {
        throw new TypeError(`repository-scale path assigned to multiple batches: ${pathValue}`);
      }
      assignedPaths.add(pathValue);
    }
    const status = String(batch?.status ?? '').toUpperCase();
    if (!['REVIEWED', 'PENDING'].includes(status)) {
      throw new TypeError(`repository-scale batch status is invalid: ${batchId}`);
    }
    return {
      batch_id: batchId,
      domain,
      status,
      paths,
      direct_ai_read_paths: paths.filter(pathValue => aiReadSet.has(pathValue))
    };
  }).sort((a, b) => compareText(a.batch_id, b.batch_id));
}

function normalizeIntegrationReview(review, batches) {
  const status = String(review?.status ?? '').toUpperCase();
  if (!['ACCEPTED', 'REJECTED', 'PENDING'].includes(status)) {
    throw new TypeError('integration review status is invalid');
  }
  const known = new Set(batches.map(row => row.batch_id));
  const reviewedBatchIds = unique(
    (review?.reviewed_batch_ids ?? []).map(value => String(value))
  ).sort(compareText);
  for (const batchId of reviewedBatchIds) {
    if (!known.has(batchId)) {
      throw new TypeError(`integration review references foreign batch: ${batchId}`);
    }
  }
  return {
    status,
    reviewed_batch_ids: reviewedBatchIds,
    review_note: requiredText(review?.review_note, 'integrationReview.review_note')
  };
}

function normalizeReplayLock(lock) {
  if (!lock || lock.schema !== HUMAN_ANALYSIS_REPLAY_LOCK_SCHEMA) {
    throw new TypeError(`replayLock must use ${HUMAN_ANALYSIS_REPLAY_LOCK_SCHEMA}`);
  }
  const commit = requiredText(lock.analyzed_commit, 'replayLock.analyzed_commit').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new TypeError('replayLock.analyzed_commit must be a full Git commit SHA');
  }
  const digests = {};
  for (const key of [
    'package_manifest_digest',
    'authoring_record_digest'
  ]) {
    const value = requiredText(lock[key], `replayLock.${key}`).toLowerCase();
    if (!/^sha256:[0-9a-f]{64}$/.test(value)) {
      throw new TypeError(`replayLock.${key} must be sha256`);
    }
    digests[key] = value;
  }
  let lockfileDigest = null;
  if (lock.lockfile_digest != null) {
    lockfileDigest = String(lock.lockfile_digest).toLowerCase();
    if (!/^sha256:[0-9a-f]{64}$/.test(lockfileDigest)) {
      throw new TypeError('replayLock.lockfile_digest must be sha256');
    }
  }
  return {
    schema: HUMAN_ANALYSIS_REPLAY_LOCK_SCHEMA,
    analyzed_commit: commit,
    node_version: requiredText(lock.node_version, 'replayLock.node_version'),
    npm_version: requiredText(lock.npm_version, 'replayLock.npm_version'),
    typescript_version: requiredText(lock.typescript_version, 'replayLock.typescript_version'),
    vite_version: requiredText(lock.vite_version, 'replayLock.vite_version'),
    package_manifest_digest: digests.package_manifest_digest,
    lockfile_digest: lockfileDigest,
    authoring_record_digest: digests.authoring_record_digest
  };
}

function normalizePerformance(input) {
  if (!input || input.schema !== HUMAN_ANALYSIS_PERFORMANCE_SCHEMA) {
    throw new TypeError(`performance must use ${HUMAN_ANALYSIS_PERFORMANCE_SCHEMA}`);
  }
  const metrics = normalizePositiveNumbers(input.metrics, 'performance.metrics');
  const required = Object.keys(HUMAN_ANALYSIS_PERFORMANCE_BUDGETS);
  for (const key of required) {
    if (!(key in metrics)) {
      throw new TypeError(`performance metric is missing: ${key}`);
    }
  }
  if (input.budgets != null) {
    const supplied = normalizePositiveNumbers(input.budgets, 'performance.budgets');
    if (!sameMetricObject(supplied, HUMAN_ANALYSIS_PERFORMANCE_BUDGETS)) {
      throw new TypeError('performance budgets must match R4_DEFAULT_V1');
    }
  }
  const withinBudget = Object.fromEntries(
    required.map(key => [key, metrics[key] <= HUMAN_ANALYSIS_PERFORMANCE_BUDGETS[key]])
  );
  return {
    schema: HUMAN_ANALYSIS_PERFORMANCE_SCHEMA,
    budget_profile: HUMAN_ANALYSIS_PERFORMANCE_BUDGET_PROFILE,
    budgets: { ...HUMAN_ANALYSIS_PERFORMANCE_BUDGETS },
    within_budget: withinBudget
  };
}

function normalizePositiveNumbers(value, label) {
  if (!value || typeof value !== 'object') {
    throw new TypeError(`${label} must be an object`);
  }
  const result = {};
  for (const [key, raw] of Object.entries(value)) {
    const number = Number(raw);
    if (!Number.isFinite(number) || number < 0) {
      throw new TypeError(`${label}.${key} must be a non-negative number`);
    }
    result[key] = number;
  }
  return result;
}

function sameMetricObject(left, right) {
  const leftKeys = Object.keys(left ?? {}).sort(compareText);
  const rightKeys = Object.keys(right ?? {}).sort(compareText);
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) =>
      key === rightKeys[index] && Number(left[key]) === Number(right[key])
    );
}

function coverageAxis(covered, total, paths) {
  return {
    covered_files: covered,
    total_files: total,
    ratio: total === 0 ? 0 : covered / total,
    paths: [...paths]
  };
}

function sameStrings(left, right) {
  const a = [...left].sort(compareText);
  const b = [...right].sort(compareText);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function normalizePath(value) {
  const text = String(value ?? '')
    .replaceAll('\\', '/')
    .replace(/^\.\//, '')
    .replace(/\/+/g, '/');
  if (
    !text ||
    text.startsWith('/') ||
    /^[A-Za-z]:\//.test(text) ||
    text.split('/').includes('..')
  ) {
    throw new TypeError(`unsafe repository path: ${String(value)}`);
  }
  return text;
}

function requiredText(value, label) {
  const text = String(value ?? '').trim();
  if (!text) throw new TypeError(`${label} is required`);
  return text;
}

function unique(values) {
  return [...new Set(values)];
}

function compareText(a, b) {
  const left = String(a);
  const right = String(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}