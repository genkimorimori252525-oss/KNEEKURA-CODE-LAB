import {
  stableDigest,
  validateHumanAnalysisIr,
  validateSourceRef
} from './schema.mjs';
import { assertProductionHumanAnalysisIr } from './production.mjs';
import {
  HUMAN_ANALYSIS_READ_RECEIPT_SCHEMA,
  validateHumanAnalysisReadReceipt
} from './author-read-trace.mjs';

export const HUMAN_ANALYSIS_PRESENTATION_SCHEMA =
  'kneekura.human-analysis-presentation/v1';
export const HUMAN_ANALYSIS_PRESENTATION_READINESS_SCHEMA =
  'kneekura.human-analysis-presentation-readiness/v1';

const FLOW_TRANSITION_KINDS = new Set([
  'CALL',
  'GUARD',
  'DATA',
  'EXTERNAL_WRITE',
  'RETURN',
  'UNKNOWN'
]);

/**
 * Build a typed, digest-protected companion around an existing PRODUCTION IR.
 * It is presentation-only: it references accepted AI items and canonical/source
 * refs, but never creates CORE nodes, edges, Claims or Coverage records.
 */
export function createHumanAnalysisPresentationCompanion({
  ir,
  evidencePack,
  sources = [],
  readReceipts = [],
  scope,
  overview_item_id,
  components = [],
  flows = [],
  tour = []
} = {}) {
  assertProductionHumanAnalysisIr(ir);
  assertEvidencePackIdentity(ir, evidencePack);

  const accepted = acceptedItemMap(ir);
  const normalizedScope = normalizeScope(scope);
  const normalizedReceipts = normalizeReadReceipts(
    readReceipts,
    ir,
    evidencePack
  );
  const sourceRecords = sourceRecordMap(sources);

  const overview = requireAcceptedItem(
    accepted,
    overview_item_id,
    'ARCHITECTURE_COMPONENT',
    'overview'
  );
  assertInterpretation(overview, 'overview');

  const normalizedComponents = components.map((component, index) =>
    normalizeComponent(component, index, accepted)
  );
  if (normalizedComponents.length === 0) {
    throw new TypeError('presentation requires at least one component');
  }

  const normalizedFlows = flows.map((flow, index) =>
    normalizeFlow(flow, index, accepted)
  );
  if (normalizedFlows.length === 0) {
    throw new TypeError('presentation requires at least one flow');
  }

  const normalizedTour = tour
    .map((step, index) => normalizeTourStep(step, index, accepted))
    .sort((a, b) => a.order - b.order || compareText(a.item_id, b.item_id));
  if (normalizedTour.length === 0) {
    throw new TypeError('presentation requires at least one tour step');
  }

  const presentationItemIds = unique([
    overview.id,
    ...normalizedComponents.map(item => item.item_id),
    ...normalizedFlows.map(item => item.item_id),
    ...normalizedTour.map(item => item.item_id)
  ]);
  const sourceAvailability = buildSourceAvailability(
    presentationItemIds.map(id => accepted.get(id)),
    sourceRecords
  );
  const readiness = buildReadiness({
    ir,
    presentationItemIds,
    accepted,
    sourceAvailability,
    receipts: normalizedReceipts
  });

  const core = {
    schema: HUMAN_ANALYSIS_PRESENTATION_SCHEMA,
    repository: structuredClone(ir.repository),
    human_analysis_ir_digest: ir.ir_digest,
    evidence_pack: {
      pack_id: evidencePack.pack_id,
      canonical_digest: evidencePack.canonical_digest,
      pack_digest: evidencePack.pack_digest
    },
    authority: {
      canonical_authority: false,
      may_mint_canonical_nodes: false,
      may_mint_canonical_edges: false,
      may_mint_canonical_claims: false,
      derived_presentation_only: true
    },
    scope: normalizedScope,
    overview_item_id: overview.id,
    components: normalizedComponents,
    flows: normalizedFlows,
    tour: normalizedTour,
    source_availability: sourceAvailability,
    read_receipts: normalizedReceipts,
    readiness
  };
  const presentationId =
    'human-presentation:' + stableDigest(core).slice('sha256:'.length);
  const result = deepFreeze({
    ...core,
    presentation_id: presentationId
  });
  validateHumanAnalysisPresentationCompanion(result, {
    ir,
    evidencePack,
    sources
  });
  return result;
}

