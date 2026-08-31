import crypto from 'node:crypto';

export const HUMAN_ANALYSIS_IR_SCHEMA = 'kneekura.human-analysis-ir/v1';
export const EVIDENCE_PACK_SCHEMA = 'kneekura.human-analysis-evidence-pack/v1';
export const SEMANTIC_CLASSES = Object.freeze([
  'AI_INTERPRETATION',
  'UNKNOWN',
  'COVERAGE_GAP'
]);
export const SEMANTIC_STAGES = Object.freeze([
  'ARCHITECTURE',
  'DOMAIN',
  'FLOW',
  'TOUR',
  'REVIEWER'
]);

const CLASS_SET = new Set(SEMANTIC_CLASSES);
const STAGE_SET = new Set(SEMANTIC_STAGES);
const ITEM_KINDS = new Set([
  'ARCHITECTURE_COMPONENT',
  'DOMAIN_CONCEPT',
  'FLOW',
  'TOUR_STEP',
  'REVIEW_FINDING'
]);
const STAGE_KIND = Object.freeze({
  ARCHITECTURE: 'ARCHITECTURE_COMPONENT',
  DOMAIN: 'DOMAIN_CONCEPT',
  FLOW: 'FLOW',
  TOUR: 'TOUR_STEP',
  REVIEWER: 'REVIEW_FINDING'
});
const SOURCE_REF_KINDS = new Set([
  'EVIDENCE', 'CLAIM', 'COVERAGE', 'UNKNOWN',
  'NODE', 'EDGE', 'FILE_RANGE'
]);

export function stableDigest(value) {
  return 'sha256:' + crypto.createHash('sha256')
    .update(stableStringify(value))
    .digest('hex');
}

export function stableDerivedItemId(item) {
  const identity = {
    stage: item.stage,
    kind: item.kind,
    semantic_class: item.semantic_class,
    title: item.title,
    body: item.body,
    source_refs: canonicalSourceRefs(item.source_refs ?? []),
    ordering_key: item.ordering_key ?? null
  };
  return 'hai:sha256:' + crypto.createHash('sha256')
    .update(stableStringify(identity))
    .digest('hex');
}

export function validateSourceRef(ref) {
  if (!ref || typeof ref !== 'object') throw new TypeError('source ref must be an object');
  const kind = String(ref.kind ?? '').toUpperCase();
  if (!SOURCE_REF_KINDS.has(kind)) throw new TypeError(`unsupported source ref kind: ${kind}`);
  if (kind === 'FILE_RANGE') {
    if (typeof ref.path !== 'string' || !ref.path) throw new TypeError('FILE_RANGE source ref requires path');
    if (!Number.isInteger(ref.start_line) || ref.start_line < 1) throw new TypeError('FILE_RANGE start_line must be 1-based');
    if (!Number.isInteger(ref.end_line) || ref.end_line < ref.start_line) throw new TypeError('FILE_RANGE end_line is invalid');
    if (ref.content_digest != null && !String(ref.content_digest).startsWith('sha256:')) throw new TypeError('FILE_RANGE content_digest must be sha256');
  } else if (typeof ref.id !== 'string' || !ref.id) {
    throw new TypeError(`${kind} source ref requires id`);
  }
  return true;
}

