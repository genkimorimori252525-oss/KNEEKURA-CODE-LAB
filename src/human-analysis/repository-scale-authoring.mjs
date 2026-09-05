import {
  createProductionSemanticAuthor
} from './author-contract.mjs';
import {
  createReadTrackedProductionSemanticAuthor
} from './author-read-trace.mjs';
import {
  runProductionHumanAnalysisSemanticPipeline
} from './production.mjs';
import {
  stableDigest
} from './schema.mjs';
import {
  HUMAN_ANALYSIS_BATCH_PLAN_SCHEMA,
  validateRepositoryDomainBatchPlan
} from './repository-batches.mjs';

export const HUMAN_ANALYSIS_REPOSITORY_AUTHORING_RECORD_SCHEMA =
  'kneekura.human-analysis-repository-authoring-record/v1';

export async function runRepositoryScaleProductionAuthoring({
  evidencePack,
  sourceBroker,
  batchPlan,
  records,
  authorId = 'repository-scale-production-author',
  providerId = 'chatgpt:gpt-5.6-sol',
  locale = 'ja-JP',
  request = null
} = {}) {
  if (!evidencePack?.pack_id || sourceBroker?.pack_id !== evidencePack.pack_id) {
    throw new TypeError('repository-scale authoring requires matching Evidence Pack and Source Broker');
  }
  if (batchPlan?.schema !== HUMAN_ANALYSIS_BATCH_PLAN_SCHEMA) {
    throw new TypeError('repository-scale authoring requires a batch plan');
  }
  validateRepositoryDomainBatchPlan(batchPlan, evidencePack.source_catalog);
  const authoring = normalizeAuthoringRecords(records, batchPlan, evidencePack.source_catalog);
  const recordByBatch = new Map(authoring.records.map(row => [row.batch_id, row]));
  const catalogByPath = new Map(evidencePack.source_catalog.map(row => [row.path, row]));

  const base = createProductionSemanticAuthor({
    id: authorId,
    provider_id: providerId,
    locale,
    run: async (envelope, broker) => {
      if (envelope.stage === 'DOMAIN') {
        const items = [];
        for (const batch of batchPlan.batches) {
          const record = recordByBatch.get(batch.batch_id);
          const catalog = catalogByPath.get(batch.representative_path);
          const ref = {
            kind: 'FILE_RANGE',
            path: batch.representative_path,
            start_line: 1,
            end_line: catalog.line_count,
            content_digest: catalog.content_digest
          };
          await broker.readFileRange(ref);
          items.push({
            kind: 'DOMAIN_CONCEPT',
            semantic_class: 'AI_INTERPRETATION',
            title: record.title,
            body: record.body,
            source_refs: [ref],
            confidence: {
              level: 'BOUNDED',
              rationale: 'Representative source was read directly; interpretation is intentionally not generalized to every file in the batch.'
            },
            ordering_key: batch.batch_id,
            metadata: {
              repository_scale_batch_id: batch.batch_id,
              repository_scale_domain: batch.domain,
              representative_path: batch.representative_path,
              interpretation_scope: 'REPRESENTATIVE_SOURCE_ONLY'
            }
          });
        }
        return { items };
      }
      if (envelope.stage === 'REVIEWER') {
        const candidates = envelope.candidate_items ?? [];
        const decisions = candidates.map(item => {
          const batchId = item.metadata?.repository_scale_batch_id;
          const batch = batchPlan.batches.find(row => row.batch_id === batchId);
          const record = recordByBatch.get(batchId);
          const valid = Boolean(
            batch &&
            record &&
            item.kind === 'DOMAIN_CONCEPT' &&
            item.semantic_class === 'AI_INTERPRETATION' &&
            item.title === record.title &&
            item.body === record.body &&
            item.source_refs?.length === 1 &&
            item.source_refs[0]?.kind === 'FILE_RANGE' &&
            item.source_refs[0]?.path === batch.representative_path
          );
          return {
            item_id: item.id,
            status: valid ? 'ACCEPT' : 'REJECT',
            reason: valid
              ? 'Saved repository-scale authoring record matches the reviewed batch and a direct representative-source read.'
              : 'Repository-scale candidate does not match its saved batch authoring contract.'
          };
        });
        return { decisions, findings: [] };
      }
      return { items: [] };
    }
  });

  const tracked = createReadTrackedProductionSemanticAuthor(base);
  const ir = await runProductionHumanAnalysisSemanticPipeline({
    evidencePack,
    sourceBroker,
    semanticAuthor: tracked.semanticAuthor,
    request: request ?? {
      question: 'リポジトリ全体をdomain batch単位で概観し、代表sourceから確認できる責務だけを説明する。',
      audience: 'HUMAN',
      scope: {
        kind: 'REPOSITORY_SCALE_BATCHED',
        batch_plan_id: batchPlan.plan_id
      }
    }
  });
  const receipts = tracked.getReadReceipts();
  const domainItems = ir.items.filter(item => item.stage === 'DOMAIN');
  if (
    domainItems.length !== batchPlan.batches.length ||
    ir.review.rejected_item_ids.length !== 0 ||
    ir.review.accepted_item_ids.length !== batchPlan.batches.length
  ) {
    throw new TypeError('repository-scale integration review did not accept exactly one DOMAIN item per batch');
  }

  const directPaths = new Set(
    receipts
      .filter(row => row.read_kind === 'FILE_RANGE')
      .map(row => row.source_ref.path)
  );
  for (const batch of batchPlan.batches) {
    if (!directPaths.has(batch.representative_path)) {
      throw new TypeError(`repository-scale batch lacks direct author read: ${batch.batch_id}`);
    }
  }

  const sources = [];
  for (const batch of batchPlan.batches) {
    const catalog = catalogByPath.get(batch.representative_path);
    const ref = {
      kind: 'FILE_RANGE',
      path: batch.representative_path,
      start_line: 1,
      end_line: catalog.line_count,
      content_digest: catalog.content_digest
    };
    const read = await sourceBroker.readFileRange(ref);
    sources.push({
      ref,
      instruction_authority: false,
      trust_class: 'UNTRUSTED_REPOSITORY_DATA',
      content_digest: read.content_digest,
      text: read.text
    });
  }

  return deepFreeze({
    schema: 'kneekura.human-analysis-repository-authoring-run/v1',
    authoring_record_digest: authoring.record_digest,
    batch_plan_id: batchPlan.plan_id,
    ir,
    read_receipts: receipts,
    sources,
    reviewed_batches: batchPlan.batches.map(batch => ({
      batch_id: batch.batch_id,
      domain: batch.domain,
      status: 'REVIEWED',
      paths: [...batch.paths]
    })),
    integration_review: {
      status: 'ACCEPTED',
      reviewed_batch_ids: batchPlan.batches.map(row => row.batch_id).sort(compareText),
      review_note: 'All deterministic repository domain batches produced one directly sourced DOMAIN interpretation and passed integration review without canonical promotion.'
    }
  });
}

