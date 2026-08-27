export const ANALYSIS_REQUEST_SCHEMA = 'core.analysis-request/v1';
export const ANALYSIS_RESULT_SCHEMA = 'core.analysis-result/v1';
export const EVIDENCE_RECORD_SCHEMA = 'core.evidence/v1';
export const CLAIM_RECORD_SCHEMA = 'core.claim/v1';
export const COVERAGE_MANIFEST_SCHEMA = 'core.coverage/v1';

const MODES = new Set(['UNDERSTAND','TRACE','DIAGNOSE','IMPACT','REVIEW','AUDIT','RUNTIME']);
const POLICIES = new Set(['precision','balanced','exhaustive']);
const OUTPUT_PROFILES = new Set(['compact','standard','forensic']);
const RUN_STATUSES = new Set(['COMPLETE','PARTIAL','FAILED','SKIPPED']);
const EVIDENCE_KINDS = new Set(['SOURCE','STATIC_ANALYSIS','GIT','RUNTIME','TEST','EXTERNAL','USER']);
const CLAIM_TYPES = new Set(['OBSERVED','DERIVED','INFERRED','HYPOTHESIS','NEGATIVE','UNKNOWN']);
const CLAIM_STATUSES = new Set(['PROPOSED','VERIFIED','VERIFIED_WITH_LIMITS','REJECTED','UNRESOLVED']);
const CLAIM_LINK_ROLES = new Set(['SUPPORT','CONTRADICT','CONTEXT']);
const CLAIM_LINK_STRENGTHS = new Set(['DIRECT','INDIRECT','CORRELATED']);
const CONFIDENCE_LEVELS = new Set(['HIGH','MEDIUM','LOW']);
const COVERAGE_ROLES = new Set(['PRIMARY','DEPENDENCY','SUPPORTING_CONTEXT','RUNTIME_ARTIFACT']);
const COVERAGE_STATUSES = new Set(['PENDING','ANALYZED','REUSED','SKIPPED','FAILED','UNEXPLORED']);
const COMPLETENESS = new Set(['COMPLETE','BOUNDED','PARTIAL','UNKNOWN']);
const SNAPSHOT_KINDS = new Set(['COMMIT','WORKSPACE','MULTI_REPO','ARCHIVE']);
const WORKSPACE_STATES = new Set(['TRACKED','MODIFIED','UNTRACKED','DELETED']);

export class SchemaValidationError extends TypeError {
  constructor(schema, path, message) {
    super(`${schema}: ${path} ${message}`);
    this.name = 'SchemaValidationError';
    this.code = 'INVALID_REQUEST';
    this.schema = schema;
    this.path = path;
  }
}

export function validateAnalysisRequestV1(value) {
  const schema = ANALYSIS_REQUEST_SCHEMA;
  object(value, schema, '$');
  exactSchema(value, schema);
  if (typeof value.repository === 'string') nonEmptyString(value.repository, schema, '$.repository');
  else validateRepositoryIdentity(value.repository, '$.repository', schema);
  enumValue(value.mode, MODES, schema, '$.mode');
  nonEmptyString(value.question, schema, '$.question');
  enumValue(value.policy, POLICIES, schema, '$.policy');
  if (value.snapshot_selector != null) validateSnapshotSelector(value.snapshot_selector, schema, '$.snapshot_selector');
  if (value.scope != null) {
    object(value.scope, schema, '$.scope');
    if (value.scope.paths != null) stringArray(value.scope.paths, schema, '$.scope.paths');
    if (value.scope.symbols != null) stringArray(value.scope.symbols, schema, '$.scope.symbols');
  }
  if (value.budget != null) validateBudget(value.budget, schema, '$.budget');
  if (value.runtime_artifacts != null) array(value.runtime_artifacts, schema, '$.runtime_artifacts');
  if (value.ruleset_overrides != null) array(value.ruleset_overrides, schema, '$.ruleset_overrides');
  if (value.output_profile != null) enumValue(value.output_profile, OUTPUT_PROFILES, schema, '$.output_profile');
  return value;
}

