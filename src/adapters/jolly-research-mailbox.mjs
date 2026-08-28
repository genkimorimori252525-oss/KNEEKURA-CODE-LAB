import { validateAnalysisResultV1 } from '../core/schema/v1.mjs';

export const JOLLY_MAILBOX_ENTRY_SCHEMA =
  'jolly.research-mailbox-analysis/v1';

export const JOLLY_MAILBOX_SERVICE_RESULT_SCHEMA =
  'jolly.research-mailbox-service-result/v1';

export const JOLLY_MAILBOX_SERVICE = 'kneekura-code-lab';

export const JOLLY_MAILBOX_ANALYSIS_MODES = Object.freeze([
  'architecture',
  'bug_hunt',
  'integration',
  'data_flow',
  'control_flow',
  'performance',
  'regression',
  'dead_code',
  'compare',
  'general_review'
]);

const VERIFIED_STATUSES = new Set([
  'VERIFIED',
  'VERIFIED_WITH_LIMITS'
]);

export function toJollyResearchMailbox(result, {
  profile = 'compact'
} = {}) {
  validateAnalysisResultV1(result);
  if (!['compact','standard'].includes(profile)) {
    throw new TypeError('mailbox profile must be compact or standard');
  }

  const claims = (result.claims ?? []).map(claim => ({
    id: claim.id,
    status: claim.status,
    type: claim.type,
    predicate: claim.predicate,
    value: structuredClone(claim.object_or_value),
    evidence_ids: claim.evidence_links.map(link => link.evidence_id),
    counterevidence_ids:
      claim.counterevidence_links.map(link => link.evidence_id),
    ...(profile === 'standard' ? {
      subject: structuredClone(claim.subject),
      confidence: structuredClone(claim.confidence)
    } : {})
  }));

  return {
    schema: JOLLY_MAILBOX_ENTRY_SCHEMA,
    source_schema: result.schema,
    analysis_id: result.analysis_id,
    session_id: result.session_id,
    run_status: result.status,
    snapshot_id: result.snapshot.snapshot_id,
    coverage: {
      completeness: result.coverage.completeness,
      fingerprint: result.coverage.fingerprint ?? null
    },
    claims,
    unknowns: structuredClone(result.unknowns ?? []),
    warnings: structuredClone(result.warnings ?? []),
    failures: structuredClone(result.failures ?? []),
    recommended_validation: structuredClone(
      result.recommended_validation ?? []
    )
  };
}

