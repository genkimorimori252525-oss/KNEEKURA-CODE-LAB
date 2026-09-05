import { stableDigest } from './schema.mjs';

export const HUMAN_ANALYSIS_BATCH_PLAN_SCHEMA =
  'kneekura.human-analysis-batch-plan/v1';

export function planRepositoryDomainBatches(
  sourceCatalog,
  { maxFilesPerBatch = 64 } = {}
) {
  if (!Array.isArray(sourceCatalog) || sourceCatalog.length === 0) {
    throw new TypeError('repository batch planner requires a non-empty source catalog');
  }
  if (!Number.isInteger(maxFilesPerBatch) || maxFilesPerBatch < 1) {
    throw new TypeError('maxFilesPerBatch must be a positive integer');
  }
  const rows = normalizeCatalog(sourceCatalog);
  const groups = new Map();
  for (const row of rows) {
    const domain = domainForPath(row.path);
    if (!groups.has(domain)) groups.set(domain, []);
    groups.get(domain).push(row.path);
  }

  const batches = [];
  for (const [domain, paths] of [...groups.entries()].sort((a, b) => compareText(a[0], b[0]))) {
    const sorted = [...paths].sort(compareText);
    for (let offset = 0; offset < sorted.length; offset += maxFilesPerBatch) {
      const part = sorted.slice(offset, offset + maxFilesPerBatch);
      const ordinal = Math.floor(offset / maxFilesPerBatch) + 1;
      const batchCore = {
        domain,
        ordinal,
        paths: part,
        representative_path: chooseRepresentativePath(part)
      };
      batches.push({
        ...batchCore,
        batch_id:
          'batch:' + stableDigest(batchCore).slice('sha256:'.length)
      });
    }
  }
  const core = {
    schema: HUMAN_ANALYSIS_BATCH_PLAN_SCHEMA,
    inventory_file_count: rows.length,
    max_files_per_batch: maxFilesPerBatch,
    batches
  };
  return deepFreeze({
    ...core,
    plan_id: 'batch-plan:' + stableDigest(core).slice('sha256:'.length)
  });
}

export function validateRepositoryDomainBatchPlan(plan, sourceCatalog) {
  if (!plan || plan.schema !== HUMAN_ANALYSIS_BATCH_PLAN_SCHEMA) {
    throw new TypeError(`batch plan must use ${HUMAN_ANALYSIS_BATCH_PLAN_SCHEMA}`);
  }
  const expected = planRepositoryDomainBatches(sourceCatalog, {
    maxFilesPerBatch: plan.max_files_per_batch
  });
  if (stableDigest(plan) !== stableDigest(expected)) {
    throw new TypeError('repository batch plan drift');
  }
  return true;
}

function normalizeCatalog(sourceCatalog) {
  const seen = new Set();
  return sourceCatalog.map((row, index) => {
    const path = normalizePath(row?.path);
    if (seen.has(path)) throw new TypeError(`duplicate batch inventory path: ${path}`);
    seen.add(path);
    return { path, index };
  }).sort((a, b) => compareText(a.path, b.path));
}

function domainForPath(pathValue) {
  const parts = normalizePath(pathValue).split('/');
  const root = parts[0];
  if (['packages', 'adapters', 'apps', 'tests'].includes(root) && parts.length >= 2) {
    return `${root}/${parts[1]}`;
  }
  return root;
}

function chooseRepresentativePath(paths) {
  return [...paths].sort((a, b) => {
    const score = representativeScore(a) - representativeScore(b);
    return score || compareText(a, b);
  })[0];
}

function representativeScore(pathValue) {
  const path = String(pathValue).toLowerCase();
  let score = 0;
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(path)) score += 100;
  if (/\/index\.[cm]?[jt]sx?$/.test(path)) score += 10;
  if (path.includes('/types.')) score += 5;
  return score;
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