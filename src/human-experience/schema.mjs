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
  createExplorerUiModel(projection.canonical?.explorer_projection);
  validateHumanAnalysisIr(projection.derived?.human_analysis_ir);
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
  const repositoryIds = new Set([
    explorerProjection.source?.repository_id,
    evidencePack.repository?.repository_id,
    ir.repository?.repository_id
  ].filter(Boolean));
  if (repositoryIds.size !== 1) {
    throw new TypeError(
      'Human Experience repository identity mismatch between Explorer, Evidence Pack and Human Analysis IR'
    );
  }
  const snapshotIds = new Set([
    explorerProjection.source?.snapshot_id,
    evidencePack.repository?.snapshot_id,
    ir.repository?.snapshot_id
  ].filter(Boolean));
  if (snapshotIds.size !== 1) {
    throw new TypeError(
      'Human Experience snapshot identity mismatch between Explorer, Evidence Pack and Human Analysis IR'
    );
  }
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
      const key = [
        ref.path,
        ref.start_line,
        ref.end_line,
        ref.content_digest
      ].join(':');
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
