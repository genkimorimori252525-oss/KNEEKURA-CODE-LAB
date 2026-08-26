import fs from 'node:fs/promises';

// Adapter contract only. CodeGraph itself is intentionally not vendored.
// Expected generic shape: {nodes:[...], edges:[...]}; unknown fields are preserved in raw.
export async function importCodeGraph(builder, file) {
  const j = JSON.parse(await fs.readFile(file, 'utf8'));
  const map = new Map();
  for (const n of j.nodes ?? []) {
    const kind = `codegraph:${n.kind ?? n.type ?? 'node'}`;
    const key = String(n.id ?? n.key ?? n.name ?? JSON.stringify(n).slice(0,80));
    const x = builder.node(kind, key, { label: n.name ?? n.label ?? key, imported: 'codegraph', raw: n });
    map.set(String(n.id ?? key), x);
  }
  for (const e of j.edges ?? []) {
    const a = map.get(String(e.from ?? e.source));
    const b = map.get(String(e.to ?? e.target));
    if (a && b) builder.edge(a,b,`CODEGRAPH_${String(e.type ?? 'REL').toUpperCase()}`,{ confidence: e.confidence ?? 0.9, raw:e });
  }
  builder.addAnalyzer('codegraph-adapter', 'v1');
}