export function validateHumanAnalysisPresentationCompanion(
  presentation,
  { ir, evidencePack, sources = [] } = {}
) {
  if (
    !presentation ||
    presentation.schema !== HUMAN_ANALYSIS_PRESENTATION_SCHEMA
  ) {
    throw new TypeError(
      `presentation must use ${HUMAN_ANALYSIS_PRESENTATION_SCHEMA}`
    );
  }
  validateHumanAnalysisIr(ir);
  assertProductionHumanAnalysisIr(ir);
  assertEvidencePackIdentity(ir, evidencePack);
  if (
    presentation.repository?.repository_id !== ir.repository.repository_id ||
    presentation.repository?.snapshot_id !== ir.repository.snapshot_id ||
    presentation.human_analysis_ir_digest !== ir.ir_digest ||
    presentation.evidence_pack?.pack_id !== evidencePack.pack_id ||
    presentation.evidence_pack?.canonical_digest !== evidencePack.canonical_digest ||
    presentation.evidence_pack?.pack_digest !== evidencePack.pack_digest
  ) {
    throw new TypeError('presentation identity mismatch');
  }
  const authority = presentation.authority ?? {};
  for (const key of [
    'canonical_authority',
    'may_mint_canonical_nodes',
    'may_mint_canonical_edges',
    'may_mint_canonical_claims'
  ]) {
    if (authority[key] !== false) {
      throw new TypeError(`presentation authority must remain false: ${key}`);
    }
  }
  if (authority.derived_presentation_only !== true) {
    throw new TypeError('presentation must remain derived-only');
  }

  // Reconstruct through the same typed constructor inputs except digest ID.
  const clone = structuredClone(presentation);
  delete clone.presentation_id;
  const expected =
    'human-presentation:' + stableDigest(clone).slice('sha256:'.length);
  if (presentation.presentation_id !== expected) {
    throw new TypeError('presentation digest mismatch');
  }

  const sourceRecords = sourceRecordMap(sources);
  for (const availability of presentation.source_availability ?? []) {
    validateSourceRef(availability.ref);
    const current = classifyAvailability(availability.ref, sourceRecords);
    if (
      current.availability !== availability.availability ||
      current.reason !== availability.reason
    ) {
      throw new TypeError('presentation source availability drift');
    }
  }
  for (const receipt of presentation.read_receipts ?? []) {
    validateHumanAnalysisReadReceipt(receipt);
    assertReceiptIdentity(receipt, ir, evidencePack);
    assertReceiptAgainstEvidencePack(receipt, evidencePack);
  }
  if (
    presentation.readiness?.schema !==
      HUMAN_ANALYSIS_PRESENTATION_READINESS_SCHEMA
  ) {
    throw new TypeError('presentation readiness schema is invalid');
  }
  return true;
}

function normalizeScope(scope) {
  if (!scope || scope.kind !== 'BOUNDED_PREVIEW') {
    throw new TypeError('R1 presentation scope must be BOUNDED_PREVIEW');
  }
  const label = String(scope.label ?? '').trim();
  if (!label) throw new TypeError('presentation scope label is required');
  const declaredPaths = unique(
    (scope.declared_paths ?? []).map(normalizePath)
  ).sort(compareText);
  if (declaredPaths.length === 0) {
    throw new TypeError('bounded presentation scope requires declared_paths');
  }
  return {
    kind: 'BOUNDED_PREVIEW',
    label,
    declared_paths: declaredPaths,
    repository_scale_claim: false
  };
}

