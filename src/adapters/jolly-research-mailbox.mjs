import { validateAnalysisResultV1 } from '../core/schema/v1.mjs';

export const JOLLY_MAILBOX_ENTRY_SCHEMA =
  'jolly.research-mailbox-analysis/v1';

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