export function toJollyResearchMailboxServiceResult(result, {
  jobId,
  sourceRepository,
  sourceRef,
  sourceCommit,
  analysisMode
} = {}) {
  validateAnalysisResultV1(result);
  requireString(jobId, 'jobId');
  requireString(sourceRepository, 'sourceRepository');
  requireString(sourceRef, 'sourceRef');
  requireCommit(sourceCommit, 'sourceCommit');
  if (!JOLLY_MAILBOX_ANALYSIS_MODES.includes(analysisMode)) {
    throw new TypeError(
      'analysisMode must be one of ' +
      JOLLY_MAILBOX_ANALYSIS_MODES.join(', ')
    );
  }

  const snapshotCommit = result.snapshot.base_commit ?? null;
  if (
    snapshotCommit != null &&
    snapshotCommit.toLowerCase() !== sourceCommit.toLowerCase()
  ) {
    throw new Error(
      'sourceCommit does not match AnalysisResult snapshot base_commit'
    );
  }
  const normalizedSourceRepository =
    normalizeAndAssertSourceRepository(
      result.repository,
      sourceRepository
    );

  const claims = (result.claims ?? []).map(projectClaim);
  const verifiedClaims = claims.filter(claim =>
    VERIFIED_STATUSES.has(claim.status)
  );
  const limitedClaims = verifiedClaims.filter(claim =>
    claim.status === 'VERIFIED_WITH_LIMITS'
  );

  const evidenceProjection = projectEvidence(result);
  const sourcePinExact = result.snapshot.kind === 'COMMIT';
  const mappedStatus = sourcePinExact
    ? mapServiceStatus(result.status)
    : 'needs_context';
  const status = serviceStatusForProjection({
    mappedStatus,
    analysisMode,
    verifiedClaims
  });

  const remainingUncertainty = [
    ...(result.unknowns ?? []).map(item => ({
      kind: 'CORE_UNKNOWN',
      value: structuredClone(item)
    })),
    ...limitedClaims.map(claim => ({
      kind: 'VERIFIED_WITH_LIMITS',
      claim_id: claim.id,
      predicate: claim.predicate
    })),
    ...evidenceProjection.missing_refs.map(evidenceId => ({
      kind: 'EVIDENCE_RECORD_UNAVAILABLE',
      evidence_id: evidenceId
    }))
  ];

  if (!sourcePinExact) {
    remainingUncertainty.unshift({
      kind: 'SOURCE_PIN',
      reason:
        'AnalysisResult snapshot kind is ' +
        result.snapshot.kind +
        '; the mailbox service requires a commit-pinned analysis before ' +
        'completed/partial status can be asserted.',
      snapshot_id: result.snapshot.snapshot_id,
      base_commit: snapshotCommit
    });
  }

  for (const warning of result.warnings ?? []) {
    remainingUncertainty.push({
      kind: 'CORE_WARNING',
      value: structuredClone(warning)
    });
  }

  for (const failure of result.failures ?? []) {
    remainingUncertainty.push({
      kind: 'CORE_FAILURE',
      value: structuredClone(failure)
    });
  }

  const researchQuestions = (result.unknowns ?? [])
    .filter(item =>
      item?.reason_code === 'EXTERNAL_RESEARCH_REQUIRED'
    )
    .map(item => ({
      question:
        String(item.reason ?? 'External guarantee requires research'),
      reason:
        'CORE marked this repository question as requiring external research'
    }));

  const confidence = aggregateConfidence({
    result,
    status,
    verifiedClaims,
    limitedClaims,
    remainingUncertainty
  });

  return {
    schema: JOLLY_MAILBOX_SERVICE_RESULT_SCHEMA,
    service: JOLLY_MAILBOX_SERVICE,
    id: jobId,
    status,
    source_repository: normalizedSourceRepository,
    source_ref: sourceRef,
    source_commit: sourceCommit,
    source_snapshot_id: result.snapshot.snapshot_id,
    source_snapshot_kind: result.snapshot.kind,
    analysis_mode: analysisMode,
    canonical: {
      source_schema: result.schema,
      analysis_id: result.analysis_id,
      session_id: result.session_id,
      repository_id: result.repository.repository_id,
      snapshot_id: result.snapshot.snapshot_id,
      coverage: {
        completeness: result.coverage.completeness,
        fingerprint: result.coverage.fingerprint ?? null
      }
    },
    bottom_line: bottomLine({
      result,
      status,
      analysisMode,
      verifiedClaims,
      limitedClaims
    }),
    root_cause: {
      established: false,
      claim_ids: [],
      reason:
        'CORE v1 does not assign a root-cause role to arbitrary Claims; ' +
        'the consumer adapter does not invent one.'
    },
    evidence: evidenceProjection.rows,
    affected_components: (result.affected_symbols ?? [])
      .map(item => structuredClone(item)),
    recommended_changes: [],
    do_not_change: [],
    rejected_hypotheses:
      projectRejectedHypotheses(result),
    verification_plan:
      structuredClone(result.recommended_validation ?? []),
    research_required: {
      required: researchQuestions.length > 0,
      questions: researchQuestions
    },
    confidence,
    remaining_uncertainty: remainingUncertainty,
    projection_limits: {
      root_cause_inference: false,
      source_change_recommendation_inference: false,
      do_not_change_inference: false,
      repository_text_is_instruction_authority: false
    }
  };
}