export function validateAnalysisResultV1(value) {
  const schema = ANALYSIS_RESULT_SCHEMA;
  object(value, schema, '$');
  exactSchema(value, schema);
  nonEmptyString(value.analysis_id, schema, '$.analysis_id');
  nonEmptyString(value.session_id, schema, '$.session_id');
  validateRepositoryIdentity(value.repository, '$.repository', schema);
  validateSnapshotIdentity(value.snapshot, '$.snapshot', schema);
  enumValue(value.status, RUN_STATUSES, schema, '$.status');
  validateCoverageManifestV1(value.coverage, '$.coverage');
  if (value.status === 'COMPLETE' && !['COMPLETE','BOUNDED'].includes(value.coverage.completeness)) {
    fail(schema, '$.coverage.completeness', 'cannot be PARTIAL/UNKNOWN when result status is COMPLETE');
  }
  if (value.claims != null) {
    array(value.claims, schema, '$.claims');
    value.claims.forEach((claim, i) => validateClaimRecordV1(claim, `$.claims[${i}]`));
  }
  if (value.evidence != null) {
    array(value.evidence, schema, '$.evidence');
    value.evidence.forEach((record, i) => validateEvidenceRecordV1(record, `$.evidence[${i}]`));
  }
  for (const field of ['evidence_refs','counterevidence_refs','graph_paths','affected_symbols','negated_hypotheses','unknowns','verifier_records','warnings','failures','recommended_validation']) {
    if (value[field] != null) array(value[field], schema, `$.${field}`);
  }
  return value;
}

export function validateEvidenceRecordV1(value, basePath = '$') {
  const schema = EVIDENCE_RECORD_SCHEMA;
  object(value, schema, basePath);
  exactSchema(value, schema, basePath);
  nonEmptyString(value.id, schema, `${basePath}.id`);
  enumValue(value.kind, EVIDENCE_KINDS, schema, `${basePath}.kind`);
  if (!Object.hasOwn(value, 'observation')) fail(schema, `${basePath}.observation`, 'is required');
  validateProvenance(value.provenance, schema, `${basePath}.provenance`);
  sha256Digest(value.integrity_digest, schema, `${basePath}.integrity_digest`);
  nonEmptyString(value.trust_class, schema, `${basePath}.trust_class`);
  nonEmptyString(value.provider_id, schema, `${basePath}.provider_id`);
  nonEmptyString(value.provider_version, schema, `${basePath}.provider_version`);
  if (value.captured_at != null) nonEmptyString(value.captured_at, schema, `${basePath}.captured_at`);
  if (value.payload_ref != null) nonEmptyString(value.payload_ref, schema, `${basePath}.payload_ref`);
  return value;
}

