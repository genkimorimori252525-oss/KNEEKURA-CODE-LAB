export const REASONING_TASK_SCHEMA = 'core.reasoning-task/v1';
export const PROPOSED_CLAIM_SET_SCHEMA = 'core.proposed-claim-set/v1';
export const MAX_REASONING_PROPOSALS = 64;

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
  'verification_records',
  'provenance_refs',
  'negative_context'
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
  if (
    spec.knownEvidenceIds != null &&
    typeof spec.knownEvidenceIds !== 'function'
  ) {
    throw new TypeError(
      'ReasoningBridge knownEvidenceIds must be a function when supplied'
    );
  }

  return Object.freeze({
    id: spec.id,
    version: spec.version,

    async reason(task) {
      validateReasoningTask(task);
      const transmitted = await prepareReasoningTransmission(
        task,
        spec.knownEvidenceIds ?? null
      );
      const raw = await spec.reason(transmitted);
      return normalizeProposedClaimSet(raw, {
        bridgeId: spec.id,
        bridgeVersion: spec.version
      });
    }
  });
}

export async function prepareReasoningTransmission(
  task,
  knownEvidenceIds = null
) {
  validateReasoningTask(task);
  const transmitted = structuredClone(task);
  const evidence = transmitted.capsule.evidence ?? [];
  const fullIds = evidence.map(item => String(item.id)).sort();

  if (!knownEvidenceIds || !fullIds.length) {
    transmitted.transmission = {
      schema: 'core.reasoning-transmission/v1',
      full_evidence_ids: fullIds,
      reused_evidence_ids: [],
      transmitted_evidence_ids: fullIds,
      full_evidence_record_count: fullIds.length,
      transmitted_evidence_record_count: fullIds.length
    };
    return transmitted;
  }

  const returned = await knownEvidenceIds(Object.freeze({
    analysis_id: transmitted.analysis_id,
    snapshot_id: transmitted.capsule.coverage?.snapshot_id ?? null,
    evidence_ids: Object.freeze([...fullIds])
  }));
  if (!Array.isArray(returned)) {
    throw new TypeError(
      'ReasoningBridge knownEvidenceIds must return an array'
    );
  }

  const fullSet = new Set(fullIds);
  const reused = canonicalStrings(returned);
  for (const id of reused) {
    if (!fullSet.has(id)) {
      throw new TypeError(
        'ReasoningBridge knownEvidenceIds returned an unknown Evidence ID: ' +
        id
      );
    }
  }
  const reusedSet = new Set(reused);
  transmitted.capsule.evidence = evidence.filter(
    item => !reusedSet.has(String(item.id))
  );
  transmitted.capsule.source_anchors = (
    transmitted.capsule.source_anchors ?? []
  ).filter(anchor => !reusedSet.has(String(anchor.evidence_id)));
  transmitted.capsule.reused_evidence_ids = reused;
  const transmittedIds = transmitted.capsule.evidence
    .map(item => String(item.id))
    .sort();
  transmitted.transmission = {
    schema: 'core.reasoning-transmission/v1',
    full_evidence_ids: fullIds,
    reused_evidence_ids: reused,
    transmitted_evidence_ids: transmittedIds,
    full_evidence_record_count: fullIds.length,
    transmitted_evidence_record_count: transmittedIds.length
  };
  return transmitted;
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
  if (
    !task.capsule ||
    typeof task.capsule !== 'object' ||
    Array.isArray(task.capsule)
  ) {
    throw new TypeError('ReasoningTask capsule is required');
  }
  if (
    task.capsule.evidence != null &&
    !Array.isArray(task.capsule.evidence)
  ) {
    throw new TypeError(
      'ReasoningTask capsule.evidence must be an array when supplied'
    );
  }
  if (
    task.capsule.source_anchors != null &&
    !Array.isArray(task.capsule.source_anchors)
  ) {
    throw new TypeError(
      'ReasoningTask capsule.source_anchors must be an array when supplied'
    );
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

  const acceptedRaw = rawProposals.slice(0, MAX_REASONING_PROPOSALS);
  const proposals = acceptedRaw.map((proposal, index) =>
    normalizeProposal(proposal, index)
  );

  return {
    schema: PROPOSED_CLAIM_SET_SCHEMA,
    bridge: {
      id: String(bridgeId),
      version: String(bridgeVersion)
    },
    proposals,
    rejected_excess_count:
      Math.max(0, rawProposals.length - MAX_REASONING_PROPOSALS)
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
    ...(proposal.confidence ? {
      confidence: structuredClone(proposal.confidence)
    } : {}),
    ...(type === 'UNKNOWN' ? {
      unresolved_reason: String(proposal.unresolved_reason)
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
