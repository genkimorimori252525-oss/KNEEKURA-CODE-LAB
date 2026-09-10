export const ANALYSIS_REQUEST_SCHEMA = 'kneekura.code-lab.analysis-request/v1';
export const ENGINE_RUN_RECEIPT_SCHEMA = 'kneekura.code-lab.engine-run-receipt/v1';
export const ENGINE_LOCK_SCHEMA = 'kneekura.code-lab.engine-lock/v1';

export const ENGINE_IDS = Object.freeze([
  'kneekura',
  'understand-anything',
  'archify'
]);

export const ENGINE_STATUS = Object.freeze([
  'SUCCESS',
  'PARTIAL',
  'FAILED',
  'SKIPPED',
  'CANCELLED',
  'BLOCKED'
]);

export const CLAIM_LEVELS = Object.freeze([
  'NATIVE',
  'PORTABLE',
  'COMPATIBLE',
  'FALLBACK_PREVIEW'
]);

export const IMPLEMENTATION_ORIGINS = Object.freeze([
  'first-party',
  'pinned-upstream'
]);

export const ORCHESTRATION_MODES = Object.freeze([
  'native',
  'portable-compatible'
]);

export function expandSelection(selection) {
  if (selection == null || selection === '') return null;
  if (selection === 'all') return [...ENGINE_IDS];
  if (!ENGINE_IDS.includes(selection)) {
    throw new TypeError(`unsupported KNEEKURA Code LAB engine selection: ${selection}`);
  }
  return [selection];
}

export function normalizeAnalysisRequest(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('analysis request must be an object');
  }
  const requestedEngines = expandSelection(input.selection);
  return {
    schema: ANALYSIS_REQUEST_SCHEMA,
    requestedEngines,
    selectionRequired: requestedEngines === null,
    commonScope: normalizeObject(input.commonScope),
    engineOptions: normalizeObject(input.engineOptions),
    minimumClaimLevel: normalizeObject(input.minimumClaimLevel)
  };
}

export function validateEngineRunReceipt(receipt) {
  requireRecord(receipt, 'engine receipt');
  if (receipt.schema !== ENGINE_RUN_RECEIPT_SCHEMA) throw new TypeError('invalid engine receipt schema');
  if (!ENGINE_IDS.includes(receipt.engineId)) throw new TypeError('invalid engineId');
  if (!IMPLEMENTATION_ORIGINS.includes(receipt.implementationOrigin)) throw new TypeError('invalid implementationOrigin');
  if (!ORCHESTRATION_MODES.includes(receipt.orchestrationMode)) throw new TypeError('invalid orchestrationMode');
  if (!ENGINE_STATUS.includes(receipt.status)) throw new TypeError('invalid status');
  if (!CLAIM_LEVELS.includes(receipt.claimLevel)) throw new TypeError('invalid claimLevel');
  if (typeof receipt.claimSatisfied !== 'boolean') throw new TypeError('claimSatisfied must be boolean');
  requireString(receipt.snapshotId, 'snapshotId');
  requireString(receipt.scopeDigest, 'scopeDigest');
  requireString(receipt.attemptId, 'attemptId');
  requireRecord(receipt.acceptance, 'acceptance');
  requireRecord(receipt.coverage, 'coverage');
  if (!Array.isArray(receipt.artifacts)) throw new TypeError('artifacts must be an array');
  if (!Array.isArray(receipt.warnings)) throw new TypeError('warnings must be an array');
  if (!Array.isArray(receipt.errors)) throw new TypeError('errors must be an array');
  return true;
}

export function createEngineRunReceipt(fields) {
  const receipt = {
    schema: ENGINE_RUN_RECEIPT_SCHEMA,
    engineId: fields.engineId,
    implementationOrigin: fields.implementationOrigin,
    implementationVersion: fields.implementationVersion ?? null,
    orchestrationMode: fields.orchestrationMode,
    snapshotId: fields.snapshotId,
    scopeDigest: fields.scopeDigest,
    attemptId: fields.attemptId,
    status: fields.status,
    claimLevel: fields.claimLevel,
    minimumClaimLevel: fields.minimumClaimLevel ?? null,
    claimSatisfied: fields.claimSatisfied,
    acceptance: structuredClone(fields.acceptance ?? {}),
    coverage: structuredClone(fields.coverage ?? {}),
    artifacts: structuredClone(fields.artifacts ?? []),
    warnings: structuredClone(fields.warnings ?? []),
    errors: structuredClone(fields.errors ?? []),
    hostCapabilities: structuredClone(fields.hostCapabilities ?? {})
  };
  validateEngineRunReceipt(receipt);
  return receipt;
}

function normalizeObject(value) {
  if (value == null) return {};
  requireRecord(value, 'request field');
  return structuredClone(value);
}

function requireRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
}

function requireString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} must be a non-empty string`);
}