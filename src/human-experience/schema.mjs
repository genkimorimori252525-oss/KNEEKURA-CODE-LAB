import {
  EVIDENCE_PACK_SCHEMA,
  HUMAN_ANALYSIS_IR_SCHEMA,
  stableDigest,
  validateHumanAnalysisIr
} from '../human-analysis/schema.mjs';
import { createExplorerUiModel } from '../presentation/explorer/ui-model.mjs';

export const HUMAN_EXPERIENCE_PROJECTION_SCHEMA =
  'kneekura.human-experience-projection/v1';

const EXPLORER_PROJECTION_SCHEMA =
  'kneekura.explorer-projection/v1';

export function createHumanExperienceProjection({
  explorerProjection,
  evidencePack,
  humanAnalysisIr,
  locale = 'ja-JP'
} = {}) {
  if (explorerProjection?.schema !== EXPLORER_PROJECTION_SCHEMA) {
    throw new TypeError(
      `Human Experience requires ${EXPLORER_PROJECTION_SCHEMA}`
    );
  }
  // Existing deterministic Explorer validator: one-to-one canonical traceability.
  createExplorerUiModel(explorerProjection);
  if (evidencePack?.schema !== EVIDENCE_PACK_SCHEMA) {
    throw new TypeError(
      `Human Experience requires ${EVIDENCE_PACK_SCHEMA}`
    );
  }
  if (humanAnalysisIr?.schema !== HUMAN_ANALYSIS_IR_SCHEMA) {
    throw new TypeError(
      `Human Experience requires ${HUMAN_ANALYSIS_IR_SCHEMA}`
    );
  }
  validateHumanAnalysisIr(humanAnalysisIr);
  const normalizedLocale = normalizeLocale(locale);
  assertIdentity(explorerProjection, evidencePack, humanAnalysisIr);
  assertEvidencePackLink(evidencePack, humanAnalysisIr);
  const sourceIndex = buildSourceIndex(evidencePack, humanAnalysisIr);

  const core = {
    schema: HUMAN_EXPERIENCE_PROJECTION_SCHEMA,
    locale: normalizedLocale,
    repository: {
      repository_id: humanAnalysisIr.repository.repository_id,
      snapshot_id: humanAnalysisIr.repository.snapshot_id
    },
    source_identity: {
      explorer_projection_schema: explorerProjection.schema,
      explorer_analysis_result_digest:
        explorerProjection.source?.analysis_result_digest ?? null,
      evidence_pack_id: evidencePack.pack_id,
      evidence_pack_digest: evidencePack.pack_digest,
      canonical_digest: evidencePack.canonical_digest,
      human_analysis_ir_digest: humanAnalysisIr.ir_digest
    },
    canonical: {
      explorer_projection: structuredClone(explorerProjection),
      evidence: structuredClone(evidencePack.canonical.evidence)
    },
    derived: {
      human_analysis_ir: structuredClone(humanAnalysisIr),
      item_source_links: humanAnalysisIr.items.map(item => ({
        item_id: item.id,
        semantic_class: item.semantic_class,
        source_refs: structuredClone(item.source_refs)
      }))
    },
    source_index: sourceIndex,
    invariants: {
      analysis_authority: false,
      may_mint_canonical_nodes: false,
      may_mint_canonical_edges: false,
      may_mint_canonical_claims: false,
      may_upgrade_unknown_or_coverage: false,
      canonical_ids_preserved: true,
      repository_content_instruction_authority: false,
      ai_interpretation_remains_derived: true
    }
  };
  const projectionId =
    'human-experience:' + stableDigest(core).slice('sha256:'.length);
  return deepFreeze({
    ...core,
    projection_id: projectionId
  });
}

