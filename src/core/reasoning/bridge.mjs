export const REASONING_TASK_SCHEMA = 'core.reasoning-task/v1';
export const PROPOSED_CLAIM_SET_SCHEMA = 'core.proposed-claim-set/v1';

const HOST_CLAIM_TYPES = new Set([
  'INFERRED',
  'HYPOTHESIS',
  'NEGATIVE',
  'UNKNOWN'
]);

const FORBIDDEN_PROPOSAL_FIELDS = Object.freeze([
  'id',
  'status',
  'verifier_results',
  'verification_records'
]);

export function createReasoningBridge(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new TypeError('ReasoningBridge spec must be an object');
  }
  requireString(spec.id, 'ReasoningBridge id');
  requireString(spec.version, 'ReasoningBridge version');
  if (typeof spec.reason !== 'function') {
    throw new TypeError('ReasoningBridge reason function is required');
  }

  return Object.freeze({
    id: spec.id,
    version: spec.version,

    async reason(task) {
      validateReasoningTask(task);
      const raw = await spec.reason(structuredClone(task));
      return normalizeProposedClaimSet(raw, {
        bridgeId: spec.id,
        bridgeVersion: spec.version
      });
    }
  });
}

export function createStaticReasoningBridge({
  id = 'core-static-reasoning-bridge',
  version = 'v1',
  proposals = []
} = {}) {
  const frozen = structuredClone(proposals);
  return createReasoningBridge({
    id,
    version,
    reason: async () => ({
      schema: PROPOSED_CLAIM_SET_SCHEMA,
      proposals: structuredClone(frozen)
    })
  });
}

export function createReasoningTask({
  analysisId,
  request,
  capsule,
  selectedNodeIds = [],
  existingClaimIds = []
}) {
  requireString(analysisId, 'analysisId');
  const task = {
    schema: REASONING_TASK_SCHEMA,
    analysis_id: analysisId,
    request: structuredClone(request),
    capsule: structuredClone(capsule),
    selected_node_ids: canonicalStrings(selectedNodeIds),
    existing_claim_ids: canonicalStrings(existingClaimIds)
  };
  validateReasoningTask(task);
  return task;
}

export function validateReasoningTask(task) {
  if (!task || typeof task !== 'object' || Array.isArray(task)) {
    throw new TypeError('ReasoningTask must be an object');
  }
  if (task.schema !== REASONING_TASK_SCHEMA) {
    throw new TypeError(REASONING_TASK_SCHEMA + ' is required');
  }
  requireString(task.analysis_id, 'ReasoningTask analysis_id');
  if (!task.request || typeof task.request !== 'object') {
    throw new TypeError('ReasoningTask request is required');
  }
  if (!task.capsule || typeof task.capsule !== 'object') {
    throw new TypeError('ReasoningTask capsule is required');
  }
  if (!Array.isArray(task.selected_node_ids)) {
    throw new TypeError('ReasoningTask selected_node_ids must be an array');
  }
  if (!Array.isArray(task.existing_claim_ids)) {
    throw new TypeError('ReasoningTask existing_claim_ids must be an array');
  }
  return task;
}

export function normalizeProposedClaimSet(value, {
  bridgeId = 'unknown-bridge',
  bridgeVersion = 'unknown'
} = {}) {
  const rawProposals = Array.isArray(value)
    ? value
    : value?.proposals;

  if (!Array.isArray(rawProposals)) {
    throw new TypeError('ReasoningBridge must return a proposals array');
  }
  if (
    value &&
    !Array.isArray(value) &&
    value.schema != null &&
    value.schema !== PROPOSED_CLAIM_SET_SCHEMA
  ) {
    throw new TypeError(PROPOSED_CLAIM_SET_SCHEMA + ' is required');
  }

  const proposals = rawProposals.map((proposal, index) =>
    normalizeProposal(proposal, index)
  );

  return {
    schema: PROPOSED_CLAIM_SET_SCHEMA,
    bridge: {
      id: String(bridgeId),
      version: String(bridgeVersion)
    },
    proposals
  };
}

function normalizeProposal(proposal, index) {
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) {
    throw new TypeError('proposal[' + index + '] must be an object');
  }

  for (const field of FORBIDDEN_PROPOSAL_FIELDS) {
    if (Object.hasOwn(proposal, field)) {
      throw new TypeError(
        'proposal[' + index + '] cannot supply authoritative field ' + field
      );
    }
  }

  const type = String(proposal.type ?? '').toUpperCase();
  if (!HOST_CLAIM_TYPES.has(type)) {
    throw new TypeError(
      'proposal[' + index + '] type must be one of ' +
      [...HOST_CLAIM_TYPES].join(', ')
    );
  }
  if (proposal.subject == null) {
    throw new TypeError('proposal[' + index + '] subject is required');
  }
  requireString(proposal.predicate, 'proposal[' + index + '] predicate');
  if (!Object.hasOwn(proposal, 'object_or_value')) {
    throw new TypeError(
      'proposal[' + index + '] object_or_value is required'
    );
  }
  if (type === 'UNKNOWN') {
    requireString(
      proposal.unresolved_reason,
      'proposal[' + index + '] unresolved_reason'
    );
  }

  return {
    type,
    subject: structuredClone(proposal.subject),
    predicate: proposal.predicate,
    object_or_value: structuredClone(proposal.object_or_value),
    evidence_ids: canonicalStrings(proposal.evidence_ids ?? []),
    counterevidence_ids: canonicalStrings(
      proposal.counterevidence_ids ?? []
    ),
    dependency_claim_ids: canonicalStrings(
      proposal.dependency_claim_ids ?? []
    ),
    provenance_refs: canonicalStrings(proposal.provenance_refs ?? []),
    ...(proposal.confidence ? {
      confidence: structuredClone(proposal.confidence)
    } : {}),
    ...(type === 'UNKNOWN' ? {
      unresolved_reason: String(proposal.unresolved_reason)
    } : {}),
    ...(type === 'NEGATIVE' && proposal.negative_context ? {
      negative_context: structuredClone(proposal.negative_context)
    } : {})
  };
}

function canonicalStrings(values) {
  if (!Array.isArray(values)) throw new TypeError('expected an array');
  return [...new Set(values.map(String))].sort();
}

function requireString(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(name + ' is required');
  }
}