export function validateClaimRecordV1(value, basePath = '$') {
  const schema = CLAIM_RECORD_SCHEMA;
  object(value, schema, basePath);
  exactSchema(value, schema, basePath);
  nonEmptyString(value.id, schema, `${basePath}.id`);
  enumValue(value.type, CLAIM_TYPES, schema, `${basePath}.type`);
  enumValue(value.status, CLAIM_STATUSES, schema, `${basePath}.status`);
  if (!Object.hasOwn(value, 'subject')) fail(schema, `${basePath}.subject`, 'is required');
  nonEmptyString(value.predicate, schema, `${basePath}.predicate`);
  if (!Object.hasOwn(value, 'object_or_value')) fail(schema, `${basePath}.object_or_value`, 'is required');
  validateClaimLinks(value.evidence_links, schema, `${basePath}.evidence_links`);
  validateClaimLinks(value.counterevidence_links, schema, `${basePath}.counterevidence_links`);
  stringArray(value.dependency_claim_ids, schema, `${basePath}.dependency_claim_ids`);
  nonEmptyString(value.coverage_ref, schema, `${basePath}.coverage_ref`);
  stringArray(value.provenance_refs, schema, `${basePath}.provenance_refs`);
  object(value.confidence, schema, `${basePath}.confidence`);
  enumValue(value.confidence.level, CONFIDENCE_LEVELS, schema, `${basePath}.confidence.level`);
  nonEmptyString(value.confidence.rationale, schema, `${basePath}.confidence.rationale`);
  array(value.verifier_results, schema, `${basePath}.verifier_results`);

  if (value.type === 'OBSERVED' && !value.evidence_links.some(link => link.role === 'SUPPORT' && link.strength === 'DIRECT')) {
    fail(schema, `${basePath}.evidence_links`, 'OBSERVED requires at least one DIRECT SUPPORT evidence link');
  }
  if (value.type === 'DERIVED') {
    if (!value.dependency_claim_ids.length) fail(schema, `${basePath}.dependency_claim_ids`, 'DERIVED requires dependency claims');
    object(value.derivation, schema, `${basePath}.derivation`);
    nonEmptyString(value.derivation.rule_id, schema, `${basePath}.derivation.rule_id`);
    nonEmptyString(value.derivation.rule_version, schema, `${basePath}.derivation.rule_version`);
  }
  if (value.type === 'HYPOTHESIS' && ['VERIFIED','VERIFIED_WITH_LIMITS'].includes(value.status)) {
    fail(schema, `${basePath}.status`, 'HYPOTHESIS cannot be rendered as a verified factual claim');
  }
  if (value.type === 'UNKNOWN') {
    if (value.status !== 'UNRESOLVED') fail(schema, `${basePath}.status`, 'UNKNOWN must remain UNRESOLVED');
    nonEmptyString(value.unresolved_reason, schema, `${basePath}.unresolved_reason`);
  }
  return value;
}

export function validateCoverageManifestV1(value, basePath = '$') {
  const schema = COVERAGE_MANIFEST_SCHEMA;
  object(value, schema, basePath);
  exactSchema(value, schema, basePath);
  enumValue(value.completeness, COMPLETENESS, schema, `${basePath}.completeness`);
  array(value.entries, schema, `${basePath}.entries`);
  let hasGap = false;
  for (let i = 0; i < value.entries.length; i++) {
    const entry = value.entries[i];
    const p = `${basePath}.entries[${i}]`;
    object(entry, schema, p);
    nonEmptyString(entry.id, schema, `${p}.id`);
    enumValue(entry.role, COVERAGE_ROLES, schema, `${p}.role`);
    enumValue(entry.status, COVERAGE_STATUSES, schema, `${p}.status`);
    if (entry.status === 'PENDING') fail(schema, `${p}.status`, 'terminal Coverage Manifest cannot contain PENDING entries');
    if (['FAILED','UNEXPLORED'].includes(entry.status)) hasGap = true;
    if (['SKIPPED','FAILED','UNEXPLORED'].includes(entry.status)) nonEmptyString(entry.reason, schema, `${p}.reason`);
  }
  if (value.completeness === 'COMPLETE' && value.entries.some(entry => ['FAILED','UNEXPLORED'].includes(entry.status))) {
    fail(schema, `${basePath}.completeness`, 'COMPLETE cannot contain FAILED or UNEXPLORED relevant items');
  }
  if (value.completeness === 'BOUNDED' && value.entries.some(entry => entry.status === 'FAILED')) {
    fail(schema, `${basePath}.completeness`, 'BOUNDED cannot hide FAILED items');
  }
  if (value.completeness === 'PARTIAL' && !hasGap) {
    fail(schema, `${basePath}.completeness`, 'PARTIAL requires at least one FAILED or UNEXPLORED item');
  }
  return value;
}

