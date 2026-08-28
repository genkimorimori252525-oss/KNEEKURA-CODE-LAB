import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCoreEngine } from '../src/core/api.mjs';
import {
  createClaimEvidenceLink,
  createClaimRecord,
  applyVerificationResult
} from '../src/core/ledger/claims.mjs';
import {
  toJollyResearchMailbox,
  JOLLY_MAILBOX_ENTRY_SCHEMA
} from '../src/mailbox.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FIXTURE = path.join(ROOT, 'fixtures/forge-mini');

async function canonicalResult() {
  const engine = createCoreEngine();
  const result = await engine.analyze({
    schema: 'core.analysis-request/v1',
    repository: FIXTURE,
    mode: 'TRACE',
    question: 'Trace ReimuPacket for mailbox rendering.',
    scope: {
      paths: ['ReimuPacket.java']
    },
    policy: 'precision',
    output_profile: 'compact'
  });

  const claim = createClaimRecord({
    type: 'INFERRED',
    subject: { node_id: 'node:mailbox-subject' },
    predicate: 'mailbox_test_predicate',
    objectOrValue: {
      outcome: 'preserved'
    },
    evidenceLinks: [
      createClaimEvidenceLink({
        evidenceId: 'evidence:mailbox-support',
        role: 'SUPPORT',
        strength: 'DIRECT'
      })
    ],
    counterevidenceLinks: [
      createClaimEvidenceLink({
        evidenceId: 'evidence:mailbox-counter',
        role: 'CONTRADICT',
        strength: 'DIRECT'
      })
    ],
    coverageRef: result.coverage.fingerprint ?? result.snapshot.snapshot_id,
    confidence: {
      level: 'MEDIUM',
      rationale: 'fixture claim for consumer mapping'
    }
  });

  result.claims = [
    applyVerificationResult(claim, {
      status: 'VERIFIED_WITH_LIMITS',
      verifierResults: []
    })
  ];
  result.unknowns = [{
    kind: 'COVERAGE',
    reason_code: 'MAILBOX_TEST_UNKNOWN'
  }];
  result.warnings = [{
    code: 'MAILBOX_TEST_WARNING'
  }];
  result.failures = [];
  result.recommended_validation = [{
    kind: 'TEST',
    description: 'Run the mailbox consumer regression.'
  }];

  return result;
}

test('Jolly mailbox compact mapping preserves canonical identities and qualifiers', async () => {
  const result = await canonicalResult();
  const entry = toJollyResearchMailbox(result);

  assert.equal(entry.schema, JOLLY_MAILBOX_ENTRY_SCHEMA);
  assert.equal(
    JOLLY_MAILBOX_ENTRY_SCHEMA,
    'jolly.research-mailbox-analysis/v1'
  );
  assert.equal(entry.source_schema, 'core.analysis-result/v1');
  assert.equal(entry.analysis_id, result.analysis_id);
  assert.equal(entry.session_id, result.session_id);
  assert.equal(entry.run_status, result.status);
  assert.equal(entry.snapshot_id, result.snapshot.snapshot_id);
  assert.deepEqual(entry.coverage, {
    completeness: result.coverage.completeness,
    fingerprint: result.coverage.fingerprint ?? null
  });

  assert.equal(entry.claims.length, 1);
  assert.deepEqual(entry.claims[0], {
    id: result.claims[0].id,
    status: 'VERIFIED_WITH_LIMITS',
    type: 'INFERRED',
    predicate: 'mailbox_test_predicate',
    value: {
      outcome: 'preserved'
    },
    evidence_ids: ['evidence:mailbox-support'],
    counterevidence_ids: ['evidence:mailbox-counter']
  });
  assert.deepEqual(entry.unknowns, result.unknowns);
  assert.deepEqual(entry.warnings, result.warnings);
  assert.deepEqual(entry.failures, result.failures);
  assert.deepEqual(
    entry.recommended_validation,
    result.recommended_validation
  );
});

test('Jolly mailbox standard profile adds subject and confidence without changing claim semantics', async () => {
  const result = await canonicalResult();
  const compact = toJollyResearchMailbox(result, {
    profile: 'compact'
  });
  const standard = toJollyResearchMailbox(result, {
    profile: 'standard'
  });

  assert.equal(Object.hasOwn(compact.claims[0], 'subject'), false);
  assert.equal(Object.hasOwn(compact.claims[0], 'confidence'), false);
  assert.deepEqual(standard.claims[0].subject, result.claims[0].subject);
  assert.deepEqual(
    standard.claims[0].confidence,
    result.claims[0].confidence
  );

  for (const field of [
    'id',
    'status',
    'type',
    'predicate',
    'value',
    'evidence_ids',
    'counterevidence_ids'
  ]) {
    assert.deepEqual(
      standard.claims[0][field],
      compact.claims[0][field]
    );
  }
});

test('Jolly mailbox output is detached from the canonical AnalysisResult', async () => {
  const result = await canonicalResult();
  const before = structuredClone(result);
  const entry = toJollyResearchMailbox(result, {
    profile: 'standard'
  });

  entry.claims[0].value.outcome = 'host-mutated';
  entry.claims[0].subject.node_id = 'node:host-mutated';
  entry.unknowns.push({
    kind: 'HOST_MUTATION'
  });
  entry.recommended_validation.push({
    kind: 'HOST_MUTATION'
  });

  assert.deepEqual(result, before);
});

test('Jolly mailbox adapter rejects malformed profile and malformed canonical results', async () => {
  const result = await canonicalResult();

  assert.throws(
    () => toJollyResearchMailbox(result, {
      profile: 'forensic'
    }),
    /mailbox profile must be compact or standard/
  );

  assert.throws(
    () => toJollyResearchMailbox({
      ...result,
      schema: 'fixture.invalid/v1'
    }),
    /core\.analysis-result\/v1/
  );
});
