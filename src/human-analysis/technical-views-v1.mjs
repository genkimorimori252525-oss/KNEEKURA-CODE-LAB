import {
  stableDigest,
  validateSourceRef
} from './schema.mjs';
import { assertProductionHumanAnalysisIr } from './production.mjs';
import { HUMAN_ANALYSIS_PRESENTATION_SCHEMA } from './presentation-companion.mjs';

export const HUMAN_ANALYSIS_TECHNICAL_VIEWS_SCHEMA =
  'kneekura.human-analysis-technical-views/v1';

const CONFIRMATIONS = new Set(['CONFIRMED', 'UNCONFIRMED']);
const ARCH_DIRECTIONS = new Set(['FORWARD', 'REVERSE', 'BIDIRECTIONAL', 'UNKNOWN']);
const DATA_DIRECTIONS = new Set(['FORWARD', 'RETURN', 'BIDIRECTIONAL', 'UNKNOWN']);

export function createHumanAnalysisTechnicalViews({ ir, presentation, spec } = {}) {
  assertProductionHumanAnalysisIr(ir);
  assertPresentationIdentity(ir, presentation);
  const normalized = normalizeAll(spec, presentation);
  const core = {
    schema: HUMAN_ANALYSIS_TECHNICAL_VIEWS_SCHEMA,
    repository: structuredClone(ir.repository),
    human_analysis_ir_digest: ir.ir_digest,
    presentation_id: presentation.presentation_id,
    authority: {
      canonical_authority: false,
      may_mint_canonical_nodes: false,
      may_mint_canonical_edges: false,
      may_mint_canonical_claims: false,
      derived_presentation_only: true
    },
    ...normalized
  };
  return deepFreeze({
    ...core,
    view_set_id: 'human-technical-views:' + stableDigest(core).slice('sha256:'.length)
  });
}

export function validateHumanAnalysisTechnicalViews(
  views,
  { ir, presentation } = {}
) {
  if (!views || views.schema !== HUMAN_ANALYSIS_TECHNICAL_VIEWS_SCHEMA) {
    throw new TypeError(`technical views must use ${HUMAN_ANALYSIS_TECHNICAL_VIEWS_SCHEMA}`);
  }
  assertProductionHumanAnalysisIr(ir);
  assertPresentationIdentity(ir, presentation);
  if (
    views.repository?.repository_id !== ir.repository.repository_id ||
    views.repository?.snapshot_id !== ir.repository.snapshot_id ||
    views.human_analysis_ir_digest !== ir.ir_digest ||
    views.presentation_id !== presentation.presentation_id
  ) {
    throw new TypeError('technical views identity mismatch');
  }
  const authority = views.authority ?? {};
  for (const key of [
    'canonical_authority',
    'may_mint_canonical_nodes',
    'may_mint_canonical_edges',
    'may_mint_canonical_claims'
  ]) {
    if (authority[key] !== false) {
      throw new TypeError(`technical views authority must remain false: ${key}`);
    }
  }
  if (authority.derived_presentation_only !== true) {
    throw new TypeError('technical views must remain derived-only');
  }
  const core = structuredClone(views);
  delete core.view_set_id;
  const expected = 'human-technical-views:' + stableDigest(core).slice('sha256:'.length);
  if (views.view_set_id !== expected) {
    throw new TypeError('technical views digest mismatch');
  }
  const normalized = normalizeAll(
    {
      architecture: views.architecture,
      workflow: { flow_id: views.workflow?.flow_id, title: views.workflow?.title },
      sequence: views.sequence,
      data_flow: views.data_flow,
      lifecycle: views.lifecycle
    },
    presentation
  );
  for (const key of ['architecture', 'workflow', 'sequence', 'data_flow', 'lifecycle']) {
    if (stableDigest(normalized[key]) !== stableDigest(views[key])) {
      throw new TypeError(`technical views ${key} structure mismatch`);
    }
  }
  return true;
}

function normalizeAll(spec, presentation) {
  if (!spec || typeof spec !== 'object') {
    throw new TypeError('technical view spec is required');
  }
  const componentById = new Map(
    (presentation.components ?? []).map(component => [component.component_id, component])
  );
  const flowById = new Map(
    (presentation.flows ?? []).map(flow => [flow.flow_id, flow])
  );
  return {
    architecture: normalizeArchitecture(spec.architecture, componentById),
    workflow: normalizeWorkflow(spec.workflow, flowById),
    sequence: normalizeSequence(spec.sequence, flowById),
    data_flow: normalizeDataFlow(spec.data_flow, flowById),
    lifecycle: normalizeLifecycle(spec.lifecycle, flowById)
  };
}

