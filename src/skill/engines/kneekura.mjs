import {
  assertHumanAnalysisSourcePayloadBudget,
  assertProductionHumanAnalysisIr,
  compileProductionHumanExperienceArtifact,
  createProductionSemanticAuthor,
  createReadTrackedProductionSemanticAuthor,
  stableDigest
} from '../../human-analysis/index.mjs';
import { createHumanExperienceProjection } from '../../human-experience/index.mjs';
import { createEngineRunReceipt } from '../contracts.mjs';

export const KNEEKURA_SKILL_ENGINE_RESULT_SCHEMA =
  'kneekura.code-lab.kneekura-engine-result/v1';

export async function runNativeKneekuraHumanGuide({
  evidencePack,
  sourceBroker,
  explorerProjection,
  semanticAuthorHost,
  semanticAuthorId = 'kneekura-code-lab-host-author',
  semanticProviderId = null,
  locale = 'ja-JP',
  request = {},
  presentationFactory = null,
  explorerShell = null,
  title = 'KNEEKURA Human Guide',
  attemptId,
  scopeDigest = null,
  minimumClaimLevel = null
} = {}) {
  if (!evidencePack?.pack_id) {
    throw codedError(
      'KNEEKURA_EVIDENCE_PACK_REQUIRED',
      'native KNEEKURA Skill engine requires an Evidence Pack'
    );
  }
  if (!sourceBroker || sourceBroker.pack_id !== evidencePack.pack_id) {
    throw codedError(
      'KNEEKURA_SOURCE_BROKER_REQUIRED',
      'native KNEEKURA Skill engine requires the matching Source Broker'
    );
  }
  if (explorerProjection?.schema !== 'kneekura.explorer-projection/v1') {
    throw codedError(
      'KNEEKURA_EXPLORER_PROJECTION_REQUIRED',
      'native KNEEKURA Skill engine requires the canonical Explorer projection'
    );
  }
  if (typeof semanticAuthorHost !== 'function') {
    throw codedError(
      'PRODUCTION_AUTHOR_HOST_REQUIRED',
      'native KNEEKURA Skill engine requires an explicit PRODUCTION semantic-author host callback'
    );
  }
  if (presentationFactory != null && typeof presentationFactory !== 'function') {
    throw new TypeError('presentationFactory must be a function when supplied');
  }
  const normalizedAttemptId = requireNonEmpty(attemptId, 'attemptId');
  const normalizedScopeDigest = scopeDigest == null
    ? stableDigest({ request: normalizeRequestForDigest(request) })
    : requireNonEmpty(scopeDigest, 'scopeDigest');

  const productionAuthor = createProductionSemanticAuthor({
    id: semanticAuthorId,
    provider_id: semanticProviderId,
    locale,
    run: async (envelope, broker) => semanticAuthorHost(envelope, broker)
  });
  const tracked = createReadTrackedProductionSemanticAuthor(productionAuthor);
  const ir = await runProductionPipeline({
    evidencePack,
    sourceBroker,
    semanticAuthor: tracked.semanticAuthor,
    request
  });
  assertProductionHumanAnalysisIr(ir);
  if (
    ir.generation?.fallback_to_acceptance_forbidden !== true ||
    ir.generation?.semantic_author?.acceptance_fixture !== false
  ) {
    throw codedError(
      'KNEEKURA_PRODUCTION_CONTRACT_VIOLATION',
      'native KNEEKURA Skill engine must never deliver acceptance authoring'
    );
  }

  const readReceipts = tracked.getReadReceipts();
  const sources = await materializeSources(ir, sourceBroker);
  assertHumanAnalysisSourcePayloadBudget(sources);

  const presentation = presentationFactory == null
    ? null
    : await presentationFactory({
        ir,
        evidencePack,
        sourceBroker,
        sources,
        readReceipts
      });

  const experience = createHumanExperienceProjection({
    explorerProjection,
    evidencePack,
    humanAnalysisIr: ir,
    locale
  });
  const artifact = await compileProductionHumanExperienceArtifact({
    experience,
    sources,
    presentation,
    title,
    explorerShell
  });

  if (
    artifact?.manifest?.renderer_surface !== 'HUMAN_EXPLORER_V2' ||
    !Buffer.isBuffer(artifact.zip_bytes) ||
    !String(artifact.zip_digest ?? '').startsWith('sha256:')
  ) {
    throw codedError(
      'KNEEKURA_PRODUCTION_ARTIFACT_INVALID',
      'native KNEEKURA Skill engine did not produce the production Human Explorer ZIP'
    );
  }

  const receipt = createEngineRunReceipt({
    engineId: 'kneekura',
    implementationOrigin: 'first-party',
    implementationVersion: 'human-explorer-v2',
    orchestrationMode: 'native',
    snapshotId: ir.repository.snapshot_id,
    scopeDigest: normalizedScopeDigest,
    attemptId: normalizedAttemptId,
    status: 'SUCCESS',
    claimLevel: 'NATIVE',
    minimumClaimLevel,
    claimSatisfied: true,
    acceptance: {
      production_ir: true,
      generation_mode: ir.generation.mode,
      user_deliverable: ir.generation.user_deliverable,
      acceptance_fallback_forbidden:
        ir.generation.fallback_to_acceptance_forbidden === true,
      semantic_author_acceptance_fixture:
        ir.generation.semantic_author.acceptance_fixture,
      human_explorer_v2: true,
      deterministic_zip_digest: artifact.zip_digest
    },
    coverage: {
      semantic_items: ir.items.length,
      accepted_items: ir.review.accepted_item_ids.length,
      rejected_items: ir.review.rejected_item_ids.length,
      direct_author_reads: readReceipts.length,
      source_records: sources.length
    },
    artifacts: [{
      kind: 'KNEEKURA_HUMAN_EXPLORER_ZIP',
      digest: artifact.zip_digest,
      bytes: artifact.zip_bytes.length,
      artifact_id: artifact.artifact_id
    }],
    warnings: [],
    errors: []
  });

  return Object.freeze({
    schema: KNEEKURA_SKILL_ENGINE_RESULT_SCHEMA,
    engineId: 'kneekura',
    ir,
    experience,
    presentation,
    readReceipts,
    sources,
    artifact,
    receipt
  });
}

