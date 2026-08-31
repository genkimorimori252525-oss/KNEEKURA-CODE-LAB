import crypto from 'node:crypto';
import { validateSourceRef } from './schema.mjs';

export function createHumanAnalysisSourceBroker(pack, { readSource }) {
  if (!pack?.pack_id || !pack?.canonical_digest) throw new TypeError('source broker requires an evidence pack');
  if (typeof readSource !== 'function') throw new TypeError('source broker requires readSource(path)');
  const catalog = new Map(pack.source_catalog.map(entry => [entry.path, entry]));
  const recordMaps = {
    EVIDENCE: recordMap(pack.canonical.evidence, item => item?.id),
    CLAIM: recordMap(pack.canonical.result.claims, item => item?.id),
    COVERAGE: recordMap(pack.canonical.result.coverage.entries, item => item?.id),
    UNKNOWN: recordMap(pack.canonical.result.unknowns, item => item?.id ?? item?.ref),
    NODE: recordMap(pack.canonical.graph.nodes, item => item?.id),
    EDGE: recordMap(pack.canonical.graph.edges, item => item?.id)
  };

  return Object.freeze({
    pack_id: pack.pack_id,
    instruction_authority: false,
    resolveCanonicalRef(ref) {
      validateSourceRef(ref);
      const kind = String(ref.kind).toUpperCase();
      if (kind === 'FILE_RANGE') throw new TypeError('use readFileRange for FILE_RANGE refs');
      const record = recordMaps[kind]?.get(String(ref.id));
      if (!record) throw new TypeError(`foreign ${kind} source ref: ${ref.id}`);
      return deepFreeze({
        kind,
        id: String(ref.id),
        record: structuredClone(record),
        instruction_authority: false,
        trust_class: 'CANONICAL_EVIDENCE_DATA'
      });
    },
    async readFileRange(ref) {
      validateSourceRef(ref);
      if (String(ref.kind).toUpperCase() !== 'FILE_RANGE') throw new TypeError('readFileRange requires FILE_RANGE ref');
      const path = normalizeRepoPath(ref.path);
      const meta = catalog.get(path);
      if (!meta) throw new TypeError(`source path is outside evidence-pack catalog: ${path}`);
      const raw = await readSource(path);
      if (typeof raw !== 'string') throw new TypeError(`readSource must return text for ${path}`);
      const digest = 'sha256:' + crypto.createHash('sha256').update(raw).digest('hex');
      if (meta.content_digest && meta.content_digest !== digest) throw new TypeError(`source digest mismatch for ${path}`);
      if (ref.content_digest && ref.content_digest !== digest) throw new TypeError(`source ref digest mismatch for ${path}`);
      const lines = raw.split(/\r?\n/);
      if (ref.end_line > lines.length) throw new RangeError(`source range exceeds file line count: ${path}`);
      return deepFreeze({
        kind: 'FILE_RANGE',
        path,
        start_line: ref.start_line,
        end_line: ref.end_line,
        content_digest: digest,
        text: lines.slice(ref.start_line - 1, ref.end_line).join('\n'),
        instruction_authority: false,
        trust_class: 'UNTRUSTED_REPOSITORY_DATA'
      });
    }
  });
}

function recordMap(items, keyFor) {
  const map = new Map();
  for (const item of items ?? []) {
    const key = keyFor(item);
    if (key == null) continue;
    const text = String(key);
    if (map.has(text)) throw new TypeError(`duplicate canonical source id: ${text}`);
    map.set(text, item);
  }
  return map;
}

function normalizeRepoPath(value) {
  const path = String(value ?? '').replaceAll('\\', '/').replace(/^\.\//, '');
  if (!path || path.startsWith('/') || /^[A-Za-z]:\//.test(path) || path.split('/').includes('..')) {
    throw new TypeError(`unsafe repository source path: ${value}`);
  }
  return path;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
