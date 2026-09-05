export const HUMAN_EXPERIENCE_OFFLINE_PAYLOAD_SCHEMA =
  'kneekura.human-experience-offline-payload/v1';
export const HUMAN_EXPERIENCE_PROJECTION_SCHEMA =
  'kneekura.human-experience-projection/v1';
export const HUMAN_SOURCE_BUNDLE_SCHEMA =
  'kneekura.human-analysis-source-bundle/v1';

export function createOfflineExperienceViewModel(payload) {
  if (!payload) {
    return Object.freeze({
      available: false,
      locale: 'ja-JP',
      explanations: [],
      uncertainties: [],
      rejected_count: 0,
      unreviewed_count: 0,
      technical: null
    });
  }
  if (payload.schema !== HUMAN_EXPERIENCE_OFFLINE_PAYLOAD_SCHEMA) {
    throw new TypeError('未対応の Human Experience offline payload です');
  }
  const experience = payload.experience;
  const sources = payload.sources;
  if (experience?.schema !== HUMAN_EXPERIENCE_PROJECTION_SCHEMA) {
    throw new TypeError('Human Experience projection がありません');
  }
  if (sources?.schema !== HUMAN_SOURCE_BUNDLE_SCHEMA) {
    throw new TypeError('Human Analysis source bundle がありません');
  }

  assertPayloadIdentity(experience, sources);
  const ir = experience.derived?.human_analysis_ir;
  if (!ir || !Array.isArray(ir.items)) {
    throw new TypeError('Human Analysis IR items がありません');
  }
  const records = Array.isArray(sources.records) ? sources.records : [];
  const recordByKey = new Map();
  for (const record of records) {
    const key = sourceKey(record?.ref);
    if (recordByKey.has(key)) {
      throw new TypeError(`source bundle に重複参照があります: ${key}`);
    }
    recordByKey.set(key, record);
  }

  const reviewed = ir.items.filter(item => item.review_status === 'ACCEPT');
  const explanations = reviewed
    .filter(item => item.semantic_class === 'AI_INTERPRETATION')
    .map(item => createGuideItem(item, recordByKey));
  const uncertainties = reviewed
    .filter(item =>
      item.semantic_class === 'UNKNOWN' ||
      item.semantic_class === 'COVERAGE_GAP'
    )
    .map(item => createGuideItem(item, recordByKey));

  return deepFreeze({
    available: true,
    locale: experience.locale || 'ja-JP',
    explanations,
    uncertainties,
    rejected_count: ir.items.filter(item => item.review_status === 'REJECT').length,
    unreviewed_count: ir.items.filter(item =>
      item.review_status !== 'ACCEPT' && item.review_status !== 'REJECT'
    ).length,
    technical: {
      repository_id: experience.repository?.repository_id ?? null,
      snapshot_id: experience.repository?.snapshot_id ?? null,
      projection_id: experience.projection_id ?? null,
      ir_digest: ir.ir_digest ?? null,
      evidence_pack_id: experience.source_identity?.evidence_pack_id ?? null,
      evidence_pack_digest: experience.source_identity?.evidence_pack_digest ?? null,
      canonical_digest: experience.source_identity?.canonical_digest ?? null
    }
  });
}

function createGuideItem(item, recordByKey) {
  return {
    id: item.id,
    title: item.title,
    body: item.body,
    kind: item.kind,
    semantic_class: item.semantic_class,
    review_status: item.review_status,
    sources: (item.source_refs ?? []).map(ref =>
      createSourceView(ref, recordByKey.get(sourceKey(ref)))
    ),
    technical: {
      stage: item.stage,
      origin: item.origin,
      authority_level: item.authority_level,
      confidence: structuredClone(item.confidence ?? null),
      review_reason: item.review_reason ?? null,
      metadata: structuredClone(item.metadata ?? null)
    }
  };
}