function normalizeComponent(component, index, accepted) {
  const item = requireAcceptedItem(
    accepted,
    component?.item_id,
    'ARCHITECTURE_COMPONENT',
    `components[${index}]`
  );
  assertInterpretation(item, `components[${index}]`);
  const name = requiredText(component?.name, `components[${index}].name`);
  const responsibility = requiredText(
    component?.responsibility,
    `components[${index}].responsibility`
  );
  const memberRefs = normalizeRefs(
    component?.member_refs ?? item.source_refs,
    `${index}.member_refs`
  );
  assertRefsSubset(memberRefs, item.source_refs, `components[${index}]`);
  const core = {
    item_id: item.id,
    name,
    responsibility,
    member_refs: memberRefs
  };
  return {
    ...core,
    component_id:
      'component:' + stableDigest(core).slice('sha256:'.length)
  };
}

function normalizeFlow(flow, index, accepted) {
  const item = requireAcceptedItem(
    accepted,
    flow?.item_id,
    'FLOW',
    `flows[${index}]`
  );
  assertInterpretation(item, `flows[${index}]`);
  const name = requiredText(flow?.name, `flows[${index}].name`);
  if (!Array.isArray(flow?.steps) || flow.steps.length === 0) {
    throw new TypeError(`flows[${index}] requires steps`);
  }
  const stepIds = new Set();
  const steps = flow.steps.map((step, stepIndex) => {
    const stepId = requiredText(
      step?.step_id,
      `flows[${index}].steps[${stepIndex}].step_id`
    );
    if (stepIds.has(stepId)) {
      throw new TypeError(`duplicate flow step id: ${stepId}`);
    }
    stepIds.add(stepId);
    const sourceRefs = normalizeRefs(
      step?.source_refs ?? [],
      `flows[${index}].steps[${stepIndex}].source_refs`
    );
    if (sourceRefs.length === 0) {
      throw new TypeError(`flow step requires source refs: ${stepId}`);
    }
    assertRefsSubset(sourceRefs, item.source_refs, `flow step ${stepId}`);
    return {
      step_id: stepId,
      label: requiredText(
        step?.label,
        `flows[${index}].steps[${stepIndex}].label`
      ),
      source_refs: sourceRefs
    };
  });
  const entryStepId = requiredText(
    flow.entry_step_id,
    `flows[${index}].entry_step_id`
  );
  if (!stepIds.has(entryStepId)) {
    throw new TypeError(`flow entry step is foreign: ${entryStepId}`);
  }
  const transitions = (flow.transitions ?? []).map((transition, transitionIndex) => {
    const from = requiredText(
      transition?.from_step_id,
      `flows[${index}].transitions[${transitionIndex}].from_step_id`
    );
    const to = requiredText(
      transition?.to_step_id,
      `flows[${index}].transitions[${transitionIndex}].to_step_id`
    );
    if (!stepIds.has(from) || !stepIds.has(to)) {
      throw new TypeError(`flow transition references foreign step: ${from} -> ${to}`);
    }
    const kind = String(transition?.kind ?? '').toUpperCase();
    if (!FLOW_TRANSITION_KINDS.has(kind)) {
      throw new TypeError(`unsupported flow transition kind: ${kind}`);
    }
    const sourceRefs = normalizeRefs(
      transition?.source_refs ?? [],
      `flows[${index}].transitions[${transitionIndex}].source_refs`
    );
    if (sourceRefs.length === 0) {
      throw new TypeError(`flow transition requires source refs: ${from} -> ${to}`);
    }
    assertRefsSubset(sourceRefs, item.source_refs, `flow transition ${from} -> ${to}`);
    return {
      from_step_id: from,
      to_step_id: to,
      kind,
      source_refs: sourceRefs
    };
  });
  const core = {
    item_id: item.id,
    name,
    entry_step_id: entryStepId,
    steps,
    transitions
  };
  return {
    ...core,
    flow_id: 'flow:' + stableDigest(core).slice('sha256:'.length)
  };
}

