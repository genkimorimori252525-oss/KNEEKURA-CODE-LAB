import fs from 'node:fs/promises';
import path from 'node:path';

const MIXIN_INJECTORS = new Set([
  'Inject', 'Redirect', 'ModifyArg', 'ModifyArgs', 'ModifyVariable', 'ModifyConstant',
  'ModifyExpressionValue', 'ModifyReturnValue', 'WrapOperation', 'WrapWithCondition'
]);

export function analyzeForgeJava(builder, java) {
  const { classes, source, rel, fileNode } = java;
  const owner = classes[0] ?? fileNode;
  const annotations = scanTopLevelAnnotations(source);

  for (const m of source.matchAll(/@Mod\s*\(\s*(?:value\s*=\s*)?["']([^"']+)["']\s*\)/g)) {
    const mod = builder.node('mod', m[1], { label: m[1] });
    builder.edge(owner, mod, 'MOD_ENTRYPOINT', { source: rel, evidence: m[0] });
  }

  // @Mixin can contain arrays, value=, or targets="binary.Name". The old one-line regex
  // only handled @Mixin(Foo.class), which is too weak for real mod sources.
  for (const ann of annotations.filter(a => a.simpleName === 'Mixin')) {
    const targets = extractMixinTargets(ann.text);
    if (targets.length === 0) {
      const unresolved = builder.node('symbol', `unresolved-mixin:${rel}:${ann.start}`, {
        label: 'unresolved @Mixin target', external: true, unresolved: true
      });
      builder.edge(owner, unresolved, 'MIXES_INTO', {
        source: rel, evidence: compact(ann.text), confidence: 0.35
      });
    }
    for (const targetName of targets) {
      const target = builder.node('symbol', targetName, { external: true });
      builder.edge(owner, target, 'MIXES_INTO', {
        source: rel, evidence: compact(ann.text), confidence: 1
      });
    }
  }

  // Deep Mixin semantics: @Inject/@Redirect/@Modify* and common MixinExtras wrappers.
  // We deliberately preserve unresolved method/target text instead of inventing a resolved symbol.
  for (const ann of annotations.filter(a => MIXIN_INJECTORS.has(a.simpleName))) {
    const injectorOwner = findFollowingMethodNode(builder, java, ann) ?? owner;
    const methods = extractStringArgument(ann.text, 'method');
    const at = extractAt(ann.text);
    const targetKeys = at.target ? [at.target] : methods.length ? methods : [`unresolved:${rel}:${ann.start}`];

    for (const targetKey of targetKeys) {
      const target = builder.node('mixin_injection_target', targetKey, {
        label: targetKey,
        external: true,
        unresolved: targetKey.startsWith('unresolved:')
      });
      builder.edge(injectorOwner, target, 'INJECTS_AT', {
        source: rel,
        evidence: compact(ann.text),
        confidence: targetKey.startsWith('unresolved:') ? 0.4 : 1,
        injector: ann.simpleName,
        mixinMethods: methods,
        atValue: at.value ?? null,
        atTarget: at.target ?? null,
        ordinal: at.ordinal,
        shift: at.shift ?? null,
        cancellable: /\bcancellable\s*=\s*true\b/.test(ann.text)
      });
    }
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

function scanTopLevelAnnotations(source) {
  const out = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '"' || ch === "'") {
      i = skipQuoted(source, i, ch);
      continue;
    }
    if (ch !== '@') { i++; continue; }

    const start = i;
    i++;
    const nameStart = i;
    while (i < source.length && /[A-Za-z0-9_.$]/.test(source[i])) i++;
    if (i === nameStart) continue;
    const name = source.slice(nameStart, i);
    while (i < source.length && /\s/.test(source[i])) i++;
    if (source[i] === '(') i = consumeBalanced(source, i);
    const end = i;
    out.push({
      name,
      simpleName: name.split('.').at(-1),
      start,
      end,
      text: source.slice(start, end)
    });
  }
  return out;
}

function consumeBalanced(source, openIndex) {
  let depth = 0;
  let i = openIndex;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '"' || ch === "'") {
      i = skipQuoted(source, i, ch);
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return source.length;
}

function skipQuoted(source, start, quote) {
  let i = start + 1;
  while (i < source.length) {
    if (source[i] === '\\') { i += 2; continue; }
    if (source[i] === quote) return i + 1;
    i++;
  }
  return source.length;
}

function extractMixinTargets(text) {
  const targets = new Set();
  for (const m of text.matchAll(/\b([A-Za-z_$][\w.$]*)\s*\.class\b/g)) targets.add(m[1]);
  const targetArg = text.match(/\btargets\s*=\s*(\{[\s\S]*?\}|"(?:\\.|[^"\\])*")/);
  if (targetArg) {
    for (const value of extractQuoted(targetArg[1])) targets.add(value);
  }
  return [...targets];
}

function extractStringArgument(text, key) {
  const match = text.match(new RegExp(`\\b${key}\\s*=\\s*(\\{[\\s\\S]*?\\}|"(?:\\\\.|[^"\\\\])*")`));
  return match ? extractQuoted(match[1]) : [];
}

function extractQuoted(text) {
  const values = [];
  for (const m of text.matchAll(/"((?:\\.|[^"\\])*)"/g)) values.push(decodeQuoted(m[1]));
  return values;
}

function extractAt(text) {
  const atStart = text.search(/@(?:[\w.$]*\.)?At\s*\(/);
  if (atStart < 0) return { value: null, target: null, ordinal: null, shift: null };
  const open = text.indexOf('(', atStart);
  const end = consumeBalanced(text, open);
  const atText = text.slice(atStart, end);
  const value = atText.match(/\bvalue\s*=\s*"((?:\\.|[^"\\])*)"/)?.[1]
    ?? atText.match(/@(?:[\w.$]*\.)?At\s*\(\s*"((?:\\.|[^"\\])*)"/)?.[1]
    ?? null;
  const target = atText.match(/\btarget\s*=\s*"((?:\\.|[^"\\])*)"/)?.[1] ?? null;
  const ordinalText = atText.match(/\bordinal\s*=\s*(-?\d+)/)?.[1];
  const shift = atText.match(/\bshift\s*=\s*(?:At\.)?Shift\.([A-Z_]+)/)?.[1] ?? null;
  return {
    value: value ? decodeQuoted(value) : null,
    target: target ? decodeQuoted(target) : null,
    ordinal: ordinalText === undefined ? null : Number(ordinalText),
    shift
  };
}

function findFollowingMethodNode(builder, java, ann) {
  const tail = java.source.slice(ann.end, Math.min(java.source.length, ann.end + 1200));
  const match = tail.match(/(?:public\s+|protected\s+|private\s+|static\s+|final\s+|synchronized\s+|abstract\s+|default\s+|native\s+)*[\w.$<>\[\],?]+\s+(\w+)\s*\(/);
  if (!match) return null;
  return builder.graph.nodes.find(n => n.kind === 'method' && n.path === java.rel && n.label === match[1]) ?? null;
}

function decodeQuoted(value) {
  try { return JSON.parse(`"${value}"`); }
  catch { return value; }
}

function compact(s) { return String(s).replace(/\s+/g,' ').trim().slice(0,500); }