export function normalizeDerivedItem(raw, { stage }) {
  if (!STAGE_SET.has(stage)) throw new TypeError(`unsupported semantic stage: ${stage}`);
  if (!raw || typeof raw !== 'object') throw new TypeError('derived item must be an object');
  const semanticClass = String(raw.semantic_class ?? '').toUpperCase();
  if (semanticClass === 'CANONICAL_FACT') {
    throw new TypeError('AI semantic stages must not author CANONICAL_FACT');
  }
  if (!CLASS_SET.has(semanticClass)) throw new TypeError(`unsupported derived semantic class: ${semanticClass}`);
  const kind = String(raw.kind ?? '').toUpperCase();
  if (!ITEM_KINDS.has(kind)) throw new TypeError(`unsupported derived item kind: ${kind}`);
  if (STAGE_KIND[stage] !== kind) throw new TypeError(`${stage} stage may emit only ${STAGE_KIND[stage]}`);
  const title = String(raw.title ?? '').trim();
  const body = String(raw.body ?? '').trim();
  if (!title || !body) throw new TypeError('derived item title/body are required');
  const sourceRefs = canonicalSourceRefs(raw.source_refs ?? []);
  if (sourceRefs.some(ref => ref.kind === 'FILE_RANGE' && !ref.content_digest)) {
    throw new TypeError('derived FILE_RANGE source refs require content_digest');
  }
  if (sourceRefs.length === 0) {
    throw new TypeError(`${semanticClass} requires at least one source ref`);
  }
  if (semanticClass === 'COVERAGE_GAP' && !sourceRefs.some(ref => ref.kind === 'COVERAGE' || ref.kind === 'FILE_RANGE')) {
    throw new TypeError('COVERAGE_GAP requires a coverage or file-range source ref');
  }
  const item = {
    schema: 'kneekura.human-analysis-derived-item/v1',
    stage,
    kind,
    semantic_class: semanticClass,
    origin: 'AI_SEMANTIC_AUTHOR',
    authority_level: 'AI_INTERPRETATION_ONLY',
    title,
    body,
    source_refs: sourceRefs,
    confidence: normalizeConfidence(raw.confidence),
    ordering_key: raw.ordering_key == null ? null : String(raw.ordering_key),
    metadata: raw.metadata && typeof raw.metadata === 'object' ? structuredClone(raw.metadata) : {}
  };
  item.id = stableDerivedItemId(item);
  return item;
}

export function validateHumanAnalysisIr(ir) {
  if (!ir || ir.schema !== HUMAN_ANALYSIS_IR_SCHEMA) throw new TypeError(`IR must use ${HUMAN_ANALYSIS_IR_SCHEMA}`);
  if (!ir.repository?.repository_id || !ir.repository?.snapshot_id) throw new TypeError('IR repository identity is required');
  if (!Array.isArray(ir.stages) || !Array.isArray(ir.items)) throw new TypeError('IR stages/items must be arrays');
  const ids = new Set();
  for (const item of ir.items) {
    if (!CLASS_SET.has(item.semantic_class)) throw new TypeError('IR contains non-derived semantic class');
    if (ids.has(item.id)) throw new TypeError(`duplicate derived item id: ${item.id}`);
    ids.add(item.id);
    if (stableDerivedItemId(item) !== item.id) throw new TypeError(`derived item id mismatch: ${item.id}`);
    for (const ref of item.source_refs ?? []) validateSourceRef(ref);
  }
  if (!ir.invariants || ir.invariants.canonical_mutated !== false || ir.invariants.ai_can_author_canonical_fact !== false) {
    throw new TypeError('IR invariant markers are invalid');
  }
  const digest = ir.ir_digest;
  if (typeof digest !== 'string' || !digest.startsWith('sha256:')) throw new TypeError('IR digest is required');
  const withoutDigest = structuredClone(ir);
  delete withoutDigest.ir_digest;
  if (stableDigest(withoutDigest) !== digest) throw new TypeError('IR digest mismatch');
  return true;
}

function normalizeConfidence(value) {
  if (value == null) return { level: 'UNSPECIFIED', rationale: null };
  if (typeof value === 'string') return { level: value.toUpperCase(), rationale: null };
  return {
    level: String(value.level ?? 'UNSPECIFIED').toUpperCase(),
    rationale: value.rationale == null ? null : String(value.rationale)
  };
}

function canonicalSourceRefs(refs) {
  if (!Array.isArray(refs)) throw new TypeError('source_refs must be an array');
  const normalized = refs.map(ref => {
    validateSourceRef(ref);
    const kind = String(ref.kind).toUpperCase();
    if (kind === 'FILE_RANGE') {
      return {
        kind,
        path: String(ref.path).replaceAll('\\', '/'),
        start_line: Number(ref.start_line),
        end_line: Number(ref.end_line),
        ...(ref.content_digest ? { content_digest: String(ref.content_digest) } : {})
      };
    }
    return { kind, id: String(ref.id) };
  });
  const seen = new Set();
  return normalized.filter(ref => {
    const key = stableStringify(ref);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => stableStringify(a).localeCompare(stableStringify(b)));
}

function stableStringify(value) {
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}
