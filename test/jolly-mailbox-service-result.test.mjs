import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createClaimEvidenceLink,
  createClaimRecord,
  applyVerificationResult
} from '../src/core/ledger/claims.mjs';
import {
  toJollyResearchMailboxServiceResult,
  JOLLY_MAILBOX_SERVICE_RESULT_SCHEMA,
  JOLLY_MAILBOX_SERVICE,
  JOLLY_MAILBOX_ANALYSIS_MODES
} from '../src/mailbox.mjs';

const REPOSITORY_ID = 'repo:sha256:' + '1'.repeat(64);
const SNAPSHOT_ID = 'snapshot:sha256:' + '2'.repeat(64);
const COMMIT = 'a'.repeat(40);
const COVERAGE_FINGERPRINT = 'sha256:' + '5'.repeat(64);
const EVIDENCE_ID = 'evidence:sha256:' + '3'.repeat(64);

function baseResult({
  snapshotKind = 'COMMIT',
  status = 'COMPLETE',
  completeness = 'COMPLETE',
  unknowns = [],
  warnings = [],
  failures = [],
  includeEvidence = true,
  externalResearch = false
} = {}) {
  const snapshot = snapshotKind === 'COMMIT'
    ? {
        schema: 'core.snapshot-identity/v1',
        kind: 'COMMIT',
        repository_id: REPOSITORY_ID,
        snapshot_id: SNAPSHOT_ID,
        base_commit: COMMIT
      }
    : {
        schema: 'core.snapshot-identity/v1',
        kind: 'WORKSPACE',
        repository_id: REPOSITORY_ID,
        snapshot_id: SNAPSHOT_ID,
        base_commit: COMMIT,
        content_manifest_digest: 'sha256:' + '6'.repeat(64),
        content_manifest: [{
          path: 'src/Foo.java',
          state: 'MODIFIED',
          digest: 'sha256:' + '7'.repeat(64)
        }],
        index_digest: null
      };

  const coverageEntries = completeness === 'PARTIAL'
    ? [{
        id: 'scope:foo',
        role: 'PRIMARY',
        status: 'UNEXPLORED',
        reason: 'fixture coverage gap',
        reason_code: 'FIXTURE_GAP'
      }]
    : [{
        id: 'scope:foo',
        role: 'PRIMARY',
        status: 'ANALYZED'
      }];

  const evidence = {
    schema: 'core.evidence/v1',
    id: EVIDENCE_ID,
    kind: 'SOURCE',
    observation: {
      source_path: 'src/Foo.java',
      symbol: 'Foo#run',
      fact: 'Foo#run returns the measured fixture value'
    },
    provenance: {
      repository_id: REPOSITORY_ID,
      snapshot_id: SNAPSHOT_ID,
      provider_id: 'fixture-provider',
      provider_version: 'v1',
      extraction_method: 'fixture-direct-v1',
      path: 'src/Foo.java',
      symbol: 'Foo#run',
      range: {
        start_line: 10,
        end_line: 12
      }
    },
    integrity_digest: 'sha256:' + '4'.repeat(64),
    trust_class: 'REPOSITORY_UNTRUSTED',
    provider_id: 'fixture-provider',
    provider_version: 'v1'
  };

  const observed = applyVerificationResult(
    createClaimRecord({
      type: 'OBSERVED',
      subject: { node_id: 'node:foo' },
      predicate: 'fixture.observed_behavior',
      objectOrValue: {
        value: 'measured'
      },
      evidenceLinks: [
        createClaimEvidenceLink({
          evidenceId: EVIDENCE_ID,
          role: 'SUPPORT',
          strength: 'DIRECT'
        })
      ],
      coverageRef: COVERAGE_FINGERPRINT,
      confidence: {
        level: 'HIGH',
        rationale: 'direct fixture evidence'
      }
    }),
    {
      status: 'VERIFIED',
      verifierResults: []
    }
  );

  const rejected = applyVerificationResult(
    createClaimRecord({
      type: 'HYPOTHESIS',
      subject: { node_id: 'node:foo' },
      predicate: 'fixture.rejected_candidate',
      objectOrValue: true,
      coverageRef: COVERAGE_FINGERPRINT,
      confidence: {
        level: 'LOW',
        rationale: 'fixture hypothesis'
      }
    }),
    {
      status: 'REJECTED',
      verifierResults: []
    }
  );

  const resultUnknowns = [
    ...unknowns,
    ...(externalResearch ? [{
      kind: 'CLAIM',
      ref: 'claim:external',
      reason: 'External API guarantee is not present in repository evidence',
      reason_code: 'EXTERNAL_RESEARCH_REQUIRED'
    }] : [])
  ];

  return {
    schema: 'core.analysis-result/v1',
    analysis_id: 'analysis:fixture',
    session_id: 'session:fixture',
    repository: {
      schema: 'core.repository-identity/v1',
      vcs: 'git',
      canonical_identity: 'git:github.com/owner/repo',
      repository_id: REPOSITORY_ID
    },
    snapshot,
    status,
    coverage: {
      schema: 'core.coverage/v1',
      completeness,
      entries: coverageEntries,
      universe_enumerable: true,
      closure: {
        kind: 'FULL',
        boundary_reached: false
      },
      snapshot_id: SNAPSHOT_ID,
      fingerprint: COVERAGE_FINGERPRINT
    },
    claims: [observed, rejected],
    evidence: includeEvidence ? [evidence] : [],
    evidence_refs: [EVIDENCE_ID],
    counterevidence_refs: [],
    graph_paths: [],
    affected_symbols: [{
      node_id: 'node:foo',
      kind: 'method',
      key: 'demo.Foo#run',
      label: 'Foo#run',
      path: 'src/Foo.java'
    }],
    negated_hypotheses: [{
      claim_id: rejected.id,
      type: rejected.type,
      status: rejected.status
    }],
    unknowns: resultUnknowns,
    verifier_records: [],
    warnings,
    failures,
    recommended_validation: [{
      code: 'FIXTURE_REGRESSION',
      message: 'Run the focused fixture regression.'
    }]
  };
}

