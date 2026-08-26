import fs from 'node:fs/promises';
import path from 'node:path';

export const PRIMARY_PLATFORM = Object.freeze({
  loader: 'forge',
  minecraftVersion: '1.20.1',
  forgeMajor: 47,
  forgeFamily: '47.x',
  javaMajor: 17,
  key: 'forge-1.20.1-47.x'
});

/**
 * Detect the repository's Minecraft/loader profile before semantic analysis.
 * Exact build metadata wins over broad mods.toml ranges.
 */
export async function detectPlatformProfile(builder, root, files) {
  const byBase = new Map();
  for (const file of files) {
    const rel = norm(path.relative(root, file));
    const base = path.basename(file);
    if (!byBase.has(base)) byBase.set(base, []);
    byBase.get(base).push({ file, rel });
  }

  const evidence = [];
  let props = {};
  let gradle = '';
  let mods = '';

  const propEntry = pickRootish(byBase.get('gradle.properties'));
  if (propEntry) {
    const text = await safeRead(propEntry.file);
    props = parseProperties(text);
    evidence.push({ rel: propEntry.rel, kind: 'gradle.properties' });
  }

  const gradleEntry = pickRootish([...(byBase.get('build.gradle') ?? []), ...(byBase.get('build.gradle.kts') ?? [])]);
  if (gradleEntry) {
    gradle = await safeRead(gradleEntry.file);
    evidence.push({ rel: gradleEntry.rel, kind: 'build.gradle' });
  }

  const modsEntry = pickRootish(byBase.get('mods.toml'));
  if (modsEntry) {
    mods = await safeRead(modsEntry.file);
    evidence.push({ rel: modsEntry.rel, kind: 'mods.toml' });
  }

  const forgeCoord = firstNonEmpty(
    props.forge_version,
    props.forgeVersion,
    directForgeCoordinate(gradle)
  );
  const parsedForge = parseForgeCoordinate(forgeCoord);

  const minecraftVersion = firstNonEmpty(
    props.mc_version,
    props.minecraft_version,
    props.minecraftVersion,
    parsedForge.minecraftVersion,
    mappingMinecraftVersion(gradle)
  );

  const forgeVersion = parsedForge.forgeVersion ?? bareForgeVersion(forgeCoord);
  const forgeMajor = forgeVersion ? Number(String(forgeVersion).split('.')[0]) : null;
  const forgeFamily = Number.isInteger(forgeMajor) ? `${forgeMajor}.x` : null;
  const javaMajor = parseJavaMajor(gradle);
  const mappings = parseMappings(gradle);

  const loader = detectLoader(gradle, mods, forgeCoord);
  const loaderVersionRange = matchQuoted(mods, /\bloaderVersion\s*=\s*["']([^"']+)["']/);
  const minecraftVersionRange = dependencyRange(mods, 'minecraft');
  const forgeVersionRange = dependencyRange(mods, 'forge');

  if (!loader && !minecraftVersion && !forgeCoord && !mods) return null;

  const compatibility = classifyCompatibility({ loader, minecraftVersion, forgeMajor });
  const exactPrimary = compatibility === 'PRIMARY_EXACT';
  const key = loader === 'forge'
    ? `forge-${minecraftVersion ?? 'unknown'}-${forgeFamily ?? 'unknown'}`
    : `${loader ?? 'unknown'}-${minecraftVersion ?? 'unknown'}`;

  const profile = builder.node('platform_profile', key, {
    label: loader === 'forge'
      ? `Forge ${minecraftVersion ?? '?'} / ${forgeFamily ?? '?'}`
      : `${loader ?? 'unknown'} ${minecraftVersion ?? '?'}`,
    loader: loader ?? 'unknown',
    minecraftVersion: minecraftVersion ?? null,
    forgeVersion: forgeVersion ?? null,
    forgeMajor,
    forgeFamily,
    javaMajor,
    mappings,
    loaderVersionRange,
    minecraftVersionRange,
    forgeVersionRange,
    compatibility,
    primaryTarget: exactPrimary,
    analyzerTarget: PRIMARY_PLATFORM.key,
    sourceEvidence: evidence.map(e => e.rel)
  });

  const target = builder.node('platform_target', PRIMARY_PLATFORM.key, {
    label: 'Primary: Forge 1.20.1 / 47.x',
    loader: PRIMARY_PLATFORM.loader,
    minecraftVersion: PRIMARY_PLATFORM.minecraftVersion,
    forgeMajor: PRIMARY_PLATFORM.forgeMajor,
    forgeFamily: PRIMARY_PLATFORM.forgeFamily,
    javaMajor: PRIMARY_PLATFORM.javaMajor,
    primary: true
  });

  builder.edge(profile, target,
    exactPrimary ? 'MATCHES_PRIMARY_PLATFORM' : 'ANALYZED_AGAINST_PRIMARY_PLATFORM',
    { source: 'platform-profile', confidence: exactPrimary ? 1 : 0.8, compatibility });

  for (const ev of evidence) {
    const file = builder.node('file', ev.rel, {
      label: path.basename(ev.rel),
      path: ev.rel,
      language: languageFor(ev.rel)
    });
    builder.edge(file, profile, 'DECLARES_PLATFORM_PROFILE', {
      source: ev.rel,
      confidence: 1,
      evidenceType: ev.kind
    });
  }

  builder.graph.meta.platform = {
    primaryTarget: { ...PRIMARY_PLATFORM },
    detected: {
      loader: loader ?? 'unknown',
      minecraftVersion: minecraftVersion ?? null,
      forgeVersion: forgeVersion ?? null,
      forgeMajor,
      forgeFamily,
      javaMajor,
      mappings,
      loaderVersionRange,
      minecraftVersionRange,
      forgeVersionRange
    },
    compatibility
  };
  builder.addAnalyzer('platform-profile', 'v1');
  return profile;
}