function createSourceView(ref, record) {
  const kind = String(ref?.kind ?? '').toUpperCase();
  if (kind === 'FILE_RANGE') {
    const citation = `${ref.path}:${ref.start_line}–${ref.end_line}`;
    if (!record || typeof record.text !== 'string') {
      return {
        key: sourceKey(ref),
        kind,
        reference_type: 'FILE_RANGE',
        citation,
        availability: 'UNAVAILABLE',
        unavailable_reason: 'ソース本文が成果物に同梱されていません。',
        lines: [],
        technical: sourceTechnical(ref, record)
      };
    }
    const lines = record.text.split('\n').map((text, index) => ({
      line_number: ref.start_line + index,
      text
    }));
    return {
      key: sourceKey(ref),
      kind,
      reference_type: 'FILE_RANGE',
      citation,
      availability: 'INLINE_SOURCE',
      unavailable_reason: null,
      lines,
      technical: sourceTechnical(ref, record)
    };
  }

  const canonicalRecord = record?.record;
  const provenance = canonicalRecord?.provenance;
  const path = typeof provenance?.path === 'string' && provenance.path
    ? provenance.path
    : null;
  const range = normalizeRange(provenance?.range);
  const runtime = isRuntimeRecord(canonicalRecord);
  const citation = path
    ? range
      ? `${path}:${range.start_line}–${range.end_line}`
      : path
    : runtime
      ? 'runtime observation'
      : `${kind}:${String(ref?.id ?? '')}`;

  return {
    key: sourceKey(ref),
    kind,
    reference_type: runtime
      ? 'RUNTIME_OBSERVATION'
      : path
        ? range ? 'PATH_RANGE_RECORD' : 'PATH_ONLY_RECORD'
        : 'CANONICAL_RECORD',
    citation,
    availability: canonicalRecord ? 'CANONICAL_RECORD' : 'UNAVAILABLE',
    unavailable_reason: canonicalRecord
      ? null
      : '参照先の根拠recordが成果物に同梱されていません。',
    lines: [],
    record: canonicalRecord ? structuredClone(canonicalRecord) : null,
    technical: sourceTechnical(ref, record)
  };
}

function assertPayloadIdentity(experience, sources) {
  const repositoryId = requireText(
    experience.repository?.repository_id,
    'Human Experience repository_id'
  );
  const snapshotId = requireText(
    experience.repository?.snapshot_id,
    'Human Experience snapshot_id'
  );
  if (
    sources.repository?.repository_id !== repositoryId ||
    sources.repository?.snapshot_id !== snapshotId
  ) {
    throw new TypeError('offline source bundle のrepository/snapshotが一致しません');
  }
  const irDigest = requireText(
    experience.source_identity?.human_analysis_ir_digest,
    'Human Experience IR digest'
  );
  if (sources.ir_digest !== irDigest) {
    throw new TypeError('offline source bundle のIR digestが一致しません');
  }
}

function sourceTechnical(ref, record) {
  return {
    ref: structuredClone(ref),
    instruction_authority: record?.instruction_authority ?? null,
    trust_class: record?.trust_class ?? null,
    content_digest: record?.content_digest ?? ref?.content_digest ?? null,
    text_digest: record?.text_digest ?? null,
    record_digest: record?.record_digest ?? null
  };
}

function normalizeRange(value) {
  if (
    Number.isInteger(value?.start_line) && value.start_line >= 1 &&
    Number.isInteger(value?.end_line) && value.end_line >= value.start_line
  ) {
    return {
      start_line: value.start_line,
      end_line: value.end_line
    };
  }
  return null;
}

function isRuntimeRecord(record) {
  const kind = String(record?.kind ?? '').toUpperCase();
  if (kind.includes('RUNTIME')) return true;
  const method = String(record?.provenance?.extraction_method ?? '').toUpperCase();
  return method.includes('RUNTIME') || method.includes('TRACE');
}

function sourceKey(ref) {
  const kind = String(ref?.kind ?? '').toUpperCase();
  if (kind === 'FILE_RANGE') {
    return [
      kind,
      String(ref?.path ?? ''),
      String(ref?.start_line ?? ''),
      String(ref?.end_line ?? ''),
      String(ref?.content_digest ?? '')
    ].join(':');
  }
  if (!kind || typeof ref?.id !== 'string' || !ref.id) {
    throw new TypeError('source ref が不完全です');
  }
  return `${kind}:${ref.id}`;
}

function requireText(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`${label} がありません`);
  }
  return value;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}