function normalizeArchitecture(input, componentById) {
  const title = requiredText(input?.title, 'architecture.title');
  const componentIds = unique(input?.component_ids ?? []);
  if (!componentIds.length) throw new TypeError('architecture requires component_ids');
  for (const id of componentIds) {
    if (!componentById.has(id)) {
      throw new TypeError(`architecture references foreign component: ${id}`);
    }
  }
  const relations = (input?.relations ?? []).map((relation, index) => {
    const from = requiredText(relation?.from_component_id, `architecture.relations[${index}].from_component_id`);
    const to = requiredText(relation?.to_component_id, `architecture.relations[${index}].to_component_id`);
    if (!componentIds.includes(from) || !componentIds.includes(to)) {
      throw new TypeError(`architecture relation references foreign component: ${from} -> ${to}`);
    }
    const type = requiredText(relation?.type, `architecture.relations[${index}].type`);
    const direction = requiredEnum(relation?.direction, ARCH_DIRECTIONS, `architecture.relations[${index}].direction`);
    const sourceRefs = normalizeRefs(relation?.source_refs ?? []);
    const allowed = [
      ...(componentById.get(from)?.member_refs ?? []),
      ...(componentById.get(to)?.member_refs ?? [])
    ];
    assertRefsSubset(sourceRefs, allowed, `architecture relation ${from} -> ${to}`);
    const confirmation = normalizeConfirmation(
      relation?.confirmation,
      sourceRefs,
      relation?.unconfirmed_reason,
      `architecture relation ${from} -> ${to}`
    );
    if (confirmation.confirmation === 'CONFIRMED' && direction === 'UNKNOWN') {
      throw new TypeError(`confirmed architecture relation cannot use UNKNOWN direction: ${from} -> ${to}`);
    }
    if (confirmation.confirmation === 'UNCONFIRMED' && direction !== 'UNKNOWN') {
      throw new TypeError(`unconfirmed architecture relation must use UNKNOWN direction: ${from} -> ${to}`);
    }
    const core = {
      from_component_id: from,
      to_component_id: to,
      type,
      direction,
      source_refs: sourceRefs,
      ...confirmation
    };
    return { relation_id: stableId('architecture-relation', core), ...core };
  });
  const core = { title, component_ids: componentIds, relations };
  return { view_id: stableId('architecture-view', core), ...core };
}

function normalizeWorkflow(input, flowById) {
  const flowId = requiredText(input?.flow_id, 'workflow.flow_id');
  const flow = flowById.get(flowId);
  if (!flow) throw new TypeError(`workflow references foreign flow: ${flowId}`);
  const title = requiredText(input?.title ?? flow.name, 'workflow.title');
  const transitions = (flow.transitions ?? []).map(transition => ({
    ...structuredClone(transition),
    confirmation: transition.kind === 'UNKNOWN' ? 'UNCONFIRMED' : 'CONFIRMED',
    ...(transition.kind === 'UNKNOWN'
      ? { unconfirmed_reason: 'FLOW_TRANSITION_KIND_UNKNOWN' }
      : {})
  }));
  const core = {
    flow_id: flowId,
    title,
    entry_step_id: flow.entry_step_id,
    steps: structuredClone(flow.steps ?? []),
    transitions
  };
  return { view_id: stableId('workflow-view', core), ...core };
}

