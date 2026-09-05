import {
  compileProductionHumanExperienceArtifact as compilePreparedProductionArtifact
} from './artifact-compiler.mjs';

export async function compileProductionHumanExperienceArtifact({
  experience,
  sourceBroker,
  title = null,
  explorerShell = null
} = {}) {
  const ir = experience?.derived?.human_analysis_ir;
  if (!ir || !Array.isArray(ir.items)) {
    throw new TypeError(
      'production Human Experience artifact requires Human Analysis IR'
    );
  }
  if (
    !sourceBroker ||
    sourceBroker.instruction_authority !== false ||
    typeof sourceBroker.readFileRange !== 'function' ||
    typeof sourceBroker.resolveCanonicalRef !== 'function'
  ) {
    const error = new TypeError(
      'production Human Experience artifact requires a snapshot-validating Source Broker'
    );
    error.code = 'PRODUCTION_SOURCE_BROKER_REQUIRED';
    throw error;
  }
  if (
    sourceBroker.pack_id !==
    experience.source_identity?.evidence_pack_id
  ) {
    const error = new TypeError(
      'production Source Broker Evidence Pack identity does not match Human Experience'
    );
    error.code = 'PRODUCTION_SOURCE_BROKER_IDENTITY_MISMATCH';
    throw error;
  }

  const sources = await materializeSources(ir, sourceBroker);
  return compilePreparedProductionArtifact({
    experience,
    sources,
    title,
    explorerShell
  });
}

async function materializeSources(ir, sourceBroker) {
  const rows = [];
  const seen = new Set();
  for (const item of ir.items) {
    for (const ref of item.source_refs ?? []) {
      const key = sourceKey(ref);
      if (seen.has(key)) continue;
      seen.add(key);

      if (String(ref.kind).toUpperCase() === 'FILE_RANGE') {
        const materialized = await sourceBroker.readFileRange(ref);
        assertFileRangeMaterialization(ref, materialized);
        rows.push({
          ref: structuredClone(ref),
          instruction_authority: false,
          trust_class: materialized.trust_class,
          content_digest: materialized.content_digest,
          text: materialized.text
        });
        continue;
      }

      const materialized = sourceBroker.resolveCanonicalRef(ref);
      if (
        materialized?.instruction_authority !== false ||
        materialized?.kind !== String(ref.kind).toUpperCase() ||
        materialized?.id !== ref.id ||
        !materialized.record
      ) {
        throw new TypeError(
          `Source Broker returned an invalid canonical materialization for ${key}`
        );
      }
      rows.push({
        ref: structuredClone(ref),
        instruction_authority: false,
        trust_class: materialized.trust_class,
        record: materialized.record
      });
    }
  }
  return rows;
}

function assertFileRangeMaterialization(ref, materialized) {
  if (
    !materialized ||
    materialized.instruction_authority !== false ||
    materialized.kind !== 'FILE_RANGE' ||
    materialized.path !== ref.path ||
    materialized.start_line !== ref.start_line ||
    materialized.end_line !== ref.end_line ||
    materialized.content_digest !== ref.content_digest ||
    typeof materialized.text !== 'string'
  ) {
    throw new TypeError(
      `Source Broker returned an invalid FILE_RANGE materialization for ${sourceKey(ref)}`
    );
  }
}

function sourceKey(ref) {
  const kind = String(ref?.kind ?? '').toUpperCase();
  if (kind === 'FILE_RANGE') {
    return [
      kind,
      ref.path,
      ref.start_line,
      ref.end_line,
      ref.content_digest
    ].join(':');
  }
  return `${kind}:${String(ref?.id ?? '')}`;
}