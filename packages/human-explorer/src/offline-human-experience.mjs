export const HUMAN_EXPERIENCE_OFFLINE_PAYLOAD_SCHEMA =
  'kneekura.human-experience-offline-payload/v1';

const HUMAN_EXPERIENCE_PROJECTION_SCHEMA =
  'kneekura.human-experience-projection/v1';
const HUMAN_ANALYSIS_IR_SCHEMA =
  'kneekura.human-analysis-ir/v1';
const HUMAN_SOURCE_BUNDLE_SCHEMA =
  'kneekura.human-analysis-source-bundle/v1';

const SEMANTIC_CLASS_ORDER = new Map([
  ['AI_INTERPRETATION', 0],
  ['UNKNOWN', 1],
  ['COVERAGE_GAP', 2]
]);

const SOURCE_KIND_LABELS = Object.freeze({
  EVIDENCE: '根拠記録',
  CLAIM: '主張記録',
  COVERAGE: '解析範囲記録',
  UNKNOWN: '未解決記録',
  NODE: 'コード要素',
  EDGE: '関係記録'
});

export function createOfflineHumanExperienceView(payload) {
  if (payload == null) {
    return deepFreeze({
      available: false,
      locale: 'ja-JP',
      repository: null,
      items: [],
      hidden_review_item_count: 0,
      counts: {
        accepted: 0,
        ai_interpretations: 0,
        unknowns: 0,
        coverage_gaps: 0
      }
    });
  }
  if (
    !payload ||
    payload.schema !== HUMAN_EXPERIENCE_OFFLINE_PAYLOAD_SCHEMA
  ) {
    throw new TypeError(
      'Human Explorer offline payload schema is invalid'
    );
  }

  const experience = payload.experience;
  const sourceBundle = payload.sources;
  if (
    experience?.schema !== HUMAN_EXPERIENCE_PROJECTION_SCHEMA
  ) {
    throw new TypeError(
      'Human Explorer offline Human Experience projection is invalid'
    );
  }
  if (sourceBundle?.schema !== HUMAN_SOURCE_BUNDLE_SCHEMA) {
    throw new TypeError(
      'Human Explorer offline source bundle is invalid'
    );
  }
  const ir = experience.derived?.human_analysis_ir;
  if (ir?.schema !== HUMAN_ANALYSIS_IR_SCHEMA) {
    throw new TypeError(
      'Human Explorer offline Human Analysis IR is invalid'
    );
  }

  assertRepositoryIdentity(experience, ir, sourceBundle);
  assertIrIdentity(ir, sourceBundle, experience);
  const recordsByKey = indexSourceRecords(sourceBundle.records ?? []);

  const acceptedItems = (ir.items ?? [])
    .filter(item => item.review_status === 'ACCEPT')
    .map(item => presentItem(item, recordsByKey))
    .sort(comparePresentedItem);
  const hiddenReviewItemCount = (ir.items ?? []).length - acceptedItems.length;

  return deepFreeze({
    available: true,
    locale: String(experience.locale ?? 'ja-JP'),
    repository: structuredClone(experience.repository),
    items: acceptedItems,
    hidden_review_item_count: hiddenReviewItemCount,
    counts: {
      accepted: acceptedItems.length,
      ai_interpretations: acceptedItems.filter(
        item => item.semantic_class === 'AI_INTERPRETATION'
      ).length,
      unknowns: acceptedItems.filter(
        item => item.semantic_class === 'UNKNOWN'
      ).length,
      coverage_gaps: acceptedItems.filter(
        item => item.semantic_class === 'COVERAGE_GAP'
      ).length
    }
  });
}

export function semanticClassLabel(value) {
  switch (String(value ?? '')) {
    case 'AI_INTERPRETATION':
      return 'AIによる解釈';
    case 'UNKNOWN':
      return '未解決';
    case 'COVERAGE_GAP':
      return '解析範囲の不足';
    default:
      return String(value ?? '不明');
  }
}

export function sourceKindLabel(value) {
  return SOURCE_KIND_LABELS[String(value ?? '').toUpperCase()] ??
    '根拠記録';
}

function assertRepositoryIdentity(experience, ir, sourceBundle) {
  const repositoryIds = [
    ['Human Experience', experience.repository?.repository_id],
    ['Human Analysis IR', ir.repository?.repository_id],
    ['Source bundle', sourceBundle.repository?.repository_id]
  ];
  const snapshotIds = [
    ['Human Experience', experience.repository?.snapshot_id],
    ['Human Analysis IR', ir.repository?.snapshot_id],
    ['Source bundle', sourceBundle.repository?.snapshot_id]
  ];
  assertSameRequired('repository', repositoryIds);
  assertSameRequired('snapshot', snapshotIds);
}

function assertIrIdentity(ir, sourceBundle, experience) {
  assertSameRequired('Human Analysis IR digest', [
    ['Human Analysis IR', ir.ir_digest],
    ['Source bundle', sourceBundle.ir_digest],
    [
      'Human Experience',
      experience.source_identity?.human_analysis_ir_digest
    ]
  ]);
  assertSameRequired('Evidence Pack ID', [
    ['Human Analysis IR', ir.evidence_pack?.pack_id],
    ['Source bundle', sourceBundle.evidence_pack?.pack_id],
    ['Human Experience', experience.source_identity?.evidence_pack_id]
  ]);
  assertSameRequired('Evidence Pack digest', [
    ['Human Analysis IR', ir.evidence_pack?.pack_digest],
    ['Source bundle', sourceBundle.evidence_pack?.pack_digest],
    [
      'Human Experience',
      experience.source_identity?.evidence_pack_digest
    ]
  ]);
}