function classifyCompatibility({ loader, minecraftVersion, forgeMajor }) {
  if (loader === 'forge' && minecraftVersion === PRIMARY_PLATFORM.minecraftVersion && forgeMajor === PRIMARY_PLATFORM.forgeMajor) {
    return 'PRIMARY_EXACT';
  }
  if (loader === 'forge' && minecraftVersion === PRIMARY_PLATFORM.minecraftVersion && forgeMajor == null) {
    return 'PRIMARY_MC_MATCH';
  }
  if (loader === 'forge' && minecraftVersion?.startsWith('1.20.')) {
    return 'FORGE_1_20_BEST_EFFORT';
  }
  if (loader === 'forge') return 'FORGE_BEST_EFFORT';
  return 'UNRECOGNIZED_BEST_EFFORT';
}

function detectLoader(gradle, mods, forgeCoord) {
  if (/net\.minecraftforge(?:\.gradle|:forge)/.test(gradle) || /\bmodLoader\s*=\s*["']javafml["']/.test(mods) || forgeCoord) {
    return 'forge';
  }
  return null;
}

function parseForgeCoordinate(value) {
  if (!value) return { minecraftVersion: null, forgeVersion: null };
  const m = String(value).trim().match(/^(\d+\.\d+(?:\.\d+)?)-(\d+(?:\.\d+){1,3})$/);
  return m ? { minecraftVersion: m[1], forgeVersion: m[2] } : { minecraftVersion: null, forgeVersion: null };
}

function bareForgeVersion(value) {
  if (!value) return null;
  const s = String(value).trim();
  if (/^\d+(?:\.\d+){1,3}$/.test(s)) return s;
  return null;
}

function directForgeCoordinate(gradle) {
  return gradle.match(/net\.minecraftforge:forge:([^"'\s)]+)/)?.[1] ?? null;
}

function mappingMinecraftVersion(gradle) {
  const m = gradle.match(/mappings\s+channel\s*:\s*["'][^"']+["']\s*,\s*version\s*:\s*["']([^"']+)["']/);
  if (!m) return null;
  return m[1].match(/(\d+\.\d+(?:\.\d+)?)$/)?.[1] ?? null;
}

function parseMappings(gradle) {
  const m = gradle.match(/mappings\s+channel\s*:\s*["']([^"']+)["']\s*,\s*version\s*:\s*["']([^"']+)["']/);
  return m ? { channel: m[1], version: m[2] } : null;
}

function parseJavaMajor(gradle) {
  const direct = gradle.match(/JavaLanguageVersion\.of\s*\(\s*(\d+)\s*\)/)?.[1]
    ?? gradle.match(/sourceCompatibility\s*=\s*JavaVersion\.VERSION_(\d+)/)?.[1];
  return direct ? Number(direct) : null;
}

function dependencyRange(mods, modId) {
  const blocks = [...mods.matchAll(/\[\[dependencies\.([^\]]+)\]\]([\s\S]*?)(?=\[\[|$)/g)];
  for (const m of blocks) {
    const id = matchQuoted(m[2], /\bmodId\s*=\s*["']([^"']+)["']/);
    if (id !== modId) continue;
    return matchQuoted(m[2], /\bversionRange\s*=\s*["']([^"']+)["']/);
  }
  return null;
}

function parseProperties(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

function pickRootish(entries = []) {
  return [...entries].sort((a, b) => a.rel.split('/').length - b.rel.split('/').length)[0] ?? null;
}

function firstNonEmpty(...values) {
  return values.find(v => typeof v === 'string' && v.trim())?.trim() ?? null;
}

function matchQuoted(text, re) {
  return text.match(re)?.[1] ?? null;
}

async function safeRead(file) {
  try { return await fs.readFile(file, 'utf8'); }
  catch { return ''; }
}

function languageFor(rel) {
  if (rel.endsWith('.toml')) return 'toml';
  if (rel.endsWith('.properties')) return 'properties';
  if (rel.endsWith('.gradle') || rel.endsWith('.gradle.kts')) return 'gradle';
  return 'text';
}

function norm(s) { return s.replaceAll('\\', '/'); }