function normalizeTourStep(step, index, accepted) {
  const item = requireAcceptedItem(
    accepted,
    step?.item_id,
    'TOUR_STEP',
    `tour[${index}]`
  );
  assertInterpretation(item, `tour[${index}]`);
  const order = Number(step?.order);
  if (!Number.isInteger(order) || order < 0) {
    throw new TypeError(`tour[${index}].order must be a non-negative integer`);
  }
  const targetRefs = normalizeRefs(
    step?.target_refs ?? item.source_refs,
    `tour[${index}].target_refs`
  );
  assertRefsSubset(targetRefs, item.source_refs, `tour[${index}]`);
  return {
    item_id: item.id,
    order,
    target_refs: targetRefs
  };
}

function buildSourceAvailability(items, sourceRecords) {
  const refs = new Map();
  for (const item of items) {
    for (const ref of item.source_refs ?? []) {
      const normalized = normalizeRef(ref);
      refs.set(sourceKey(normalized), normalized);
    }
  }
  return [...refs.values()]
    .sort((a, b) => compareText(sourceKey(a), sourceKey(b)))
    .map(ref => ({
      key: sourceKey(ref),
      ref,
      ...classifyAvailability(ref, sourceRecords)
    }));
}

function classifyAvailability(ref, sourceRecords) {
  const record = sourceRecords.get(sourceKey(ref));
  if (!record) {
    return {
      availability: 'UNAVAILABLE',
      reason: 'SOURCE_NOT_MATERIALIZED'
    };
  }
  if (ref.kind === 'FILE_RANGE') {
    if (
      typeof record.text !== 'string' ||
      record.content_digest !== ref.content_digest
    ) {
      return {
        availability: 'UNAVAILABLE',
        reason: 'FILE_RANGE_CONTENT_MISMATCH'
      };
    }
    return {
      availability: 'FILE_RANGE',
      reason: null
    };
  }
  if (!record.record || typeof record.record !== 'object') {
    return {
      availability: 'UNAVAILABLE',
      reason: 'CANONICAL_RECORD_NOT_MATERIALIZED'
    };
  }
  return {
    availability: 'CANONICAL_RECORD',
    reason: null
  };
}

function buildReadiness({
  ir,
  presentationItemIds,
  accepted,
  sourceAvailability,
  receipts
}) {
  const gaps = [];
  if (sourceAvailability.some(item => item.availability === 'UNAVAILABLE')) {
    gaps.push('PRESENTATION_SOURCE_UNAVAILABLE');
  }
  const receiptKeysByStage = new Set(
    receipts.map(receipt => [
      receipt.stage,
      sourceKey(receipt.source_ref)
    ].join('|'))
  );
  for (const itemId of presentationItemIds) {
    const item = accepted.get(itemId);
    if (!item) {
      gaps.push(`PRESENTATION_ITEM_NOT_ACCEPTED:${itemId}`);
      continue;
    }
    if (item.semantic_class !== 'AI_INTERPRETATION') {
      gaps.push(`PRESENTATION_ITEM_NOT_INTERPRETATION:${itemId}`);
      continue;
    }
    const authorRead = (item.source_refs ?? []).some(ref =>
      receiptKeysByStage.has([item.stage, sourceKey(normalizeRef(ref))].join('|'))
    );
    if (!authorRead) {
      gaps.push(`PRESENTATION_ITEM_NOT_AI_READ:${itemId}`);
    }
  }
  if (!receipts.some(receipt => receipt.read_kind === 'FILE_RANGE')) {
    gaps.push('NO_DIRECT_AI_SOURCE_READ');
  }
  const uniqueGaps = unique(gaps).sort(compareText);
  return {
    schema: HUMAN_ANALYSIS_PRESENTATION_READINESS_SCHEMA,
    status: uniqueGaps.length ? 'NOT_READY' : 'READY_BOUNDED_PREVIEW',
    bounded_preview_ready: uniqueGaps.length === 0,
    repository_scale_ready: false,
    repository_scale_reason: 'R1_BOUNDED_PREVIEW_ONLY',
    presentation_item_count: presentationItemIds.length,
    accepted_item_count: ir.review?.accepted_item_ids?.length ?? 0,
    ai_read_receipt_count: receipts.length,
    direct_file_read_receipt_count:
      receipts.filter(item => item.read_kind === 'FILE_RANGE').length,
    gaps: uniqueGaps
  };
}