function normalizeSequence(input, flowById) {
  const flowId = requiredText(input?.flow_id, 'sequence.flow_id');
  const flow = flowById.get(flowId);
  if (!flow) throw new TypeError(`sequence references foreign flow: ${flowId}`);
  const title = requiredText(input?.title, 'sequence.title');
  const stepIds = new Set((flow.steps ?? []).map(step => step.step_id));
  const seenOrders = new Set();
  const messages = (input?.messages ?? []).map((message, index) => {
    const from = requireStep(message?.from_step_id, stepIds, `sequence.messages[${index}].from_step_id`);
    const to = requireStep(message?.to_step_id, stepIds, `sequence.messages[${index}].to_step_id`);
    const sourceRefs = normalizeRefs(message?.source_refs ?? []);
    assertRefsSubset(sourceRefs, flowSourceRefs(flow), `sequence message ${from} -> ${to}`);
    const confirmation = normalizeConfirmation(
      message?.confirmation,
      sourceRefs,
      message?.unconfirmed_reason,
      `sequence message ${from} -> ${to}`
    );
    let order = null;
    if (confirmation.confirmation === 'CONFIRMED') {
      order = Number(message?.order);
      if (!Number.isInteger(order) || order < 0) {
        throw new TypeError(`confirmed sequence message requires non-negative order: ${from} -> ${to}`);
      }
      if (seenOrders.has(order)) throw new TypeError(`duplicate confirmed sequence order: ${order}`);
      seenOrders.add(order);
    } else if (message?.order != null) {
      throw new TypeError(`unconfirmed sequence message must not claim order: ${from} -> ${to}`);
    }
    const core = {
      from_step_id: from,
      to_step_id: to,
      label: requiredText(message?.label, `sequence.messages[${index}].label`),
      order,
      source_refs: sourceRefs,
      ...confirmation
    };
    return { message_id: stableId('sequence-message', core), ...core };
  }).sort((a, b) => {
    if (a.order == null && b.order == null) return compareText(a.message_id, b.message_id);
    if (a.order == null) return 1;
    if (b.order == null) return -1;
    return a.order - b.order;
  });
  const core = { flow_id: flowId, title, messages };
  return { view_id: stableId('sequence-view', core), ...core };
}

function normalizeDataFlow(input, flowById) {
  const flowId = requiredText(input?.flow_id, 'data_flow.flow_id');
  const flow = flowById.get(flowId);
  if (!flow) throw new TypeError(`data_flow references foreign flow: ${flowId}`);
  const title = requiredText(input?.title, 'data_flow.title');
  const stepIds = new Set((flow.steps ?? []).map(step => step.step_id));
  const transfers = (input?.transfers ?? []).map((transfer, index) => {
    const from = requireStep(transfer?.from_step_id, stepIds, `data_flow.transfers[${index}].from_step_id`);
    const to = requireStep(transfer?.to_step_id, stepIds, `data_flow.transfers[${index}].to_step_id`);
    const direction = requiredEnum(transfer?.direction, DATA_DIRECTIONS, `data_flow.transfers[${index}].direction`);
    const sourceRefs = normalizeRefs(transfer?.source_refs ?? []);
    assertRefsSubset(sourceRefs, flowSourceRefs(flow), `data flow ${from} -> ${to}`);
    const confirmation = normalizeConfirmation(
      transfer?.confirmation,
      sourceRefs,
      transfer?.unconfirmed_reason,
      `data flow ${from} -> ${to}`
    );
    if (confirmation.confirmation === 'CONFIRMED' && direction === 'UNKNOWN') {
      throw new TypeError(`confirmed data flow cannot use UNKNOWN direction: ${from} -> ${to}`);
    }
    const core = {
      from_step_id: from,
      to_step_id: to,
      label: requiredText(transfer?.label, `data_flow.transfers[${index}].label`),
      direction,
      source_refs: sourceRefs,
      ...confirmation
    };
    return { transfer_id: stableId('data-transfer', core), ...core };
  });
  const core = { flow_id: flowId, title, transfers };
  return { view_id: stableId('data-flow-view', core), ...core };
}

function normalizeLifecycle(input, flowById) {
  const flowId = requiredText(input?.flow_id, 'lifecycle.flow_id');
  const flow = flowById.get(flowId);
  if (!flow) throw new TypeError(`lifecycle references foreign flow: ${flowId}`);
  const title = requiredText(input?.title, 'lifecycle.title');
  const allowedRefs = flowSourceRefs(flow);
  const stateIds = new Set();
  const states = (input?.states ?? []).map((state, index) => {
    const stateId = requiredText(state?.state_id, `lifecycle.states[${index}].state_id`);
    if (stateIds.has(stateId)) throw new TypeError(`duplicate lifecycle state: ${stateId}`);
    stateIds.add(stateId);
    const sourceRefs = normalizeRefs(state?.source_refs ?? []);
    if (!sourceRefs.length) throw new TypeError(`lifecycle state requires source_refs: ${stateId}`);
    assertRefsSubset(sourceRefs, allowedRefs, `lifecycle state ${stateId}`);
    return {
      state_id: stateId,
      label: requiredText(state?.label, `lifecycle.states[${index}].label`),
      source_refs: sourceRefs
    };
  });
  if (!states.length) throw new TypeError('lifecycle requires states');
  const transitions = (input?.transitions ?? []).map((transition, index) => {
    const from = requiredText(transition?.from_state_id, `lifecycle.transitions[${index}].from_state_id`);
    const to = requiredText(transition?.to_state_id, `lifecycle.transitions[${index}].to_state_id`);
    if (!stateIds.has(from) || !stateIds.has(to)) {
      throw new TypeError(`lifecycle transition references foreign state: ${from} -> ${to}`);
    }
    const sourceRefs = normalizeRefs(transition?.source_refs ?? []);
    assertRefsSubset(sourceRefs, allowedRefs, `lifecycle transition ${from} -> ${to}`);
    const confirmation = normalizeConfirmation(
      transition?.confirmation,
      sourceRefs,
      transition?.unconfirmed_reason,
      `lifecycle transition ${from} -> ${to}`
    );
    const core = {
      from_state_id: from,
      to_state_id: to,
      label: requiredText(transition?.label, `lifecycle.transitions[${index}].label`),
      source_refs: sourceRefs,
      ...confirmation
    };
    return { transition_id: stableId('lifecycle-transition', core), ...core };
  });
  const core = { flow_id: flowId, title, states, transitions };
  return { view_id: stableId('lifecycle-view', core), ...core };
}

