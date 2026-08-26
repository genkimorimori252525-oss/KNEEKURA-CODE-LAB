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
 * Real-world contracts used by the analyzer:
 * - TouhouLittleMaid/Reimu code writes YSM Molang through sendSpellCardMolang("(v.foo = ...)")
 * - Java may explicitly dispatch YSM animation names through playReimuMaidAnimation / setPendingAnimationDispatch
 * - YSM animation/controller JSON consumes Molang variables in expression strings
 * - Bedrock/YSM geometry stores model hierarchy in minecraft:geometry[].bones[]
 * - YSM ysm.json manifests bind a pack to model / animation / texture resources
 *
 * Shared contract nodes (Molang variables, animation names, bone names) allow independently scanned
 * repositories to meet without inventing direct Java calls across mods.
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
  const geometries = Array.isArray(json['minecraft:geometry']) ? json['minecraft:geometry'] : [];
  const ysmManifest = path.posix.basename(rel).toLowerCase() === 'ysm.json' && isObject(json.files);
  const globalVariables = collectMolangVariables(json);

  if (!animations && !controllers && geometries.length === 0 && !ysmManifest && globalVariables.size === 0) return;

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
      linkAnimationBones(builder, def, body, rel);
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

  if (geometries.length > 0) {
    analyzeYsmGeometry(builder, fileNode, geometries, rel);
  }

  if (ysmManifest) {
    analyzeYsmManifest(builder, fileNode, json, rel);
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

function analyzeYsmGeometry(builder, fileNode, geometries, rel) {
  geometries.forEach((geometry, index) => {
    if (!isObject(geometry)) return;
    const description = isObject(geometry.description) ? geometry.description : {};
    const identifier = typeof description.identifier === 'string' && description.identifier
      ? description.identifier
      : `geometry[${index}]`;
    const modelKey = `${rel}#${identifier}`;
    const model = builder.node('model_definition', modelKey, {
      label: identifier,
      path: rel,
      identifier,
      ecosystem: 'ysm',
      textureWidth: numberOrNull(description.texture_width),
      textureHeight: numberOrNull(description.texture_height),
      visibleBoundsWidth: numberOrNull(description.visible_bounds_width),
      visibleBoundsHeight: numberOrNull(description.visible_bounds_height),
      visibleBoundsOffset: Array.isArray(description.visible_bounds_offset) ? description.visible_bounds_offset : null
    });
    builder.edge(fileNode, model, 'DECLARES_MODEL', { source: rel, confidence: 1 });

    const bones = Array.isArray(geometry.bones) ? geometry.bones.filter(isObject) : [];
    const boneByName = new Map();

    for (const bone of bones) {
      if (typeof bone.name !== 'string' || !bone.name) continue;
      const boneNode = builder.node('model_bone', `${modelKey}#bone:${bone.name}`, {
        label: bone.name,
        path: rel,
        model: identifier,
        bone: bone.name,
        parentBone: typeof bone.parent === 'string' ? bone.parent : null,
        pivot: Array.isArray(bone.pivot) ? bone.pivot : null,
        rotation: Array.isArray(bone.rotation) ? bone.rotation : null,
        cubeCount: Array.isArray(bone.cubes) ? bone.cubes.length : 0,
        locatorCount: isObject(bone.locators) ? Object.keys(bone.locators).length : 0,
        ecosystem: 'ysm'
      });
      boneByName.set(bone.name, boneNode);
      builder.edge(model, boneNode, 'HAS_BONE', { source: rel, confidence: 1 });

      const boneName = builder.node('bone_name', bone.name, { label: bone.name, ecosystem: 'ysm' });
      builder.edge(boneNode, boneName, 'PROVIDES_BONE_NAME', { source: rel, confidence: 1 });

      if (isObject(bone.locators)) {
        for (const [locatorName, locatorValue] of Object.entries(bone.locators)) {
          const locator = builder.node('model_locator', `${modelKey}#locator:${bone.name}:${locatorName}`, {
            label: locatorName,
            path: rel,
            model: identifier,
            bone: bone.name,
            locator: locatorName,
            value: locatorValue,
            ecosystem: 'ysm'
          });
          builder.edge(boneNode, locator, 'HAS_LOCATOR', { source: rel, confidence: 1 });
        }
      }
    }

    for (const bone of bones) {
      if (typeof bone.name !== 'string' || typeof bone.parent !== 'string' || !bone.parent) continue;
      const child = boneByName.get(bone.name);
      if (!child) continue;
      const parentBone = boneByName.get(bone.parent);
      if (parentBone) {
        builder.edge(child, parentBone, 'BONE_CHILD_OF', {
          source: rel,
          evidence: `parent=${bone.parent}`,
          confidence: 1
        });
      } else {
        const unresolved = builder.node('model_bone_reference', `${modelKey}#unresolved-parent:${bone.parent}`, {
          label: bone.parent,
          path: rel,
          model: identifier,
          bone: bone.parent,
          unresolved: true,
          ecosystem: 'ysm'
        });
        builder.edge(child, unresolved, 'BONE_CHILD_OF', {
          source: rel,
          evidence: `parent=${bone.parent}`,
          confidence: 0.4
        });
      }
    }
  });
}

function analyzeYsmManifest(builder, fileNode, json, rel) {
  const packName = typeof json.metadata?.name === 'string' && json.metadata.name
    ? json.metadata.name
    : path.posix.basename(path.posix.dirname(rel)) || 'YSM model pack';
  const pack = builder.node('ysm_model_pack', `${rel}#pack`, {
    label: packName,
    path: rel,
    spec: json.spec ?? null,
    ecosystem: 'ysm'
  });
  builder.edge(fileNode, pack, 'DECLARES_YSM_MODEL_PACK', { source: rel, confidence: 1 });

  walkYsmFileReferences(json.files, [], (keys, value) => {
    const classification = classifyYsmResource(keys);
    if (!classification) return;
    const targetPath = resolveYsmResourcePath(rel, value);
    if (!targetPath) return;

    if (classification.kind === 'directory') {
      const directory = builder.node('resource_directory', targetPath, {
        label: path.posix.basename(targetPath), path: targetPath, ecosystem: 'ysm', referenced: true
      });
      builder.edge(pack, directory, classification.edgeType, {
        source: rel, evidence: keys.join('.'), confidence: 1
      });
      return;
    }

    const targetFile = builder.node('file', targetPath, {
      label: path.posix.basename(targetPath), path: targetPath, referenced: true
    });
    builder.edge(pack, targetFile, classification.edgeType, {
      source: rel, evidence: keys.join('.'), confidence: 1
    });
  });
}

function linkAnimationBones(builder, owner, body, rel) {
  if (!isObject(body) || !isObject(body.bones)) return;
  for (const [bone, channels] of Object.entries(body.bones)) {
    const boneName = builder.node('bone_name', bone, { label: bone, ecosystem: 'ysm' });
    builder.edge(owner, boneName, 'ANIMATES_BONE', {
      source: rel,
      confidence: 1,
      channels: isObject(channels) ? Object.keys(channels) : []
    });
  }
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

function walkYsmFileReferences(value, keys, visit) {
  if (typeof value === 'string') {
    visit(keys, value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkYsmFileReferences(item, [...keys, String(index)], visit));
    return;
  }
  if (!isObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    walkYsmFileReferences(child, [...keys, key], visit);
  }
}

function classifyYsmResource(keys) {
  const normalized = keys.map(k => String(k).toLowerCase());
  const semanticKeys = normalized.filter(k => !/^\d+$/.test(k));
  const leaf = semanticKeys.at(-1) ?? '';
  if (leaf === 'match') return null;
  if (leaf === 'sound_path') return { edgeType: 'LOADS_SOUND_DIRECTORY', kind: 'directory' };
  if (semanticKeys.includes('animation_controllers') || semanticKeys.includes('animation_controller')) {
    return { edgeType: 'LOADS_ANIMATION_CONTROLLER_RESOURCE', kind: 'file' };
  }
  if (semanticKeys.includes('animation')) return { edgeType: 'LOADS_ANIMATION_RESOURCE', kind: 'file' };
  if (semanticKeys.includes('model')) return { edgeType: 'LOADS_MODEL_RESOURCE', kind: 'file' };
  if (semanticKeys.includes('texture')) return { edgeType: 'LOADS_TEXTURE_RESOURCE', kind: 'file' };
  return null;
}

function resolveYsmResourcePath(manifestRel, value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim().replaceAll('\\', '/');
  if (!raw || raw.startsWith('#') || /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return null;
  const safe = raw.replace(/^\/+/, '');
  return path.posix.normalize(path.posix.join(path.posix.dirname(manifestRel), safe));
}

function decodeJavaString(value) {
  try { return JSON.parse(`"${value}"`); }
  catch { return value.replaceAll('\\"', '"').replaceAll('\\\\', '\\'); }
}

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function compact(value) {
  return String(value).replace(/\s+/g, ' ').trim().slice(0, 500);
}