function context(overrides = {}) {
  return {
    jobId: 'JOB-20260828-mailbox-fixture',
    sourceRepository: 'owner/repo',
    sourceRef: 'main',
    sourceCommit: COMMIT,
    analysisMode: 'bug_hunt',
    ...overrides
  };
}

test('service projection publishes the mailbox service contract without inventing root cause or source changes', () => {
  const result = baseResult();
  const projected = toJollyResearchMailboxServiceResult(
    result,
    context({
      analysisMode: 'architecture'
    })
  );

  assert.equal(
    projected.schema,
    JOLLY_MAILBOX_SERVICE_RESULT_SCHEMA
  );
  assert.equal(
    JOLLY_MAILBOX_SERVICE_RESULT_SCHEMA,
    'jolly.research-mailbox-service-result/v1'
  );
  assert.equal(projected.service, JOLLY_MAILBOX_SERVICE);
  assert.equal(JOLLY_MAILBOX_SERVICE, 'kneekura-code-lab');
  assert.equal(projected.status, 'completed');
  assert.equal(projected.source_repository, 'owner/repo');
  assert.equal(projected.source_ref, 'main');
  assert.equal(projected.source_commit, COMMIT);
  assert.equal(projected.analysis_mode, 'architecture');
  assert.equal(projected.canonical.analysis_id, result.analysis_id);
  assert.equal(
    projected.canonical.coverage.completeness,
    'COMPLETE'
  );

  assert.deepEqual(projected.root_cause.claim_ids, []);
  assert.equal(projected.root_cause.established, false);
  assert.deepEqual(projected.recommended_changes, []);
  assert.deepEqual(projected.do_not_change, []);
  assert.equal(
    projected.projection_limits.root_cause_inference,
    false
  );
  assert.equal(
    projected.projection_limits.source_change_recommendation_inference,
    false
  );

  assert.equal(projected.evidence.length, 1);
  assert.deepEqual(projected.evidence[0].lines, {
    start: 10,
    end: 12
  });
  assert.equal(projected.evidence[0].file, 'src/Foo.java');
  assert.equal(projected.evidence[0].symbol, 'Foo#run');
  assert.equal(
    projected.evidence[0].finding.fact,
    'Foo#run returns the measured fixture value'
  );
  assert.deepEqual(
    projected.evidence[0].relevance.map(item => item.claim_id),
    [result.claims[0].id]
  );

  assert.equal(projected.rejected_hypotheses.length, 1);
  assert.equal(
    projected.rejected_hypotheses[0].claim.id,
    result.claims[1].id
  );
  assert.deepEqual(
    projected.verification_plan,
    result.recommended_validation
  );
  assert.equal(projected.research_required.required, false);
  assert.equal(projected.confidence.level, 'high');
});

