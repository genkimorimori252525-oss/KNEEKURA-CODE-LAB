import fs from 'node:fs/promises';

// Future bridge for KNEEKURA-LAB JSONL traces. Keeps runtime facts separate from static facts.
export async function importRuntimeTrace(builder, file) {
  const text = await fs.readFile(file, 'utf8');
  let lineNo = 0;
  for (const line of text.split(/\r?\n/)) {
    lineNo++;
    if (!line.trim().startsWith('{')) continue;
    let j; try { j = JSON.parse(line); } catch { builder.diagnostic('warn','invalid runtime JSONL',{line:lineNo}); continue; }
    if (j.ch === 'meta' && Array.isArray(j.mods)) {
      for (const id of j.mods) builder.node('mod', String(id), { runtimeObserved: true });
    }
    if (j.ch === 'spawn' && j.type) {
      const e = builder.node('runtime_entity_type', String(j.type), { runtimeObserved: true });
      const runtime = builder.node('runtime', 'kneekura:trace', { label: 'KNEEKURA Runtime Trace' });
      builder.edge(runtime, e, 'OBSERVED_RUNTIME_ENTITY', { source:file, confidence:1, tick:j.t });
    }
  }
  builder.addAnalyzer('runtime-trace-adapter','v1');
}