function assertSameRequired(kind, entries) {
  const missing = entries
    .filter(([, value]) =>
      typeof value !== 'string' || value.trim().length === 0
    )
    .map(([label]) => label);
  if (missing.length > 0) {
    throw new TypeError(
      `Human Explorer offline ${kind} identity missing: ${missing.join(', ')}`
    );
  }
  if (new Set(entries.map(([, value]) => value)).size !== 1) {
    throw new TypeError(
      `Human Explorer offline ${kind} identity mismatch`
    );
  }
}

function indexSourceRecords(records) {
  const byKey = new Map();
  for (const record of records) {
    const key = sourceKey(record?.ref);
    if (byKey.has(key)) {
      throw new TypeError(
        `Human Explorer offline source ref is duplicated: ${key}`
      );
    }
    byKey.set(key, record);
  }
  return byKey;
}

function presentItem(item, recordsByKey) {
  const sources = (item.source_refs ?? []).map(ref =>
    presentSource(ref, recordsByKey.get(sourceKey(ref)))
  );
  return {
    id: String(item.id),
    stage: String(item.stage ?? ''),
    kind: String(item.kind ?? ''),
    semantic_class: String(item.semantic_class ?? ''),
    semantic_label: semanticClassLabel(item.semantic_class),
    title: String(item.title ?? ''),
    body: String(item.body ?? ''),
    review_status: String(item.review_status ?? ''),
    review_reason: item.review_reason == null
      ? null
      : String(item.review_reason),
    origin: item.origin == null ? null : structuredClone(item.origin),
    ordering_key: String(item.ordering_key ?? ''),
    source_refs: structuredClone(item.source_refs ?? []),
    sources
  };
}

function presentSource(ref, record) {
  const normalizedKind = String(ref?.kind ?? '').toUpperCase();
  if (normalizedKind === 'FILE_RANGE') {
    const label = formatFileRange(ref);
    if (!record) {
      return {
        key: sourceKey(ref),
        kind: normalizedKind,
        label,
        availability: 'UNAVAILABLE',
        reason: 'この成果物には該当するソース本文が同梱されていません。',
        path: String(ref.path ?? ''),
        start_line: Number(ref.start_line),
        end_line: Number(ref.end_line),
        rows: [],
        technical_ref: structuredClone(ref)
      };
    }
    if (
      record.ref?.content_digest !== ref.content_digest ||
      record.content_digest !== ref.content_digest
    ) {
      throw new TypeError(
        `Human Explorer offline source digest mismatch: ${label}`
      );
    }
    if (typeof record.text !== 'string') {
      throw new TypeError(
        `Human Explorer offline source text is missing: ${label}`
      );
    }
    const lines = record.text.split('\n');
    const expectedLineCount = ref.end_line - ref.start_line + 1;
    if (lines.length !== expectedLineCount) {
      throw new TypeError(
        `Human Explorer offline source line count mismatch: ${label}`
      );
    }
    return {
      key: sourceKey(ref),
      kind: normalizedKind,
      label,
      availability: 'AVAILABLE',
      reason: null,
      path: String(ref.path),
      start_line: ref.start_line,
      end_line: ref.end_line,
      rows: lines.map((text, index) => ({
        line: ref.start_line + index,
        text
      })),
      technical_ref: structuredClone(ref),
      technical_record: {
        trust_class: record.trust_class ?? null,
        text_digest: record.text_digest ?? null,
        content_digest: record.content_digest ?? null
      }
    };
  }

  const label = sourceKindLabel(normalizedKind);
  if (!record) {
    return {
      key: sourceKey(ref),
      kind: normalizedKind,
      label,
      availability: 'UNAVAILABLE',
      reason: '参照IDは保持されていますが、この成果物には記録本文が同梱されていません。',
      rows: [],
      technical_ref: structuredClone(ref)
    };
  }
  return {
    key: sourceKey(ref),
    kind: normalizedKind,
    label,
    availability: 'CANONICAL_RECORD',
    reason: null,
    rows: [],
    technical_ref: structuredClone(ref),
    technical_record: structuredClone(record.record ?? null)
  };
}

function formatFileRange(ref) {
  const path = String(ref?.path ?? '');
  const start = Number(ref?.start_line);
  const end = Number(ref?.end_line);
  if (start === end) return `${path}:${start}`;
  return `${path}:${start}–${end}`;
}

function sourceKey(ref) {
  const kind = String(ref?.kind ?? '').toUpperCase();
  if (kind === 'FILE_RANGE') {
    return [
      kind,
      String(ref.path ?? ''),
      Number(ref.start_line),
      Number(ref.end_line),
      String(ref.content_digest ?? '')
    ].join(':');
  }
  return `${kind}:${String(ref?.id ?? '')}`;
}

function comparePresentedItem(a, b) {
  return (
    (SEMANTIC_CLASS_ORDER.get(a.semantic_class) ?? 99) -
      (SEMANTIC_CLASS_ORDER.get(b.semantic_class) ?? 99) ||
    compareText(a.ordering_key, b.ordering_key) ||
    compareText(a.id, b.id)
  );
}

function compareText(a, b) {
  const left = String(a);
  const right = String(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}