export function validateHumanExperienceProjection(projection) {
  if (!projection || projection.schema !== HUMAN_EXPERIENCE_PROJECTION_SCHEMA) {
    throw new TypeError(
      `Human Experience projection must use ${HUMAN_EXPERIENCE_PROJECTION_SCHEMA}`
    );
  }
  const explorerProjection = projection.canonical?.explorer_projection;
  const humanAnalysisIr = projection.derived?.human_analysis_ir;
  createExplorerUiModel(explorerProjection);
  validateHumanAnalysisIr(humanAnalysisIr);
  assertProjectionIdentity(
    projection,
    explorerProjection,
    humanAnalysisIr
  );
  assertProjectionSourceIdentity(
    projection,
    explorerProjection,
    humanAnalysisIr
  );
  assertProjectedSourceIndex(
    projection.source_index,
    humanAnalysisIr
  );

  const invariants = projection.invariants ?? {};
  for (const key of [
    'analysis_authority',
    'may_mint_canonical_nodes',
    'may_mint_canonical_edges',
    'may_mint_canonical_claims',
    'may_upgrade_unknown_or_coverage',
    'repository_content_instruction_authority'
  ]) {
    if (invariants[key] !== false) {
      throw new TypeError(`Human Experience invariant must remain false: ${key}`);
    }
  }
  if (
    invariants.canonical_ids_preserved !== true ||
    invariants.ai_interpretation_remains_derived !== true
  ) {
    throw new TypeError('Human Experience traceability invariants are invalid');
  }
  const clone = structuredClone(projection);
  delete clone.projection_id;
  const expected =
    'human-experience:' + stableDigest(clone).slice('sha256:'.length);
  if (projection.projection_id !== expected) {
    throw new TypeError('Human Experience projection digest mismatch');
  }
  return true;
}

function assertIdentity(explorerProjection, evidencePack, ir) {
  assertRequiredIdentity('repository', [
    ['Explorer', explorerProjection.source?.repository_id],
    ['Evidence Pack', evidencePack.repository?.repository_id],
    ['Human Analysis IR', ir.repository?.repository_id]
  ]);
  assertRequiredIdentity('snapshot', [
    ['Explorer', explorerProjection.source?.snapshot_id],
    ['Evidence Pack', evidencePack.repository?.snapshot_id],
    ['Human Analysis IR', ir.repository?.snapshot_id]
  ]);
}

function assertProjectionIdentity(projection, explorerProjection, ir) {
  assertRequiredIdentity('repository', [
    ['Human Experience', projection.repository?.repository_id],
    ['Explorer', explorerProjection.source?.repository_id],
    ['Human Analysis IR', ir.repository?.repository_id]
  ]);
  assertRequiredIdentity('snapshot', [
    ['Human Experience', projection.repository?.snapshot_id],
    ['Explorer', explorerProjection.source?.snapshot_id],
    ['Human Analysis IR', ir.repository?.snapshot_id]
  ]);
}

function assertRequiredIdentity(kind, entries) {
  const missing = entries
    .filter(([, value]) => !isIdentityValue(value))
    .map(([label]) => label);
  if (missing.length > 0) {
    throw new TypeError(
      `Human Experience ${kind} identity missing: ${missing.join(', ')}`
    );
  }
  const values = new Set(entries.map(([, value]) => value));
  if (values.size !== 1) {
    throw new TypeError(
      `Human Experience ${kind} identity mismatch between ${entries.map(([label]) => label).join(', ')}`
    );
  }
}

