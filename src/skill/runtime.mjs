import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  HUMAN_SOURCE_MAX_RECORD_TEXT_BYTES,
  HUMAN_SOURCE_MAX_TOTAL_TEXT_BYTES,
  assertHumanAnalysisSourcePayloadBudget
} from '../human-analysis/resource-budgets.mjs';
import { createDeterministicZip } from '../human-analysis/zip.mjs';

export const SKILL_RUN_ROOT_SCHEMA = 'kneekura.code-lab.run-root/v1';
export const TARGET_DATA_SCHEMA = 'kneekura.code-lab.untrusted-target-data/v1';

export const DEFAULT_CHILD_ENV_ALLOWLIST = Object.freeze([
  'PATH',
  'SystemRoot',
  'WINDIR',
  'ComSpec',
  'PATHEXT',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL'
]);

export const DEFAULT_SKILL_RUN_BUDGET = Object.freeze({
  maxFiles: 20000,
  maxTrackedBytes: 512 * 1024 * 1024,
  maxSingleFileBytes: HUMAN_SOURCE_MAX_RECORD_TEXT_BYTES,
  maxSemanticTextBytes: HUMAN_SOURCE_MAX_TOTAL_TEXT_BYTES,
  maxArtifactBytes: 256 * 1024 * 1024,
  maxArtifactEntries: 4096,
  maxDiagnosticBytes: 256 * 1024,
  maxAttemptsPerEngine: 2
});

const DELIVERY_CLASSES = Object.freeze({
  RUN_METADATA: /^(?:run-manifest|target-snapshot|engine-lock|artifact-manifest)\.json$/,
  ENGINE_ARTIFACT: /^engines\/(?:kneekura|understand-anything|archify)\/[A-Za-z0-9._/ -]+$/,
  SANITIZED_RECEIPT: /^engines\/(?:kneekura|understand-anything|archify)\/[A-Za-z0-9._/ -]+$/,
  LICENSE: /^licenses\/[A-Za-z0-9._/ -]+$/,
  COMPARISON: /^comparison\/[A-Za-z0-9._/ -]+$/
});

export function createChildEnvironment(source = process.env, {
  allowlist = DEFAULT_CHILD_ENV_ALLOWLIST,
  overrides = {}
} = {}) {
  const env = {};
  for (const key of allowlist) {
    if (Object.prototype.hasOwnProperty.call(source, key) && source[key] != null) {
      env[key] = String(source[key]);
    }
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value == null) continue;
    if (!allowlist.includes(key)) {
      throw codedError('ENV_NOT_ALLOWLISTED', `child environment key is not allowlisted: ${key}`);
    }
    env[key] = String(value);
  }
  return Object.freeze(env);
}

export async function createSkillRunRoot({ parent = os.tmpdir(), runId }) {
  const id = requireSafeId(runId, 'runId');
  const realParent = await fs.realpath(path.resolve(parent));
  const root = await fs.mkdtemp(path.join(realParent, 'kneekura-code-lab-run-'));
  const marker = {
    schema: SKILL_RUN_ROOT_SCHEMA,
    run_id: id,
    root: root.replaceAll('\\', '/')
  };
  await fs.writeFile(path.join(root, '.kneekura-code-lab-run.json'), JSON.stringify(marker), { encoding: 'utf8', flag: 'wx' });
  return Object.freeze({ root, marker: Object.freeze(marker) });
}

export async function removeSkillRunRoot(runRoot, {
  expectedRunId,
  protectedRoots = [os.homedir()]
} = {}) {
  const expected = requireSafeId(expectedRunId, 'expectedRunId');
  const resolved = path.resolve(runRoot);
  const real = await fs.realpath(resolved);
  assertNotFilesystemRoot(real);
  for (const protectedRoot of protectedRoots) {
    if (!protectedRoot) continue;
    const protectedResolved = await realpathIfExists(path.resolve(protectedRoot));
    if (protectedResolved && samePath(real, protectedResolved)) {
      throw codedError('PROTECTED_ROOT', 'refusing to delete a protected root');
    }
  }
  const markerPath = path.join(real, '.kneekura-code-lab-run.json');
  let marker;
  try {
    marker = JSON.parse(await fs.readFile(markerPath, 'utf8'));
  } catch (error) {
    throw codedError('RUN_ROOT_MARKER_MISSING', 'refusing to delete an unmarked run root', error);
  }
  if (marker.schema !== SKILL_RUN_ROOT_SCHEMA || marker.run_id !== expected || !samePath(path.resolve(marker.root), real)) {
    throw codedError('RUN_ROOT_MARKER_MISMATCH', 'refusing to delete a foreign or mismatched run root');
  }
  await fs.rm(real, { recursive: true, force: false });
  return true;
}

export function createUntrustedTargetData({ path: repoPath, text = null, contentDigest = null } = {}) {
  const normalizedPath = normalizeRelativePath(repoPath);
  const record = {
    schema: TARGET_DATA_SCHEMA,
    path: normalizedPath,
    content_digest: contentDigest == null ? null : String(contentDigest),
    text: text == null ? null : String(text),
    instruction_authority: false,
    trust_class: 'UNTRUSTED_REPOSITORY_DATA'
  };
  return deepFreeze(record);
}