test('service projection keeps bug_hunt partial until a canonical root cause exists', () => {
  const projected = toJollyResearchMailboxServiceResult(
    baseResult(),
    context({
      analysisMode: 'bug_hunt'
    })
  );

  assert.equal(projected.status, 'partial');
  assert.equal(projected.root_cause.established, false);
  assert.match(
    projected.bottom_line,
    /bug_hunt remains partial/
  );
});

test('service projection refuses to call a workspace snapshot completed or partial', () => {
  const projected = toJollyResearchMailboxServiceResult(
    baseResult({
      snapshotKind: 'WORKSPACE'
    }),
    context()
  );

  assert.equal(projected.status, 'needs_context');
  assert.equal(projected.source_snapshot_kind, 'WORKSPACE');
  assert.equal(
    projected.remaining_uncertainty[0].kind,
    'SOURCE_PIN'
  );
  assert.match(
    projected.remaining_uncertainty[0].reason,
    /commit-pinned analysis/
  );
  assert.equal(projected.confidence.level, 'low');
});

test('service projection maps canonical PARTIAL coverage without hiding the gap', () => {
  const projected = toJollyResearchMailboxServiceResult(
    baseResult({
      status: 'PARTIAL',
      completeness: 'PARTIAL',
      unknowns: [{
        kind: 'COVERAGE',
        ref: 'scope:foo',
        reason: 'fixture coverage gap',
        reason_code: 'FIXTURE_GAP'
      }]
    }),
    context()
  );

  assert.equal(projected.status, 'partial');
  assert.equal(
    projected.canonical.coverage.completeness,
    'PARTIAL'
  );
  assert.equal(
    projected.remaining_uncertainty.some(item =>
      item.kind === 'CORE_UNKNOWN' &&
      item.value.reason_code === 'FIXTURE_GAP'
    ),
    true
  );
  assert.equal(projected.confidence.level, 'low');
});

test('service projection fails fast on a source commit mismatch', () => {
  assert.throws(
    () => toJollyResearchMailboxServiceResult(
      baseResult(),
      context({
        sourceCommit: 'b'.repeat(40)
      })
    ),
    /sourceCommit does not match AnalysisResult snapshot base_commit/
  );
});

test('service projection normalizes GitHub source_repository output after validation', () => {
  const projected = toJollyResearchMailboxServiceResult(
    baseResult(),
    context({
      sourceRepository: ' Owner/Repo.git ',
      analysisMode: 'architecture'
    })
  );

  assert.equal(projected.source_repository, 'owner/repo');
});

test('service projection rejects a source repository that conflicts with canonical GitHub identity', () => {
  assert.throws(
    () => toJollyResearchMailboxServiceResult(
      baseResult(),
      context({
        sourceRepository: 'other/repo',
        analysisMode: 'architecture'
      })
    ),
    /sourceRepository does not match AnalysisResult repository identity/
  );
});

test('service projection requires a canonical mailbox analysis mode and full commit id', () => {
  assert.equal(
    JOLLY_MAILBOX_ANALYSIS_MODES.includes('bug_hunt'),
    true
  );

  assert.throws(
    () => toJollyResearchMailboxServiceResult(
      baseResult(),
      context({
        analysisMode: 'totally_new_mode'
      })
    ),
    /analysisMode must be one of/
  );

  assert.throws(
    () => toJollyResearchMailboxServiceResult(
      baseResult(),
      context({
        sourceCommit: 'abc123'
      })
    ),
    /sourceCommit must be a full SHA-1 or SHA-256 commit id/
  );
});