function normalizeReadReceipts(receipts, ir, evidencePack) {
  if (!Array.isArray(receipts)) {
    throw new TypeError('readReceipts must be an array');
  }
  const seen = new Set();
  return receipts
    .map(receipt => {
      validateHumanAnalysisReadReceipt(receipt);
      assertReceiptIdentity(receipt, ir, evidencePack);
      assertReceiptAgainstEvidencePack(receipt, evidencePack);
      if (seen.has(receipt.receipt_id)) {
        throw new TypeError(`duplicate read receipt: ${receipt.receipt_id}`);
      }
      seen.add(receipt.receipt_id);
      return structuredClone(receipt);
    })
    .sort((a, b) => compareText(a.receipt_id, b.receipt_id));
}

function assertReceiptIdentity(receipt, ir, evidencePack) {
  if (
    receipt.repository.repository_id !== ir.repository.repository_id ||
    receipt.repository.snapshot_id !== ir.repository.snapshot_id ||
    receipt.evidence_pack_id !== evidencePack.pack_id
  ) {
    throw new TypeError('read receipt repository/snapshot/evidence-pack mismatch');
  }
}

function assertReceiptAgainstEvidencePack(receipt, evidencePack) {
  const ref = receipt.source_ref;
  if (ref.kind === 'FILE_RANGE') {
    const catalog = evidencePack.source_catalog.find(item => item.path === ref.path);
    if (
      !catalog ||
      catalog.content_digest !== ref.content_digest ||
      (Number.isInteger(catalog.line_count) && ref.end_line > catalog.line_count)
    ) {
      throw new TypeError(`read receipt FILE_RANGE is outside Evidence Pack: ${ref.path}`);
    }
    if (receipt.content_digest !== catalog.content_digest) {
      throw new TypeError(`read receipt FILE_RANGE digest drift: ${ref.path}`);
    }
    return;
  }
  const record = findCanonicalRecord(evidencePack, ref);
  if (!record || stableDigest(record) !== receipt.record_digest) {
    throw new TypeError(`read receipt canonical record drift: ${sourceKey(ref)}`);
  }
}

function findCanonicalRecord(evidencePack, ref) {
  const id = ref.id;
  switch (ref.kind) {
    case 'EVIDENCE':
      return evidencePack.canonical?.evidence?.find(item => item?.id === id) ?? null;
    case 'CLAIM':
      return evidencePack.canonical?.result?.claims?.find(item => item?.id === id) ?? null;
    case 'COVERAGE':
      return evidencePack.canonical?.result?.coverage?.entries?.find(item => item?.id === id) ?? null;
    case 'UNKNOWN':
      return evidencePack.canonical?.result?.unknowns?.find(
        item => item?.id === id || item?.ref === id
      ) ?? null;
    case 'NODE':
      return evidencePack.canonical?.graph?.nodes?.find(item => item?.id === id) ?? null;
    case 'EDGE':
      return evidencePack.canonical?.graph?.edges?.find(item => item?.id === id) ?? null;
    default:
      return null;
  }
}

