import {
  createClaimRecord
} from '../ledger/claims.mjs';

export const SAFE_DERIVATION_RULES = Object.freeze({
  CLIENT_COMMAND_CONSUMED: Object.freeze({
    rule_id: 'core.derive.ysm-client-command-consumed',
    rule_version: 'v1'
  })
});

export function deriveClientCommandConsumed(dependencyClaim, {
  coverageRef = dependencyClaim?.coverage_ref,
  provenanceRefs = dependencyClaim?.provenance_refs ?? []
} = {}) {
  if (!dependencyClaim || typeof dependencyClaim !== 'object') {
    throw new TypeError('dependencyClaim is required');
  }
  if (!['VERIFIED','VERIFIED_WITH_LIMITS'].includes(dependencyClaim.status)) {
    throw new TypeError('client-command-consumed derivation requires a verified dependency claim');
  }
  if (
    dependencyClaim.predicate !== 'ysm.client_command_handled' ||
    dependencyClaim.object_or_value !== true
  ) {
    throw new TypeError('client-command-consumed derivation requires ysm.client_command_handled=true');
  }

  return createClaimRecord({
    type: 'DERIVED',
    subject: structuredClone(dependencyClaim.subject),
    predicate: 'ysm.client_command_consumed',
    objectOrValue: true,
    dependencyClaimIds: [dependencyClaim.id],
    coverageRef,
    provenanceRefs,
    derivation: SAFE_DERIVATION_RULES.CLIENT_COMMAND_CONSUMED,
    confidence: {
      level: dependencyClaim.status === 'VERIFIED' ? 'HIGH' : 'MEDIUM',
      rationale: 'deterministic derivation from verified Forge client-command handled=true'
    }
  });
}

export function deriveMolangStateAppliedFromConsumed() {
  throw new TypeError(
    'unsafe derivation: M5 command consumption cannot establish M6 YSM Molang runtime state application'
  );
}
