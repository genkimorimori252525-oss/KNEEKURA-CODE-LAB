import fs from 'node:fs/promises';
import path from 'node:path';

export function analyzeForgeJava(builder, java) {
  const { classes, source, rel, fileNode } = java;
  const owner = classes[0] ?? fileNode;

  for (const m of source.matchAll(/@Mod\s*\(\s*(?:value\s*=\s*)?["']([^"']+)["']\s*\)/g)) {
    const mod = builder.node('mod', m[1], { label: m[1] });
    builder.edge(owner, mod, 'MOD_ENTRYPOINT', { source: rel, evidence: m[0] });
  }
  for (const m of source.matchAll(/@Mixin\s*\(\s*([\w.$]+)(?:\.class)?/g)) {
    const target = builder.node('symbol', m[1], { external: true });
    builder.edge(owner, target, 'MIXES_INTO', { source: rel, evidence: m[0] });
  }
  if (/@SubscribeEvent\b/.test(source)) {
    for (const method of builder.graph.nodes.filter(n => n.kind === 'method' && n.path === rel && (n.annotations||[]).some(a=>a.endsWith('SubscribeEvent')))) {
      const bus = builder.node('runtime', 'forge:event_bus', { label: 'Forge EventBus' });
      builder.edge(method, bus, 'SUBSCRIBES_EVENT', { source: rel, evidence: '@SubscribeEvent' });
    }
  }

  for (const m of source.matchAll(/DeferredRegister\s*\.\s*create\s*\(\s*([^,]+),\s*([^)]+)\)/g)) {
    const registry = builder.node('registry', compact(m[1]), { label: compact(m[1]) });
    builder.edge(owner, registry, 'CREATES_DEFERRED_REGISTER', { source: rel, evidence: m[0] });
  }

  for (const m of source.matchAll(/(?:new\s+)?ResourceLocation\s*\(\s*["']([^"']+)["']\s*,\s*["']([^"']+)["']\s*\)/g)) {
    const res = builder.node('resource', `${m[1]}:${m[2]}`);
    builder.edge(owner, res, 'REFERENCES_RESOURCE', { source: rel, evidence: m[0] });
  }
  for (const m of source.matchAll(/ResourceLocation\s*\.\s*(?:fromNamespaceAndPath|tryBuild)\s*\(\s*["']([^"']+)["']\s*,\s*["']([^"']+)["']/g)) {
    const res = builder.node('resource', `${m[1]}:${m[2]}`);
    builder.edge(owner, res, 'REFERENCES_RESOURCE', { source: rel, evidence: m[0] });
  }

  for (const m of source.matchAll(/BuiltInRegistries\.([A-Z0-9_]+)/g)) {
    const r = builder.node('registry', `minecraft:${m[1].toLowerCase()}`, { label: m[1] });
    builder.edge(owner, r, 'ACCESSES_REGISTRY', { source: rel, evidence: m[0] });
  }
}

export async function analyzeModsToml(builder, file, root) {
  const src = await fs.readFile(file, 'utf8');
  const rel = path.relative(root, file).replaceAll('\\','/');
  const f = builder.node('file', rel, { label: path.basename(file), path: rel, language: 'toml' });
  for (const m of src.matchAll(/\bmodId\s*=\s*["']([^"']+)["']/g)) {
    const mod = builder.node('mod', m[1]);
    builder.edge(f, mod, 'DECLARES_MOD', { source: rel, evidence: m[0] });
  }
  const depBlock = /\[\[dependencies\.([^\]]+)\]\]([\s\S]*?)(?=\[\[|$)/g;
  for (const m of src.matchAll(depBlock)) {
    const from = builder.node('mod', m[1]);
    const dep = m[2].match(/\bmodId\s*=\s*["']([^"']+)["']/)?.[1];
    if (!dep) continue;
    const mandatory = m[2].match(/\bmandatory\s*=\s*(true|false)/)?.[1] !== 'false';
    const to = builder.node('mod', dep, { external: true });
    builder.edge(from, to, mandatory ? 'DEPENDS_MOD' : 'OPTIONAL_MOD', { source: rel, confidence: 1 });
  }
}

function compact(s) { return s.replace(/\s+/g,' ').trim().slice(0,120); }
