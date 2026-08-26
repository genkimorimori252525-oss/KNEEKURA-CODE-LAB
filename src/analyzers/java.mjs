import fs from 'node:fs/promises';
import path from 'node:path';

function clean(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
}

export async function analyzeJava(builder, file, root) {
  const raw = await fs.readFile(file, 'utf8');
  const src = clean(raw);
  const rel = path.relative(root, file).replaceAll('\\','/');
  const f = builder.node('file', rel, { label: path.basename(file), path: rel, language: 'java' });

  const pkg = src.match(/\bpackage\s+([\w.]+)\s*;/)?.[1];
  let pkgNode = null;
  if (pkg) {
    pkgNode = builder.node('package', pkg);
    builder.edge(f, pkgNode, 'DECLARES_IN_PACKAGE', { source: rel });
  }

  for (const m of src.matchAll(/\bimport\s+(?:static\s+)?([\w.*]+)\s*;/g)) {
    const target = builder.node('symbol', m[1], { external: true });
    builder.edge(f, target, 'IMPORTS', { source: rel, evidence: m[0] });
  }

  const classes = [];
  const classRe = /((?:@[\w.$]+(?:\([^\n]*\))?\s*)*)(?:public\s+|protected\s+|private\s+|abstract\s+|final\s+|static\s+)*(class|interface|enum|record)\s+([\w$]+)(?:\s+extends\s+([\w.$<>]+))?(?:\s+implements\s+([^\{]+))?/g;
  for (const m of src.matchAll(classRe)) {
    const qn = pkg ? `${pkg}.${m[3]}` : m[3];
    const c = builder.node('class', qn, { label: m[3], classType: m[2], path: rel, annotations: [...m[1].matchAll(/@([\w.$]+)/g)].map(x=>x[1]) });
    classes.push(c);
    builder.edge(f, c, 'DECLARES', { source: rel });
    if (pkgNode) builder.edge(pkgNode, c, 'CONTAINS', { source: rel });
    if (m[4]) builder.edge(c, builder.node('symbol', stripGeneric(m[4]), { external: true }), 'EXTENDS', { source: rel });
    if (m[5]) for (const it of m[5].split(',').map(x=>stripGeneric(x.trim())).filter(Boolean)) builder.edge(c, builder.node('symbol', it, { external: true }), 'IMPLEMENTS', { source: rel });
  }

  const owner = classes[0] ?? f;
  const methodRe = /((?:@[\w.$]+(?:\([^\n]*\))?\s*)*)(?:public\s+|protected\s+|private\s+|static\s+|final\s+|synchronized\s+|abstract\s+|default\s+)*(?:[\w.$<>\[\],?]+\s+)+([\w$]+)\s*\(([^;{}]*)\)\s*(?:throws\s+[^\{]+)?\{/g;
  for (const m of src.matchAll(methodRe)) {
    if (['if','for','while','switch','catch'].includes(m[2])) continue;
    const mk = `${owner.key}#${m[2]}(${m[3].split(',').filter(x=>x.trim()).length})`;
    const method = builder.node('method', mk, { label: m[2], path: rel, annotations: [...m[1].matchAll(/@([\w.$]+)/g)].map(x=>x[1]) });
    builder.edge(owner, method, 'DECLARES_METHOD', { source: rel });
  }

  return { fileNode: f, classes, source: src, rel };
}

function stripGeneric(s='') { return s.replace(/<.*>/g,'').trim(); }
