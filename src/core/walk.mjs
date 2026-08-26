import fs from 'node:fs/promises';
import path from 'node:path';

const IGNORE = new Set(['.git','build','out','target','node_modules','.gradle','.idea','.vscode','run']);
const ALLOWED = new Set(['.java','.json','.toml','.gradle','.kts','.properties','.mcmeta']);

export async function walk(root) {
  const out = [];
  async function rec(dir) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      if (e.isDirectory() && IGNORE.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await rec(full);
      else if (e.isFile() && (ALLOWED.has(path.extname(e.name)) || e.name === 'mods.toml')) out.push(full);
    }
  }
  await rec(root);
  return out;
}
