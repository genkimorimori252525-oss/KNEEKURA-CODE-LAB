import {
  assertProductionSemanticAuthor,
  createProductionSemanticAuthor
} from './author-contract.mjs';
import {
  stableDigest,
  validateSourceRef
} from './schema.mjs';

export const HUMAN_ANALYSIS_READ_RECEIPT_SCHEMA =
  'kneekura.human-analysis-read-receipt/v1';

/**
 * Wrap a real PRODUCTION semantic author so only source-broker reads made
 * inside the author's run() are recorded. Pipeline validation reads happen
 * against the original broker and therefore cannot inflate AI-read coverage.
 */
export function createReadTrackedProductionSemanticAuthor(
  semanticAuthor
) {
  const base = assertProductionSemanticAuthor(semanticAuthor);
  const receipts = new Map();

  const trackedAuthor = createProductionSemanticAuthor({
    id: base.id,
    locale: base.locale,
    provider_id: base.provider_id,
    run: async (envelope, sourceBroker) => {
      const trackedBroker = createTrackedBroker({
        sourceBroker,
        envelope,
        receipts
      });
      return base.run(envelope, trackedBroker);
    }
  });

  return Object.freeze({
    semanticAuthor: trackedAuthor,
    getReadReceipts() {
      return deepFreeze(
        [...receipts.values()]
          .map(item => structuredClone(item))
          .sort(compareReceipt)
      );
    }
  });
}

export function validateHumanAnalysisReadReceipt(receipt) {
  if (
    !receipt ||
    receipt.schema !== HUMAN_ANALYSIS_READ_RECEIPT_SCHEMA
  ) {
    throw new TypeError(
      `read receipt must use ${HUMAN_ANALYSIS_READ_RECEIPT_SCHEMA}`
    );
  }
  if (
    !receipt.repository?.repository_id ||
    !receipt.repository?.snapshot_id ||
    !receipt.evidence_pack_id ||
    !receipt.stage
  ) {
    throw new TypeError('read receipt identity/stage is required');
  }
  validateSourceRef(receipt.source_ref);
  if (receipt.read_kind === 'FILE_RANGE') {
    if (receipt.source_ref.kind !== 'FILE_RANGE') {
      throw new TypeError('FILE_RANGE receipt/ref kind mismatch');
    }
    if (
      receipt.content_digest !== receipt.source_ref.content_digest ||
      !String(receipt.range_text_digest ?? '').startsWith('sha256:')
    ) {
      throw new TypeError('FILE_RANGE read receipt digest mismatch');
    }
  } else if (receipt.read_kind === 'CANONICAL_RECORD') {
    if (receipt.source_ref.kind === 'FILE_RANGE') {
      throw new TypeError('canonical receipt/ref kind mismatch');
    }
    if (!String(receipt.record_digest ?? '').startsWith('sha256:')) {
      throw new TypeError('canonical read receipt record digest is required');
    }
  } else {
    throw new TypeError(`unsupported read receipt kind: ${receipt.read_kind}`);
  }
  const core = structuredClone(receipt);
  delete core.receipt_id;
  const expected = 'read:' + stableDigest(core).slice('sha256:'.length);
  if (receipt.receipt_id !== expected) {
    throw new TypeError('read receipt digest mismatch');
  }
  return true;
}

function createTrackedBroker({ sourceBroker, envelope, receipts }) {
  if (!sourceBroker?.pack_id) {
    throw new TypeError('tracked author requires a source broker');
  }
  const repository = envelope?.repository;
  if (!repository?.repository_id || !repository?.snapshot_id) {
    throw new TypeError('tracked author envelope repository identity is required');
  }
  const stage = String(envelope.stage ?? '');

  return Object.freeze({
    pack_id: sourceBroker.pack_id,
    instruction_authority: false,
    async readFileRange(ref) {
      const value = await sourceBroker.readFileRange(ref);
      const normalizedRef = normalizeRef({
        kind: 'FILE_RANGE',
        path: value.path,
        start_line: value.start_line,
        end_line: value.end_line,
        content_digest: value.content_digest
      });
      recordReceipt(receipts, {
        stage,
        repository,
        evidencePackId: sourceBroker.pack_id,
        sourceRef: normalizedRef,
        readKind: 'FILE_RANGE',
        extra: {
          content_digest: value.content_digest,
          range_text_digest: stableDigest({ text: value.text })
        }
      });
      return value;
    },
    resolveCanonicalRef(ref) {
      const value = sourceBroker.resolveCanonicalRef(ref);
      const normalizedRef = normalizeRef({
        kind: value.kind,
        id: value.id
      });
      recordReceipt(receipts, {
        stage,
        repository,
        evidencePackId: sourceBroker.pack_id,
        sourceRef: normalizedRef,
        readKind: 'CANONICAL_RECORD',
        extra: {
          record_digest: stableDigest(value.record)
        }
      });
      return value;
    }
  });
}

function recordReceipt(
  receipts,
  { stage, repository, evidencePackId, sourceRef, readKind, extra }
) {
  const core = {
    schema: HUMAN_ANALYSIS_READ_RECEIPT_SCHEMA,
    repository: {
      repository_id: String(repository.repository_id),
      snapshot_id: String(repository.snapshot_id)
    },
    evidence_pack_id: String(evidencePackId),
    stage: String(stage),
    read_kind: readKind,
    source_ref: sourceRef,
    ...extra
  };
  const receipt = {
    ...core,
    receipt_id: 'read:' + stableDigest(core).slice('sha256:'.length)
  };
  validateHumanAnalysisReadReceipt(receipt);
  const key = [stage, sourceKey(sourceRef)].join('|');
  receipts.set(key, deepFreeze(receipt));
}

function normalizeRef(ref) {
  validateSourceRef(ref);
  const kind = String(ref.kind).toUpperCase();
  if (kind === 'FILE_RANGE') {
    return {
      kind,
      path: String(ref.path).replaceAll('\\', '/'),
      start_line: Number(ref.start_line),
      end_line: Number(ref.end_line),
      content_digest: String(ref.content_digest)
    };
  }
  return { kind, id: String(ref.id) };
}

function sourceKey(ref) {
  return ref.kind === 'FILE_RANGE'
    ? [
        'FILE_RANGE',
        ref.path,
        ref.start_line,
        ref.end_line,
        ref.content_digest
      ].join(':')
    : `${ref.kind}:${ref.id}`;
}

function compareReceipt(a, b) {
  return (
    compareText(a.stage, b.stage) ||
    compareText(sourceKey(a.source_ref), sourceKey(b.source_ref)) ||
    compareText(a.receipt_id, b.receipt_id)
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