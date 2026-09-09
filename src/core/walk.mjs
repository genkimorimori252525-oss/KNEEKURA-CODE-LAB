import fs from 'node:fs/promises';
import path from 'node:path';

const IGNORE = new Set([
  '.git','build','out','target','node_modules',
  '.gradle','.idea','.vscode','run'
]);
const ALLOWED = new Set([
  '.java','.js','.mjs','.cjs','.json','.toml','.gradle',
  '.kts','.properties','.mcmeta'
]);

export function isAnalyzableRepositoryPath(value) {
  if (typeof value !== 'string' || !value) return false;
  const normalized = value.replace(/\\/g, '/');
  const segments = normalized.split('/').filter(Boolean);
  if (!segments.length) return false;
  if (segments.some(segment => IGNORE.has(segment))) return false;

  const name = segments.at(-1);
  return ALLOWED.has(path.posix.extname(name)) ||
    name === 'mods.toml';
}

export async function walk(root) {
  const out = [];
  async function rec(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (e.isDirectory() && IGNORE.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await rec(full);
      } else if (
        e.isFile() &&
        isAnalyzableRepositoryPath(path.relative(root, full))
      ) {
        out.push(full);
      }
    }
  }
  await rec(root);
  return out;
}