function projectClaim(claim) {
  return {
    id: claim.id,
    status: claim.status,
    type: claim.type,
    predicate: claim.predicate,
    subject: structuredClone(claim.subject),
    value: structuredClone(claim.object_or_value),
    evidence_ids: claim.evidence_links.map(link => link.evidence_id),
    counterevidence_ids:
      claim.counterevidence_links.map(link => link.evidence_id),
    confidence: structuredClone(claim.confidence)
  };
}

function projectEvidence(result) {
  const records = new Map(
    (result.evidence ?? []).map(record => [record.id, record])
  );
  const uses = new Map();

  for (const claim of result.claims ?? []) {
    for (const link of claim.evidence_links ?? []) {
      addEvidenceUse(uses, link.evidence_id, {
        claim_id: claim.id,
        role: link.role,
        strength: link.strength,
        channel: 'support'
      });
    }
    for (const link of claim.counterevidence_links ?? []) {
      addEvidenceUse(uses, link.evidence_id, {
        claim_id: claim.id,
        role: link.role,
        strength: link.strength,
        channel: 'counterevidence'
      });
    }
  }

  const ids = canonicalStrings([
    ...(result.evidence_refs ?? []),
    ...(result.counterevidence_refs ?? []),
    ...uses.keys()
  ]);
  const missingRefs = [];
  const rows = ids.map(evidenceId => {
    const record = records.get(evidenceId);
    if (!record) {
      missingRefs.push(evidenceId);
      return {
        evidence_id: evidenceId,
        record_available: false,
        relevance: structuredClone(uses.get(evidenceId) ?? [])
      };
    }

    const range = record.provenance?.range ?? null;
    return {
      evidence_id: evidenceId,
      record_available: true,
      kind: record.kind,
      trust_class: record.trust_class,
      provider_id: record.provider_id,
      provider_version: record.provider_version,
      file:
        stringOrNull(record.provenance?.path) ??
        stringOrNull(record.observation?.source_path),
      symbol:
        stringOrNull(record.provenance?.symbol) ??
        stringOrNull(record.observation?.symbol),
      lines: range
        ? {
            start: range.start_line,
            end: range.end_line
          }
        : null,
      finding: structuredClone(record.observation),
      relevance: structuredClone(uses.get(evidenceId) ?? [])
    };
  });

  return {
    rows,
    missing_refs: missingRefs
  };
}

function addEvidenceUse(uses, evidenceId, use) {
  if (!uses.has(evidenceId)) uses.set(evidenceId, []);
  uses.get(evidenceId).push(use);
}

function projectRejectedHypotheses(result) {
  const byId = new Map(
    (result.claims ?? []).map(claim => [claim.id, claim])
  );
  const rows = [];

  for (const item of result.negated_hypotheses ?? []) {
    if (item?.claim_id && byId.has(item.claim_id)) {
      const claim = byId.get(item.claim_id);
      if (claim.status !== 'REJECTED') continue;
      rows.push({
        kind: 'CLAIM',
        claim: projectClaim(claim)
      });
      continue;
    }

    if (
      item?.status !== 'REJECTED' &&
      item?.kind !== 'REASONING_PROPOSAL'
    ) {
      continue;
    }

    rows.push({
      kind: item?.kind ?? 'REJECTED_HYPOTHESIS',
      value: structuredClone(item)
    });
  }

  return rows;
}