function assertPresentationIdentity(ir, presentation) {
  if (!presentation || presentation.schema !== HUMAN_ANALYSIS_PRESENTATION_SCHEMA) {
    throw new TypeError('technical views require Human Analysis Presentation v1');
  }
  if (
    presentation.repository?.repository_id !== ir.repository.repository_id ||
    presentation.repository?.snapshot_id !== ir.repository.snapshot_id ||
    presentation.human_analysis_ir_digest !== ir.ir_digest
  ) {
    throw new TypeError('technical views presentation identity mismatch');
  }
}

function normalizeConfirmation(value, sourceRefs, reason, label) {
  const confirmation = requiredEnum(value, CONFIRMATIONS, `${label}.confirmation`);
  if (confirmation === 'CONFIRMED') {
    if (!sourceRefs.length) throw new TypeError(`${label} CONFIRMED requires source_refs`);
    if (reason != null && String(reason).trim()) {
      throw new TypeError(`${label} CONFIRMED must not carry unconfirmed_reason`);
    }
    return { confirmation };
  }
  return {
    confirmation,
    unconfirmed_reason: requiredText(reason, `${label}.unconfirmed_reason`)
  };
}

function flowSourceRefs(flow) {
  const refs = [];
  for (const step of flow.steps ?? []) refs.push(...(step.source_refs ?? []));
  for (const transition of flow.transitions ?? []) refs.push(...(transition.source_refs ?? []));
  return refs;
}

function requireStep(value, stepIds, label) {
  const stepId = requiredText(value, label);
  if (!stepIds.has(stepId)) throw new TypeError(`${label} references foreign flow step: ${stepId}`);
  return stepId;
}

function normalizeRefs(refs) {
  if (!Array.isArray(refs)) throw new TypeError('source_refs must be an array');
  const map = new Map();
  for (const ref of refs) {
    validateSourceRef(ref);
    const normalized = structuredClone(ref);
    map.set(sourceKey(normalized), normalized);
  }
  return [...map.values()].sort((a, b) => compareText(sourceKey(a), sourceKey(b)));
}

function assertRefsSubset(refs, allowedRefs, label) {
  const allowed = new Set((allowedRefs ?? []).map(sourceKey));
  for (const ref of refs) {
    if (!allowed.has(sourceKey(ref))) {
      throw new TypeError(`${label} source ref is outside its typed presentation evidence`);
    }
  }
}

function sourceKey(ref) {
  return String(ref.kind).toUpperCase() === 'FILE_RANGE'
    ? ['FILE_RANGE', ref.path, ref.start_line, ref.end_line, ref.content_digest ?? ''].join(':')
    : `${String(ref.kind).toUpperCase()}:${String(ref.id)}`;
}

function stableId(prefix, value) {
  return `${prefix}:${stableDigest(value).slice('sha256:'.length)}`;
}

function requiredText(value, label) {
  const text = String(value ?? '').trim();
  if (!text) throw new TypeError(`${label} is required`);
  return text;
}

function requiredEnum(value, allowed, label) {
  const normalized = String(value ?? '').toUpperCase();
  if (!allowed.has(normalized)) throw new TypeError(`${label} is invalid: ${String(value)}`);
  return normalized;
}

function unique(values) {
  return [...new Set((values ?? []).map(value => String(value)))].sort(compareText);
}

function compareText(a, b) {
  const left = String(a);
  const right = String(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}