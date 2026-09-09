import crypto from 'node:crypto';

export function stableId(kind, key) {
  const h = crypto.createHash('sha1').update(`${kind}\0${key}`).digest('hex').slice(0, 12);
  return `${kind}:${h}`;
}

/**
 * Return the graph view that is safe to treat as canonical input.
 *
 * Raw GraphBuilder output intentionally retains execution metadata such as
 * generatedAt and the local checkout root for diagnostics/self-audit. Those
 * values are not properties of a pinned Git commit, so a COMMIT snapshot must
 * exclude them before digest-protected Evidence Pack / Explorer identities are
 * derived. WORKSPACE graphs remain verbatim because their local root and
 * generation context are part of the live workspace observation.
 */
export function canonicalizeGraphForSnapshot(graph) {
  if (!graph || typeof graph !== 'object' || Array.isArray(graph)) {
    throw new TypeError('graph must be an object');
  }
  const clone = structuredClone(graph);
  if (clone.meta?.snapshot?.kind !== 'COMMIT') return clone;

  delete clone.generatedAt;
  delete clone.root;

  if (Array.isArray(clone.nodes)) {
    clone.nodes.sort((a, b) => compareText(a?.id, b?.id));
  }
  if (Array.isArray(clone.edges)) {
    clone.edges.sort((a, b) => compareText(a?.id, b?.id));
  }
  if (Array.isArray(clone.diagnostics)) {
    clone.diagnostics.sort((a, b) => compareText(stableText(a), stableText(b)));
  }
  if (Array.isArray(clone.meta?.analyzers)) {
    clone.meta.analyzers.sort((a, b) =>
      compareText(a?.name, b?.name) || compareText(a?.version, b?.version)
    );
  }
  if (Array.isArray(clone.meta?.evidence)) {
    clone.meta.evidence.sort((a, b) =>
      compareText(a?.id ?? stableText(a), b?.id ?? stableText(b))
    );
  }
  return clone;
}

export class GraphBuilder {
  constructor(root) {
    this.graph = {
      schema: 'kneekura.graph/v1',
      generatedAt: new Date().toISOString(),
      root,
      nodes: [], edges: [], diagnostics: [], meta: { analyzers: [] }
    };
    this.nodeByKey = new Map();
    this.edgeKeys = new Set();
  }

  addAnalyzer(name, version = 'builtin') {
    this.graph.meta.analyzers.push({ name, version });
  }

  node(kind, key, data = {}) {
    const mapKey = `${kind}\0${key}`;
    const existing = this.nodeByKey.get(mapKey);
    if (existing) {
      Object.assign(existing, data);
      return existing;
    }
    const n = { id: stableId(kind, key), kind, key, label: data.label ?? key, ...data };
    this.nodeByKey.set(mapKey, n);
    this.graph.nodes.push(n);
    return n;
  }

  edge(from, to, type, data = {}) {
    if (!from || !to) return null;
    const key = `${from.id}\0${to.id}\0${type}\0${data.source ?? ''}`;
    if (this.edgeKeys.has(key)) return null;
    this.edgeKeys.add(key);
    const e = { id: stableId('edge', key), from: from.id, to: to.id, type, confidence: data.confidence ?? 1, ...data };
    this.graph.edges.push(e);
    return e;
  }

  diagnostic(level, message, data = {}) {
    this.graph.diagnostics.push({ level, message, ...data });
  }

  finish() {
    const counts = {};
    for (const n of this.graph.nodes) counts[n.kind] = (counts[n.kind] || 0) + 1;
    this.graph.meta.counts = counts;
    this.graph.meta.edgeCount = this.graph.edges.length;
    return this.graph;
  }
}

function stableText(value) {
  if (Array.isArray(value)) return '[' + value.map(stableText).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key =>
      JSON.stringify(key) + ':' + stableText(value[key])
    ).join(',') + '}';
  }
  return JSON.stringify(value);
}

function compareText(a, b) {
  const left = String(a ?? '');
  const right = String(b ?? '');
  return left < right ? -1 : left > right ? 1 : 0;
}