export function assertSkillRunBudget(observed, limits = {}) {
  const budget = { ...DEFAULT_SKILL_RUN_BUDGET, ...limits };
  const checks = [
    ['files', 'maxFiles'],
    ['trackedBytes', 'maxTrackedBytes'],
    ['artifactBytes', 'maxArtifactBytes'],
    ['artifactEntries', 'maxArtifactEntries'],
    ['attemptsPerEngine', 'maxAttemptsPerEngine']
  ];
  for (const [observedKey, limitKey] of checks) {
    const value = Number(observed?.[observedKey] ?? 0);
    const limit = Number(budget[limitKey]);
    if (!Number.isFinite(value) || value < 0 || !Number.isFinite(limit) || limit < 0) throw new TypeError('run budget values must be non-negative finite numbers');
    if (value > limit) throw codedError('SKILL_RUN_BUDGET_EXCEEDED', `${observedKey} exceeds ${limitKey}: ${value}/${limit}`);
  }
  if (observed?.semanticSources) {
    assertHumanAnalysisSourcePayloadBudget(observed.semanticSources, {
      maxRecordTextBytes: budget.maxSingleFileBytes,
      maxTotalTextBytes: budget.maxSemanticTextBytes
    });
  }
  return Object.freeze({ ...budget });
}

export function sanitizeDiagnosticText(value, { maxBytes = DEFAULT_SKILL_RUN_BUDGET.maxDiagnosticBytes } = {}) {
  if (!Number.isInteger(maxBytes) || maxBytes < 0) throw new TypeError('maxBytes must be a non-negative integer');
  let text = String(value ?? '')
    .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/gi, '[REDACTED_PRIVATE_KEY]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '[REDACTED_GITHUB_TOKEN]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED_AWS_ACCESS_KEY]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, 'Bearer [REDACTED]')
    .replace(/(["']?(?:password|passwd|secret|api[_-]?key|access[_-]?token)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, '$1[REDACTED]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '�');
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length > maxBytes) {
    const suffix = Buffer.from('\n[TRUNCATED_BY_KNEEKURA]', 'utf8');
    const keep = Math.max(0, maxBytes - suffix.length);
    text = Buffer.concat([bytes.subarray(0, keep), suffix]).toString('utf8');
  }
  return text;
}

export function createSanitizedReceipt(value, options) {
  return sanitizeValue(structuredClone(value), options);
}

export function createSkillDeliveryZip(entries, { root = 'KNEEKURA-Code-LAB-Run' } = {}) {
  if (!Array.isArray(entries) || entries.length === 0) throw new TypeError('delivery entries must be a non-empty array');
  const caseFolded = new Set();
  const normalized = entries.map((entry, index) => {
    if (!entry || typeof entry !== 'object') throw new TypeError(`delivery entry is invalid: ${index}`);
    const classification = String(entry.classification ?? '');
    const matcher = DELIVERY_CLASSES[classification];
    if (!matcher) throw codedError('DELIVERY_CLASS_FORBIDDEN', `delivery classification is not allowlisted: ${classification}`);
    const entryPath = normalizeRelativePath(entry.path);
    if (!matcher.test(entryPath)) throw codedError('DELIVERY_PATH_FORBIDDEN', `delivery path is not valid for ${classification}: ${entryPath}`);
    const folded = entryPath.toLowerCase();
    if (caseFolded.has(folded)) throw codedError('DELIVERY_PATH_COLLISION', `case-folding delivery path collision: ${entryPath}`);
    caseFolded.add(folded);
    return { path: entryPath, data: entry.data };
  });
  return createDeterministicZip(normalized, { root });
}

function sanitizeValue(value, options) {
  if (typeof value === 'string') return sanitizeDiagnosticText(value, options);
  if (Array.isArray(value)) return value.map(item => sanitizeValue(item, options));
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) value[key] = sanitizeValue(value[key], options);
  }
  return value;
}

function normalizeRelativePath(value) {
  const text = String(value ?? '').replaceAll('\\', '/').replace(/^\.\//, '');
  if (!text || text.startsWith('/') || /^[A-Za-z]:\//.test(text) || text.split('/').some(part => part === '' || part === '.' || part === '..')) {
    throw codedError('UNSAFE_RELATIVE_PATH', `unsafe relative path: ${value}`);
  }
  if (/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(text)) {
    throw codedError('UNSAFE_RELATIVE_PATH', `control characters are forbidden in paths: ${value}`);
  }
  return text;
}

function requireSafeId(value, label) {
  const id = String(value ?? '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) throw new TypeError(`${label} is invalid`);
  return id;
}

function assertNotFilesystemRoot(value) {
  const parsed = path.parse(value);
  if (samePath(value, parsed.root)) throw codedError('PROTECTED_ROOT', 'refusing to operate on a filesystem root');
}

async function realpathIfExists(value) {
  try { return await fs.realpath(value); } catch { return null; }
}

function samePath(a, b) {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function codedError(code, message, cause = null) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}