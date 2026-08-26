import fs from 'node:fs/promises';
import path from 'node:path';

// Import Understand Anything structural/domain graphs without vendoring the project.
// Current graph shape: {version, project, nodes, edges, layers, tour}.
export async function importUnderstandAnything(builder, input) {
  const file = await resolveGraphFile(input);
  const j = JSON.parse(await fs.readFile(file, 'utf8'));
  const map = new Map();

  for (const n of j.nodes ?? []) {
    const sourceId = String(n.id ?? '');
    if (!sourceId) {
      builder.diagnostic('warn', 'Understand Anything node has no id', { source: file, raw: n });
      continue;
    }
    const kind = `ua:${n.type ?? 'node'}`;
    const key = sourceId;
    const node = builder.node(kind, key, {
      label: n.name ?? sourceId,
      imported: 'understand-anything',
      path: n.filePath,
      lineRange: n.lineRange,
      summary: n.summary,
      tags: n.tags,
      complexity: n.complexity,
      raw: n
    });
    map.set(sourceId, node);
  }

  for (const e of j.edges ?? []) {
    const a = map.get(String(e.source ?? e.from ?? ''));
    const b = map.get(String(e.target ?? e.to ?? ''));
    if (!a || !b) {
      builder.diagnostic('warn', 'Understand Anything edge references unknown node', { source: file, edge: e });
      continue;
    }
    const type = `UA_${String(e.type ?? 'related').toUpperCase().replace(/[^A-Z0-9_]+/g, '_')}`;
    const weight = Number(e.weight);
    builder.edge(a, b, type, {
      source: file,
      confidence: Number.isFinite(weight) ? Math.max(0, Math.min(1, weight)) : 0.9,
      direction: e.direction,
      raw: e
    });
  }

  const project = j.project ?? {};
  if (project.name) {
    const p = builder.node('ua:project', String(project.name), {
      label: project.name,
      imported: 'understand-anything',
      description: project.description,
      languages: project.languages,
      frameworks: project.frameworks,
      analyzedAt: project.analyzedAt,
      gitCommitHash: project.gitCommitHash
    });
    for (const n of map.values()) builder.edge(p, n, 'UA_CONTAINS', { source: file, confidence: 1 });
  }

  for (const layer of j.layers ?? []) {
    const ln = builder.node('ua:layer', String(layer.id ?? layer.name), {
      label: layer.name ?? layer.id,
      description: layer.description,
      imported: 'understand-anything'
    });
    for (const id of layer.nodeIds ?? []) {
      const n = map.get(String(id));
      if (n) builder.edge(ln, n, 'UA_LAYER_CONTAINS', { source: file, confidence: 1 });
    }
  }

  for (const step of j.tour ?? []) {
    const skey = `${project.name ?? 'project'}:${step.order ?? 0}:${step.title ?? 'step'}`;
    const sn = builder.node('ua:tour_step', skey, {
      label: step.title ?? `Step ${step.order ?? '?'}`,
      order: step.order,
      description: step.description,
      languageLesson: step.languageLesson,
      imported: 'understand-anything'
    });
    for (const id of step.nodeIds ?? []) {
      const n = map.get(String(id));
      if (n) builder.edge(sn, n, 'UA_TOUR_HIGHLIGHTS', { source: file, confidence: 1 });
    }
  }

  builder.addAnalyzer('understand-anything-adapter', String(j.version ?? 'v1'));
}

async function resolveGraphFile(input) {
  const p = path.resolve(input);
  const st = await fs.stat(p);
  if (st.isFile()) return p;
  const candidates = [
    path.join(p, '.understand-anything', 'knowledge-graph.json'),
    path.join(p, '.ua', 'knowledge-graph.json'),
    path.join(p, 'knowledge-graph.json')
  ];
  for (const c of candidates) {
    try { if ((await fs.stat(c)).isFile()) return c; } catch {}
  }
  throw new Error(`Understand Anything knowledge-graph.json not found under ${p}`);
}