export function normalizeRepositoryScaleAuthoringRecord(records, batchPlan, sourceCatalog) {
  return normalizeAuthoringRecords(records, batchPlan, sourceCatalog);
}

function normalizeAuthoringRecords(records, batchPlan, sourceCatalog) {
  if (!Array.isArray(records)) {
    throw new TypeError('repository-scale authoring records must be an array');
  }
  validateRepositoryDomainBatchPlan(batchPlan, sourceCatalog);
  const batchById = new Map(batchPlan.batches.map(row => [row.batch_id, row]));
  const seen = new Set();
  const normalized = records.map((record, index) => {
    const batchId = requiredText(record?.batch_id, `records[${index}].batch_id`);
    const batch = batchById.get(batchId);
    if (!batch) throw new TypeError(`authoring record references foreign batch: ${batchId}`);
    if (seen.has(batchId)) throw new TypeError(`duplicate authoring record batch: ${batchId}`);
    seen.add(batchId);
    const representativePath = requiredText(
      record?.representative_path,
      `records[${index}].representative_path`
    ).replaceAll('\\', '/');
    if (representativePath !== batch.representative_path) {
      throw new TypeError(`authoring representative path drift: ${batchId}`);
    }
    return {
      batch_id: batchId,
      domain: batch.domain,
      representative_path: representativePath,
      title: requiredText(record?.title, `records[${index}].title`),
      body: requiredText(record?.body, `records[${index}].body`)
    };
  }).sort((a, b) => compareText(a.batch_id, b.batch_id));
  if (seen.size !== batchPlan.batches.length) {
    const missing = batchPlan.batches
      .map(row => row.batch_id)
      .filter(id => !seen.has(id));
    throw new TypeError(`authoring record must cover every batch: ${missing.join(',')}`);
  }
  const core = {
    schema: HUMAN_ANALYSIS_REPOSITORY_AUTHORING_RECORD_SCHEMA,
    batch_plan_id: batchPlan.plan_id,
    records: normalized
  };
  return deepFreeze({
    ...core,
    record_digest: stableDigest(core)
  });
}

function requiredText(value, label) {
  const text = String(value ?? '').trim();
  if (!text) throw new TypeError(`${label} is required`);
  return text;
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