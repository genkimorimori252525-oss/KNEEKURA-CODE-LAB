import fs from 'node:fs/promises';
import path from 'node:path';

const MOLANG_PREFIX = {
  v: 'variable', variable: 'variable',
  q: 'query', query: 'query',
  t: 'temp', temp: 'temp',
  c: 'context', context: 'context',
  ysm: 'ysm'
};

/**
 * Minecraft/YSM-specific relations that are not ordinary Java calls.
 *
 * Real-world contract used by the analyzer:
 * - TouhouLittleMaid/Reimu code writes YSM Molang through sendSpellCardMolang("(v.foo = ...)")
 * - Java may explicitly dispatch YSM animation names through playReimuMaidAnimation / setPendingAnimationDispatch
 * - YSM animation/controller JSON consumes Molang variables in expression strings
 *
 * Keeping the variable/name as a shared node lets independently scanned TLM and YSM graphs be
 * reconciled later without pretending we resolved a Java call that does not exist.
 */
export function analyzeMinecraftJavaBridge(builder, java) {
  const { classes, source, rel, fileNode } = java;
  const owner = classes[0] ?? fileNode;

  for (const call of source.matchAll(/\bsendSpellCardMolang\s*\(\s*"((?:\\.|[^"\\])*)"/g)) {
    const expression = decodeJavaString(call[1]);
    for (const variable of extractMolangVariables(expression)) {
      const node = builder.node('molang_variable', variable, { label: variable });
      builder.edge(owner, node, 'WRITES_MOLANG', {
        source: rel,
        evidence: compact(call[0]),
        confidence: 1
      });
    }
  }

  const animationCalls = [
    ['playReimuMaidAnimation', 'PLAYS_YSM_ANIMATION'],
    ['setPendingAnimationDispatch', 'DISPATCHES_YSM_ANIMATION']
  ];
  for (const [method, edgeType] of animationCalls) {
    const re = new RegExp(`\\b${method}\\s*\\(\\s*"((?:\\\\.|[^"\\\\])*)"`, 'g');
    for (const call of source.matchAll(re)) {
      const name = decodeJavaString(call[1]);
      if (!name) continue;
      const logical = builder.node('animation_name', name, { label: name, ecosystem: 'ysm' });
      builder.edge(owner, logical, edgeType, {
        source: rel,
        evidence: compact(call[0]),
        confidence: 1
      });
    }
  }
}

export async function analyzeMinecraftJson(builder, file, root) {
  const raw = await fs.readFile(file, 'utf8');
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    return;
  }

  const rel = path.relative(root, file).replaceAll('\\', '/');
  const animations = isObject(json.animations) ? json.animations : null;
  const controllers = isObject(json.animation_controllers) ? json.animation_controllers : null;
  const globalVariables = collectMolangVariables(json);

  if (!animations && !controllers && globalVariables.size === 0) return;

  const fileNode = builder.node('file', rel, {
    label: path.basename(file), path: rel, language: 'json'
  });

  if (animations) {
    for (const [name, body] of Object.entries(animations)) {
      const def = builder.node('animation_definition', `${rel}#${name}`, {
        label: name, path: rel, animation: name, ecosystem: 'ysm'
      });
      const logical = builder.node('animation_name', name, { label: name, ecosystem: 'ysm' });
      builder.edge(fileNode, def, 'DECLARES_ANIMATION', { source: rel, confidence: 1 });
      builder.edge(def, logical, 'PROVIDES_ANIMATION_NAME', { source: rel, confidence: 1 });
      linkMolangReads(builder, def, body, rel);
    }
  }

  if (controllers) {
    for (const [name, body] of Object.entries(controllers)) {
      const controller = builder.node('animation_controller', `${rel}#${name}`, {
        label: name, path: rel, controller: name, ecosystem: 'ysm'
      });
      builder.edge(fileNode, controller, 'DECLARES_ANIMATION_CONTROLLER', { source: rel, confidence: 1 });
      linkMolangReads(builder, controller, body, rel);
    }
  }

  // Expressions can also live outside an animation/controller body (for example model/config JSON).
  // Keep those facts attached to the file rather than guessing an owner.
  for (const variable of globalVariables) {
    const node = builder.node('molang_variable', variable, { label: variable });
    builder.edge(fileNode, node, 'READS_MOLANG', { source: rel, confidence: 1 });
  }
}

export function extractMolangVariables(value) {
  const found = new Set();
  if (typeof value !== 'string') return found;
  const re = /\b(v|variable|q|query|t|temp|c|context|ysm)\.([A-Za-z_][A-Za-z0-9_.]*)/g;
  for (const match of value.matchAll(re)) {
    const prefix = MOLANG_PREFIX[match[1]] ?? match[1];
    found.add(`${prefix}.${match[2]}`);
  }
  return found;
}

function linkMolangReads(builder, owner, body, rel) {
  for (const variable of collectMolangVariables(body)) {
    const node = builder.node('molang_variable', variable, { label: variable });
    builder.edge(owner, node, 'READS_MOLANG', { source: rel, confidence: 1 });
  }
}

function collectMolangVariables(value, out = new Set()) {
  if (typeof value === 'string') {
    for (const variable of extractMolangVariables(value)) out.add(variable);
  } else if (Array.isArray(value)) {
    for (const item of value) collectMolangVariables(item, out);
  } else if (isObject(value)) {
    for (const item of Object.values(value)) collectMolangVariables(item, out);
  }
  return out;
}

function decodeJavaString(value) {
  try { return JSON.parse(`"${value}"`); }
  catch { return value.replaceAll('\\"', '"').replaceAll('\\\\', '\\'); }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function compact(value) {
  return String(value).replace(/\s+/g, ' ').trim().slice(0, 500);
}