test('service projection surfaces missing inline Evidence as uncertainty instead of fabricating file or line data', () => {
  const result = baseResult({
    includeEvidence: false
  });
  const projected = toJollyResearchMailboxServiceResult(
    result,
    context()
  );

  assert.equal(projected.evidence.length, 1);
  assert.deepEqual(projected.evidence[0], {
    evidence_id: EVIDENCE_ID,
    record_available: false,
    relevance: [{
      claim_id: result.claims[0].id,
      role: 'SUPPORT',
      strength: 'DIRECT',
      channel: 'support'
    }]
  });
  assert.equal(
    projected.remaining_uncertainty.some(item =>
      item.kind === 'EVIDENCE_RECORD_UNAVAILABLE' &&
      item.evidence_id === EVIDENCE_ID
    ),
    true
  );
});

test('service projection preserves CORE warnings as uncertainty and lowers aggregate confidence', () => {
  const projected = toJollyResearchMailboxServiceResult(
    baseResult({
      warnings: [{
        code: 'PROPOSAL_LIMIT_EXCEEDED',
        message: 'fixture warning'
      }]
    }),
    context({
      analysisMode: 'architecture'
    })
  );

  assert.equal(
    projected.remaining_uncertainty.some(item =>
      item.kind === 'CORE_WARNING' &&
      item.value.code === 'PROPOSAL_LIMIT_EXCEEDED'
    ),
    true
  );
  assert.equal(projected.confidence.level, 'medium');
});

test('service projection does not mislabel unresolved hypotheses as rejected', () => {
  const result = baseResult();
  const unresolved = applyVerificationResult(
    createClaimRecord({
      type: 'HYPOTHESIS',
      subject: { node_id: 'node:foo' },
      predicate: 'fixture.unresolved_candidate',
      objectOrValue: true,
      coverageRef: COVERAGE_FINGERPRINT,
      confidence: {
        level: 'LOW',
        rationale: 'fixture unresolved hypothesis'
      }
    }),
    {
      status: 'UNRESOLVED',
      verifierResults: []
    }
  );

  result.claims.push(unresolved);
  result.negated_hypotheses.push({
    claim_id: unresolved.id,
    type: unresolved.type,
    status: unresolved.status
  });
  result.unknowns.push({
    kind: 'CLAIM',
    ref: unresolved.id,
    reason: 'fixture hypothesis remains unresolved'
  });

  const projected = toJollyResearchMailboxServiceResult(
    result,
    context({
      analysisMode: 'architecture'
    })
  );

  assert.equal(
    projected.rejected_hypotheses.some(item =>
      item.kind === 'CLAIM' &&
      item.claim.id === unresolved.id
    ),
    false
  );
  assert.equal(
    projected.remaining_uncertainty.some(item =>
      item.kind === 'CORE_UNKNOWN' &&
      item.value.ref === unresolved.id
    ),
    true
  );
});

test('service projection marks explicit external-research unknowns without turning other unknowns into web research', () => {
  const projected = toJollyResearchMailboxServiceResult(
    baseResult({
      status: 'PARTIAL',
      completeness: 'PARTIAL',
      externalResearch: true
    }),
    context({
      analysisMode: 'integration'
    })
  );

  assert.equal(projected.research_required.required, true);
  assert.equal(projected.research_required.questions.length, 1);
  assert.match(
    projected.research_required.questions[0].question,
    /External API guarantee/
  );
});

test('service projection output is detached from the canonical AnalysisResult', () => {
  const result = baseResult();
  const before = structuredClone(result);
  const projected = toJollyResearchMailboxServiceResult(
    result,
    context()
  );

  projected.evidence[0].finding.fact = 'host-mutated';
  projected.affected_components[0].path = 'host-mutated';
  projected.verification_plan.push({
    code: 'HOST_MUTATED'
  });
  projected.remaining_uncertainty.push({
    kind: 'HOST_MUTATED'
  });

  assert.deepEqual(result, before);
});