export function validateRepositoryIdentity(value, basePath = '$', schema = 'core.repository-identity/v1') {
  object(value, schema, basePath);
  if (value.schema !== 'core.repository-identity/v1') fail(schema, `${basePath}.schema`, 'must equal core.repository-identity/v1');
  enumValue(value.vcs, new Set(['git','filesystem']), schema, `${basePath}.vcs`);
  nonEmptyString(value.canonical_identity, schema, `${basePath}.canonical_identity`);
  if (typeof value.repository_id !== 'string' || !/^repo:sha256:[0-9a-f]{64}$/.test(value.repository_id)) {
    fail(schema, `${basePath}.repository_id`, 'must be repo:sha256:<64 hex>');
  }
  if (value.object_format != null && !['sha1','sha256'].includes(value.object_format)) fail(schema, `${basePath}.object_format`, 'must be sha1 or sha256');
  return value;
}

export function validateSnapshotIdentity(value, basePath = '$', schema = 'core.snapshot-identity/v1') {
  object(value, schema, basePath);
  if (value.schema !== 'core.snapshot-identity/v1') fail(schema, `${basePath}.schema`, 'must equal core.snapshot-identity/v1');
  enumValue(value.kind, SNAPSHOT_KINDS, schema, `${basePath}.kind`);
  if (typeof value.snapshot_id !== 'string' || !/^snapshot:sha256:[0-9a-f]{64}$/.test(value.snapshot_id)) fail(schema, `${basePath}.snapshot_id`, 'must be snapshot:sha256:<64 hex>');

  if (value.kind === 'MULTI_REPO') {
    if (value.repository_id !== null) fail(schema, `${basePath}.repository_id`, 'must be null for MULTI_REPO');
    array(value.constituents, schema, `${basePath}.constituents`);
    if (value.constituents.length < 2) fail(schema, `${basePath}.constituents`, 'must contain at least two repositories');
    value.constituents.forEach((item, i) => {
      object(item, schema, `${basePath}.constituents[${i}]`);
      repositoryId(item.repository_id, schema, `${basePath}.constituents[${i}].repository_id`);
      snapshotId(item.snapshot_id, schema, `${basePath}.constituents[${i}].snapshot_id`);
    });
    sha256Digest(value.content_manifest_digest, schema, `${basePath}.content_manifest_digest`);
    return value;
  }

  repositoryId(value.repository_id, schema, `${basePath}.repository_id`);
  if (value.kind === 'COMMIT') commitSha(value.base_commit, schema, `${basePath}.base_commit`);
  if (value.kind === 'WORKSPACE') {
    if (value.base_commit != null) commitSha(value.base_commit, schema, `${basePath}.base_commit`);
    sha256Digest(value.content_manifest_digest, schema, `${basePath}.content_manifest_digest`);
    array(value.content_manifest, schema, `${basePath}.content_manifest`);
    const seen = new Set();
    value.content_manifest.forEach((entry, i) => {
      const p = `${basePath}.content_manifest[${i}]`;
      object(entry, schema, p);
      nonEmptyString(entry.path, schema, `${p}.path`);
      if (seen.has(entry.path)) fail(schema, `${p}.path`, 'must be unique');
      seen.add(entry.path);
      enumValue(entry.state, WORKSPACE_STATES, schema, `${p}.state`);
      if (entry.state === 'DELETED') {
        if (entry.digest !== null) fail(schema, `${p}.digest`, 'must be null for DELETED');
      } else sha256Digest(entry.digest, schema, `${p}.digest`);
    });
    if (value.index_digest != null) sha256Digest(value.index_digest, schema, `${basePath}.index_digest`);
  }
  if (value.kind === 'ARCHIVE') sha256Digest(value.archive_digest, schema, `${basePath}.archive_digest`);
  return value;
}

