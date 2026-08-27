import test from 'node:test';
import assert from 'node:assert/strict';
import { createRepositoryIdentity } from '../src/core/identity/repository.mjs';
import { createWorkspaceSnapshot } from '../src/core/identity/snapshot.mjs';
import {
  validateAnalysisRequestV1,
  validateAnalysisResultV1,
  validateClaimRecordV1,
  validateCoverageManifestV1,
  validateEvidenceRecordV1,
  validateRepositoryIdentity,
  validateSnapshotIdentity
} from '../src/core/schema/v1.mjs';

const repository = createRepositoryIdentity({ root: '/tmp/kneekura-schema-fixture' });
const snapshot = createWorkspaceSnapshot(repository, {
  entries: [{ path: 'src/A.java', state: 'UNTRACKED', digest: `sha256:${'1'.repeat(64)}` }]
});
const coverage = {
  schema: 'core.coverage/v1',
  completeness: 'COMPLETE',
  entries: [{ id: 'src/A.java', role: 'PRIMARY', status: 'ANALYZED' }]
};
const evidence = {
  schema: 'core.evidence/v1',
  id: 'evidence:source-a',
  kind: 'SOURCE',
  observation: { text: 'class A {}' },
  provenance: {
    repository_id: repository.repository_id,
    snapshot_id: snapshot.snapshot_id,
    provider_id: 'source-file',
    provider_version: 'v1',
    path: 'src/A.java',
    extraction_method: 'read'
  },
  integrity_digest: `sha256:${'2'.repeat(64)}`,
  trust_class: 'repository',
  provider_id: 'source-file',
  provider_version: 'v1'
};
const claim = {
  schema: 'core.claim/v1',
  id: 'claim:a-exists',
  type: 'OBSERVED',
  status: 'VERIFIED',
  subject: 'src/A.java',
  predicate: 'exists',
  object_or_value: true,
  evidence_links: [{ evidence_id: evidence.id, role: 'SUPPORT', strength: 'DIRECT' }],
  counterevidence_links: [],
  dependency_claim_ids: [],
  coverage_ref: 'coverage:fixture',
  provenance_refs: [evidence.id],
  confidence: { level: 'HIGH', rationale: 'direct source observation' },
  verifier_results: []
};

function validRequest() {
  return {
    schema: 'core.analysis-request/v1',
    repository,
    mode: 'TRACE',
    question: 'Where is A used?',
    policy: 'balanced',
    output_profile: 'compact'
  };
}

function validResult() {
  return {
    schema: 'core.analysis-result/v1',
    analysis_id: 'analysis:fixture',
    session_id: 'session:fixture',
    repository,
    snapshot,
    status: 'COMPLETE',
    coverage,
    claims: [claim],
    evidence: [evidence],
    unknowns: [],
    failures: []
  };
}

test('canonical v1 validators accept valid request/result/evidence/coverage and identities', () => {
  assert.equal(validateRepositoryIdentity(repository), repository);
  assert.equal(validateSnapshotIdentity(snapshot), snapshot);
  assert.equal(validateCoverageManifestV1(coverage), coverage);
  assert.equal(validateEvidenceRecordV1(evidence), evidence);
  assert.equal(validateClaimRecordV1(claim), claim);
  assert.deepEqual(validateAnalysisRequestV1(validRequest()), validRequest());
  assert.deepEqual(validateAnalysisResultV1(validResult()), validResult());
});

test('AnalysisRequest v1 rejects bad schema and enum values', () => {
  assert.throws(() => validateAnalysisRequestV1({ ...validRequest(), schema: 'core.analysis-request/v2' }), /must equal core\.analysis-request\/v1/);
  assert.throws(() => validateAnalysisRequestV1({ ...validRequest(), mode: 'GUESS' }), /must be one of/);
  assert.throws(() => validateAnalysisRequestV1({ ...validRequest(), policy: 'fast' }), /must be one of/);
});

test('identity validators reject malformed repository and snapshot ids', () => {
  assert.throws(() => validateRepositoryIdentity({ ...repository, repository_id: 'owner_repo' }), /repo:sha256/);
  assert.throws(() => validateSnapshotIdentity({ ...snapshot, snapshot_id: 'same-head' }), /snapshot:sha256/);
});

test('EvidenceRecord v1 rejects bad kinds, integrity digests and missing provenance anchors', () => {
  assert.throws(() => validateEvidenceRecordV1({ ...evidence, kind: 'MAGIC' }), /must be one of/);
  assert.throws(() => validateEvidenceRecordV1({ ...evidence, integrity_digest: 'sha1:bad' }), /sha256/);
  assert.throws(() => validateEvidenceRecordV1({ ...evidence, provenance: { ...evidence.provenance, snapshot_id: null } }), /snapshot:sha256/);
});

test('Coverage Manifest v1 rejects pending or impossible completeness/state combinations', () => {
  assert.throws(() => validateCoverageManifestV1({
    schema: 'core.coverage/v1', completeness: 'COMPLETE', entries: [{ id: 'A', role: 'PRIMARY', status: 'PENDING' }]
  }), /cannot contain PENDING/);
  assert.throws(() => validateCoverageManifestV1({
    schema: 'core.coverage/v1', completeness: 'COMPLETE', entries: [{ id: 'A', role: 'PRIMARY', status: 'FAILED', reason: 'parse failed' }]
  }), /COMPLETE cannot contain FAILED/);
  assert.throws(() => validateCoverageManifestV1({
    schema: 'core.coverage/v1', completeness: 'PARTIAL', entries: [{ id: 'A', role: 'PRIMARY', status: 'ANALYZED' }]
  }), /PARTIAL requires/);
});

test('ClaimRecord v1 rejects impossible claim status/evidence combinations', () => {
  assert.throws(() => validateClaimRecordV1({ ...claim, evidence_links: [] }), /OBSERVED requires/);
  assert.throws(() => validateClaimRecordV1({ ...claim, type: 'HYPOTHESIS', status: 'VERIFIED' }), /HYPOTHESIS cannot/);
  assert.throws(() => validateClaimRecordV1({ ...claim, type: 'UNKNOWN', status: 'VERIFIED', unresolved_reason: 'not resolved' }), /UNKNOWN must remain UNRESOLVED/);
});

test('AnalysisResult v1 cannot claim COMPLETE over partial or unknown coverage', () => {
  const partial = {
    schema: 'core.coverage/v1',
    completeness: 'PARTIAL',
    entries: [{ id: 'src/B.java', role: 'DEPENDENCY', status: 'UNEXPLORED', reason: 'budget' }]
  };
  assert.throws(() => validateAnalysisResultV1({ ...validResult(), coverage: partial }), /cannot be PARTIAL\/UNKNOWN/);
});