function isIdentityValue(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function assertEvidencePackLink(evidencePack, ir) {
  if (
    ir.evidence_pack?.pack_id !== evidencePack.pack_id ||
    ir.evidence_pack?.canonical_digest !== evidencePack.canonical_digest ||
    ir.evidence_pack?.pack_digest !== evidencePack.pack_digest
  ) {
    throw new TypeError(
      'Human Experience Human Analysis IR does not reference the supplied Evidence Pack exactly'
    );
  }
}

function assertProjectionSourceIdentity(
  projection,
  explorerProjection,
  ir
) {
  const sourceIdentity = projection.source_identity ?? {};
  if (
    sourceIdentity.explorer_projection_schema !==
    explorerProjection.schema
  ) {
    throw new TypeError(
      'Human Experience Explorer projection schema identity mismatch'
    );
  }
  if (
    sourceIdentity.explorer_analysis_result_digest !==
    (explorerProjection.source?.analysis_result_digest ?? null)
  ) {
    throw new TypeError(
      'Human Experience Explorer analysis result identity mismatch'
    );
  }
  assertRequiredIdentity('Evidence Pack ID', [
    ['Human Experience', sourceIdentity.evidence_pack_id],
    ['Human Analysis IR', ir.evidence_pack?.pack_id]
  ]);
  assertRequiredIdentity('Evidence Pack digest', [
    ['Human Experience', sourceIdentity.evidence_pack_digest],
    ['Human Analysis IR', ir.evidence_pack?.pack_digest]
  ]);
  assertRequiredIdentity('canonical digest', [
    ['Human Experience', sourceIdentity.canonical_digest],
    ['Human Analysis IR', ir.evidence_pack?.canonical_digest]
  ]);
  assertRequiredIdentity('Human Analysis IR digest', [
    ['Human Experience', sourceIdentity.human_analysis_ir_digest],
    ['Human Analysis IR', ir.ir_digest]
  ]);
}

function buildSourceIndex(evidencePack, ir) {
  const catalogByPath = new Map(
    evidencePack.source_catalog.map(entry => [entry.path, entry])
  );
  const rangesByKey = new Map();
  for (const item of ir.items) {
    for (const ref of item.source_refs ?? []) {
      if (ref.kind !== 'FILE_RANGE') continue;
      const catalog = catalogByPath.get(ref.path);
      if (!catalog) {
        throw new TypeError(
          `Human Experience FILE_RANGE is absent from source catalog: ${ref.path}`
        );
      }
      if (catalog.content_digest !== ref.content_digest) {
        throw new TypeError(
          `Human Experience FILE_RANGE digest mismatch for ${ref.path}`
        );
      }
      const key = sourceRangeKey(ref);
      if (!rangesByKey.has(key)) {
        rangesByKey.set(key, structuredClone(ref));
      }
    }
  }
  return {
    files: evidencePack.source_catalog.map(entry => structuredClone(entry)),
    ranges: [...rangesByKey.values()].sort(compareRange),
    item_count: ir.items.length,
    file_count: evidencePack.source_catalog.length
  };
}

function assertProjectedSourceIndex(sourceIndex, ir) {
  if (
    !sourceIndex ||
    !Array.isArray(sourceIndex.files) ||
    !Array.isArray(sourceIndex.ranges)
  ) {
    throw new TypeError('Human Experience source index is invalid');
  }
  if (sourceIndex.item_count !== ir.items.length) {
    throw new TypeError('Human Experience source index item count mismatch');
  }
  if (sourceIndex.file_count !== sourceIndex.files.length) {
    throw new TypeError('Human Experience source index file count mismatch');
  }

  const catalogByPath = new Map();
  for (const entry of sourceIndex.files) {
    if (
      !entry ||
      typeof entry.path !== 'string' ||
      !entry.path ||
      typeof entry.content_digest !== 'string' ||
      !entry.content_digest.startsWith('sha256:')
    ) {
      throw new TypeError('Human Experience source index file entry is invalid');
    }
    if (catalogByPath.has(entry.path)) {
      throw new TypeError(
        `Human Experience source index duplicates file: ${entry.path}`
      );
    }
    catalogByPath.set(entry.path, entry);
  }

  const expectedRanges = new Map();
  for (const item of ir.items) {
    for (const ref of item.source_refs ?? []) {
      if (ref.kind !== 'FILE_RANGE') continue;
      const catalog = catalogByPath.get(ref.path);
      if (!catalog) {
        throw new TypeError(
          `Human Experience FILE_RANGE is absent from projected source catalog: ${ref.path}`
        );
      }
      if (catalog.content_digest !== ref.content_digest) {
        throw new TypeError(
          `Human Experience projected FILE_RANGE digest mismatch for ${ref.path}`
        );
      }
      expectedRanges.set(sourceRangeKey(ref), ref);
    }
  }

  const actualRanges = new Set();
  for (const range of sourceIndex.ranges) {
    const key = sourceRangeKey(range);
    if (actualRanges.has(key)) {
      throw new TypeError(
        `Human Experience source index duplicates range: ${key}`
      );
    }
    actualRanges.add(key);
  }
  if (
    actualRanges.size !== expectedRanges.size ||
    [...expectedRanges.keys()].some(key => !actualRanges.has(key))
  ) {
    throw new TypeError('Human Experience source index ranges mismatch Human Analysis IR');
  }
}

function sourceRangeKey(ref) {
  return [
    ref.path,
    ref.start_line,
    ref.end_line,
    ref.content_digest
  ].join(':');
}

function compareRange(a, b) {
  return (
    compareText(a.path, b.path) ||
    a.start_line - b.start_line ||
    a.end_line - b.end_line ||
    compareText(a.content_digest, b.content_digest)
  );
}

function normalizeLocale(value) {
  const locale = String(value ?? '').trim();
  if (!locale || locale.length > 32 || !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(locale)) {
    throw new TypeError(`invalid Human Experience locale: ${String(value)}`);
  }
  return locale;
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