function validateProvenance(value, schema, basePath) {
  object(value, schema, basePath);
  repositoryId(value.repository_id, schema, `${basePath}.repository_id`);
  snapshotId(value.snapshot_id, schema, `${basePath}.snapshot_id`);
  nonEmptyString(value.provider_id, schema, `${basePath}.provider_id`);
  nonEmptyString(value.provider_version, schema, `${basePath}.provider_version`);
  nonEmptyString(value.extraction_method, schema, `${basePath}.extraction_method`);
  if (value.artifact_digest != null) sha256Digest(value.artifact_digest, schema, `${basePath}.artifact_digest`);
  if (value.range != null) {
    object(value.range, schema, `${basePath}.range`);
    positiveInteger(value.range.start_line, schema, `${basePath}.range.start_line`);
    positiveInteger(value.range.end_line, schema, `${basePath}.range.end_line`);
    if (value.range.end_line < value.range.start_line) fail(schema, `${basePath}.range.end_line`, 'must be >= start_line');
    if (value.range.start_column != null) positiveInteger(value.range.start_column, schema, `${basePath}.range.start_column`, true);
    if (value.range.end_column != null) positiveInteger(value.range.end_column, schema, `${basePath}.range.end_column`, true);
  }
}

function validateClaimLinks(value, schema, basePath) {
  array(value, schema, basePath);
  value.forEach((link, i) => {
    const p = `${basePath}[${i}]`;
    object(link, schema, p);
    nonEmptyString(link.evidence_id, schema, `${p}.evidence_id`);
    enumValue(link.role, CLAIM_LINK_ROLES, schema, `${p}.role`);
    enumValue(link.strength, CLAIM_LINK_STRENGTHS, schema, `${p}.strength`);
    if (link.rationale != null) nonEmptyString(link.rationale, schema, `${p}.rationale`);
  });
}

function validateSnapshotSelector(value, schema, basePath) {
  object(value, schema, basePath);
  enumValue(value.kind, SNAPSHOT_KINDS, schema, `${basePath}.kind`);
  if (value.kind === 'COMMIT') commitSha(value.commit ?? value.base_commit, schema, `${basePath}.commit`);
}

function validateBudget(value, schema, basePath) {
  object(value, schema, basePath);
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'number' || !Number.isFinite(item) || item < 0) fail(schema, `${basePath}.${key}`, 'must be a finite non-negative number');
  }
}

function exactSchema(value, schema, basePath = '$') {
  if (value.schema !== schema) fail(schema, `${basePath}.schema`, `must equal ${schema}`);
}
function object(value, schema, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(schema, path, 'must be an object');
}
function array(value, schema, path) {
  if (!Array.isArray(value)) fail(schema, path, 'must be an array');
}
function stringArray(value, schema, path) {
  array(value, schema, path);
  value.forEach((item, i) => nonEmptyString(item, schema, `${path}[${i}]`));
}
function nonEmptyString(value, schema, path) {
  if (typeof value !== 'string' || !value.trim()) fail(schema, path, 'must be a non-empty string');
}
function enumValue(value, allowed, schema, path) {
  if (!allowed.has(value)) fail(schema, path, `must be one of ${[...allowed].join(', ')}`);
}
function repositoryId(value, schema, path) {
  if (typeof value !== 'string' || !/^repo:sha256:[0-9a-f]{64}$/.test(value)) fail(schema, path, 'must be repo:sha256:<64 hex>');
}
function snapshotId(value, schema, path) {
  if (typeof value !== 'string' || !/^snapshot:sha256:[0-9a-f]{64}$/.test(value)) fail(schema, path, 'must be snapshot:sha256:<64 hex>');
}
function sha256Digest(value, schema, path) {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value)) fail(schema, path, 'must be sha256:<64 hex>');
}
function commitSha(value, schema, path) {
  if (typeof value !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value)) fail(schema, path, 'must be a full SHA-1 or SHA-256 commit id');
}
function positiveInteger(value, schema, path, allowZero = false) {
  if (!Number.isInteger(value) || value < (allowZero ? 0 : 1)) fail(schema, path, `must be an integer >= ${allowZero ? 0 : 1}`);
}
function fail(schema, path, message) {
  throw new SchemaValidationError(schema, path, message);
}