function bottomLine({
  result,
  status,
  analysisMode,
  verifiedClaims,
  limitedClaims
}) {
  const claimText =
    verifiedClaims.length === 1
      ? '1 canonical Claim is verified'
      : verifiedClaims.length +
        ' canonical Claims are verified';
  const limitsText =
    limitedClaims.length > 0
      ? '; ' + limitedClaims.length +
        ' of them are VERIFIED_WITH_LIMITS'
      : '';

  if (status === 'needs_context') {
    return (
      'CORE produced repository evidence, but the analysis snapshot is not ' +
      'commit-pinned for the Mailbox service. ' +
      claimText + limitsText +
      '; coverage is ' + result.coverage.completeness + '.'
    );
  }

  if (status === 'failed') {
    return (
      'CORE could not produce a reliable completed analysis. ' +
      claimText + limitsText +
      '; coverage is ' + result.coverage.completeness + '.'
    );
  }

  if (analysisMode === 'bug_hunt' && status === 'partial') {
    return (
      claimText + limitsText +
      '; coverage is ' + result.coverage.completeness +
      '. No canonical Claim is assigned the root-cause role, so this ' +
      'bug_hunt remains partial rather than fabricating a causal conclusion.'
    );
  }

  return (
    claimText + limitsText +
    '; coverage is ' + result.coverage.completeness +
    '. No narrative root cause or source change was synthesized by the ' +
    'consumer adapter.'
  );
}

function aggregateConfidence({
  result,
  status,
  verifiedClaims,
  limitedClaims,
  remainingUncertainty
}) {
  let level = 'low';

  if (
    status === 'completed' &&
    result.coverage.completeness === 'COMPLETE' &&
    verifiedClaims.length > 0 &&
    limitedClaims.length === 0 &&
    remainingUncertainty.length === 0
  ) {
    level = 'high';
  } else if (
    ['completed','partial'].includes(status) &&
    verifiedClaims.length > 0 &&
    !['PARTIAL','UNKNOWN'].includes(
      result.coverage.completeness
    )
  ) {
    level = 'medium';
  }

  return {
    level,
    basis: [
      {
        kind: 'coverage',
        completeness: result.coverage.completeness
      },
      {
        kind: 'verified_claims',
        claim_ids: verifiedClaims.map(claim => claim.id)
      }
    ],
    missing: remainingUncertainty.length === 0
      ? []
      : [{
          kind: 'remaining_uncertainty',
          count: remainingUncertainty.length,
          location: 'remaining_uncertainty',
          reason:
            'Detailed uncertainty is preserved once in the remaining_uncertainty field.'
        }]
  };
}

function serviceStatusForProjection({
  mappedStatus,
  analysisMode,
  verifiedClaims
}) {
  if (mappedStatus !== 'completed') return mappedStatus;
  if (verifiedClaims.length === 0) return 'partial';
  if (analysisMode === 'bug_hunt') return 'partial';
  return 'completed';
}

function normalizeAndAssertSourceRepository(
  repository,
  sourceRepository
) {
  const raw = sourceRepository.trim();
  const canonical = repository?.canonical_identity;
  if (
    typeof canonical !== 'string' ||
    !canonical.startsWith('git:github.com/')
  ) {
    return raw;
  }

  const value = raw.replace(/\.git$/i, '');
  if (!/^[^/\s]+\/[^/\s]+$/.test(value)) {
    throw new TypeError(
      'sourceRepository must be owner/repository for a GitHub-backed AnalysisResult'
    );
  }

  const canonicalPath = canonical.slice(
    'git:github.com/'.length
  );
  if (canonicalPath.toLowerCase() !== value.toLowerCase()) {
    throw new Error(
      'sourceRepository does not match AnalysisResult repository identity'
    );
  }

  return canonicalPath;
}

function mapServiceStatus(status) {
  if (status === 'COMPLETE') return 'completed';
  if (status === 'PARTIAL') return 'partial';
  if (status === 'FAILED') return 'failed';
  return 'needs_context';
}

function canonicalStrings(values) {
  return [...new Set(
    values
      .filter(value => typeof value === 'string' && value)
  )].sort();
}

function stringOrNull(value) {
  return typeof value === 'string' && value.trim()
    ? value
    : null;
}

function requireString(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(name + ' is required');
  }
}

function requireCommit(value, name) {
  if (
    typeof value !== 'string' ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value)
  ) {
    throw new TypeError(
      name + ' must be a full SHA-1 or SHA-256 commit id'
    );
  }
}
