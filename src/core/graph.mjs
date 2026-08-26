import crypto from 'node:crypto';

export function stableId(kind, key) {
  const h = crypto.createHash('sha1').update(`${kind}\0${key}`).digest('hex').slice(0, 12);
  return `${kind}:${h}`;
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