async function runProductionPipeline(args) {
  const { runProductionHumanAnalysisSemanticPipeline } =
    await import('../../human-analysis/production.mjs');
  return runProductionHumanAnalysisSemanticPipeline(args);
}

async function materializeSources(ir, broker) {
  const rows = new Map();
  for (const item of ir.items) {
    for (const ref of item.source_refs ?? []) {
      const key = sourceKey(ref);
      if (rows.has(key)) continue;
      if (ref.kind === 'FILE_RANGE') {
        const value = await broker.readFileRange(ref);
        rows.set(key, {
          ref: structuredClone(ref),
          instruction_authority: false,
          trust_class: value.trust_class,
          content_digest: value.content_digest,
          text: value.text
        });
      } else {
        const value = broker.resolveCanonicalRef(ref);
        rows.set(key, {
          ref: structuredClone(ref),
          instruction_authority: false,
          trust_class: value.trust_class,
          record: value.record
        });
      }
    }
  }
  return [...rows.entries()]
    .sort((a, b) => compareText(a[0], b[0]))
    .map(([, value]) => value);
}

function sourceKey(ref) {
  return ref.kind === 'FILE_RANGE'
    ? [ref.kind, ref.path, ref.start_line, ref.end_line, ref.content_digest].join(':')
    : `${ref.kind}:${ref.id}`;
}

function normalizeRequestForDigest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) return {};
  return structuredClone(request);
}

function requireNonEmpty(value, label) {
  const text = String(value ?? '').trim();
  if (!text) throw new TypeError(`${label} must be a non-empty string`);
  return text;
}

function compareText(a, b) {
  const left = String(a);
  const right = String(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}