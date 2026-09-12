import { composeSealedAllModeBundle } from '../skill/sealed-outcome-composer.mjs';
import { validateRelayPlan } from './contracts.mjs';
import { verifyChildCompositionInput } from './child-result-manifest.mjs';

export function composeVerifiedAllChildResults({ parentPlan, childInputs } = {}) {
  const plan = validateRelayPlan(parentPlan);
  if (plan.selection !== 'all' || plan.semantic_context_mode !== 'per-engine') {
    throw isolationError('parent composition requires an ALL plan with per-engine semantic contexts');
  }
  if (!Array.isArray(childInputs) || childInputs.length !== 3) {
    throw bindingError('parent composition requires exactly three child inputs');
  }

  const verified = childInputs.map(input => verifyChildCompositionInput({
    ...input,
    parentPlan: plan
  }));
  const outcomes = verified.map(row => ({
    engine_id: row.manifest.engine_id,
    attempt_id: row.receipt.attemptId,
    semantic_context_id: row.manifest.host_context_id,
    receipt: row.receipt,
    sealed_bytes: row.sealed_bytes,
    sealed_artifact: row.sealed_artifact
  }));
  const contextMetadata = verified.map(row => ({
    engine_id: row.manifest.engine_id,
    host_context_id: row.manifest.host_context_id,
    assurance_class: row.manifest.assurance_class,
    child_issue_number: row.manifest.child_issue_number
  }));

  return composeSealedAllModeBundle({
    runId: plan.run_id,
    snapshotId: plan.target.snapshot_id,
    scopeDigest: plan.target.scope_digest,
    outcomes,
    contextMetadata
  });
}

function bindingError(message) {
  const error = new Error(message);
  error.code = 'ALL_CHILD_RESULT_BINDING_MISMATCH';
  return error;
}

function isolationError(message) {
  const error = new Error(message);
  error.code = 'BLOCKED_SEMANTIC_CONTEXT_ISOLATION';
  return error;
}