function acceptedItemMap(ir) {
  const acceptedIds = new Set(ir.review?.accepted_item_ids ?? []);
  const map = new Map();
  for (const item of ir.items ?? []) {
    if (acceptedIds.has(item.id) && item.review_status === 'ACCEPT') {
      map.set(item.id, item);
    }
  }
  return map;
}

function requireAcceptedItem(accepted, itemId, expectedKind, label) {
  const id = String(itemId ?? '');
  const item = accepted.get(id);
  if (!item) throw new TypeError(`${label} must reference an ACCEPTed item`);
  if (item.kind !== expectedKind) {
    throw new TypeError(`${label} must reference ${expectedKind}`);
  }
  return item;
}

function assertInterpretation(item, label) {
  if (item.semantic_class !== 'AI_INTERPRETATION') {
    throw new TypeError(`${label} must remain AI_INTERPRETATION`);
  }
}

function assertEvidencePackIdentity(ir, evidencePack) {
  if (
    !evidencePack ||
    evidencePack.repository?.repository_id !== ir.repository.repository_id ||
    evidencePack.repository?.snapshot_id !== ir.repository.snapshot_id ||
    evidencePack.pack_id !== ir.evidence_pack?.pack_id ||
    evidencePack.canonical_digest !== ir.evidence_pack?.canonical_digest ||
    evidencePack.pack_digest !== ir.evidence_pack?.pack_digest
  ) {
    throw new TypeError('presentation Evidence Pack identity mismatch');
  }
}

function sourceRecordMap(sources) {
  if (!Array.isArray(sources)) throw new TypeError('sources must be an array');
  const map = new Map();
  for (const source of sources) {
    if (!source?.ref) throw new TypeError('source record ref is required');
    const ref = normalizeRef(source.ref);
    const key = sourceKey(ref);
    if (map.has(key)) throw new TypeError(`duplicate source record: ${key}`);
    map.set(key, source);
  }
  return map;
}

function normalizeRefs(refs, label) {
  if (!Array.isArray(refs)) throw new TypeError(`${label} must be an array`);
  const map = new Map();
  for (const ref of refs) {
    const normalized = normalizeRef(ref);
    map.set(sourceKey(normalized), normalized);
  }
  return [...map.values()].sort((a, b) =>
    compareText(sourceKey(a), sourceKey(b))
  );
}

function normalizeRef(ref) {
  validateSourceRef(ref);
  const kind = String(ref.kind).toUpperCase();
  if (kind === 'FILE_RANGE') {
    return {
      kind,
      path: normalizePath(ref.path),
      start_line: Number(ref.start_line),
      end_line: Number(ref.end_line),
      ...(ref.content_digest
        ? { content_digest: String(ref.content_digest) }
        : {})
    };
  }
  return { kind, id: String(ref.id) };
}

function assertRefsSubset(refs, allowedRefs, label) {
  const allowed = new Set(
    (allowedRefs ?? []).map(ref => sourceKey(normalizeRef(ref)))
  );
  for (const ref of refs) {
    if (!allowed.has(sourceKey(ref))) {
      throw new TypeError(`${label} source ref is not present on its Human Analysis item`);
    }
  }
}

function sourceKey(ref) {
  return ref.kind === 'FILE_RANGE'
    ? [
        'FILE_RANGE',
        ref.path,
        ref.start_line,
        ref.end_line,
        ref.content_digest ?? ''
      ].join(':')
    : `${ref.kind}:${ref.id}`;
}

function requiredText(value, label) {
  const text = String(value ?? '').trim();
  if (!text) throw new TypeError(`${label} is required`);
  return text;
}

function normalizePath(value) {
  const text = String(value ?? '').replaceAll('\\', '/').replace(/^\.\//, '');
  if (
    !text ||
    text.startsWith('/') ||
    /^[A-Za-z]:\//.test(text) ||
    text.split('/').includes('..')
  ) {
    throw new TypeError(`unsafe repository path: ${value}`);
  }
  return text;
}

function unique(values) {
  return [...new Set(values)];
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