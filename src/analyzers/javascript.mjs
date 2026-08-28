import fs from 'node:fs/promises';
import path from 'node:path';

const JS_EXTENSIONS = Object.freeze([
  '.js',
  '.mjs',
  '.cjs'
]);

export async function analyzeJavaScript(
  builder,
  file,
  root
) {
  const raw = await fs.readFile(file, 'utf8');
  const src = stripComments(raw);
  const rel = normalizePath(path.relative(root, file));
  const moduleType =
    file.endsWith('.mjs')
      ? 'esm'
      : file.endsWith('.cjs')
        ? 'commonjs'
        : null;

  const fileNode = builder.node('file', rel, {
    label: path.basename(file),
    path: rel,
    language: 'javascript',
    ...(moduleType ? { moduleType } : {})
  });

  const imports = [];
  const exports = new Set();

  await collectImports({
    builder,
    root,
    file,
    rel,
    src,
    fileNode,
    imports
  });

  const classes = [];
  for (const match of src.matchAll(
    /\b(export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)(?:\s+extends\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*))?/g
  )) {
    const name = match[2];
    const classNode = builder.node(
      'class',
      rel + '#' + name,
      {
        label: name,
        path: rel,
        language: 'javascript',
        exported: Boolean(match[1]),
        line: lineAt(src, match.index)
      }
    );
    classes.push(classNode);
    builder.edge(fileNode, classNode, 'DECLARES', {
      source: rel
    });

    if (match[3]) {
      const base = builder.node(
        'symbol',
        match[3],
        { external: true }
      );
      builder.edge(classNode, base, 'EXTENDS', {
        source: rel,
        evidence: match[0]
      });
    }

    if (match[1]) exports.add(name);
  }

  const functions = [];
  for (const match of src.matchAll(
    /\b(export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s+([A-Za-z_$][\w$]*)\s*\(/g
  )) {
    const name = match[2];
    const fn = functionNode(
      builder,
      fileNode,
      rel,
      name,
      lineAt(src, match.index),
      Boolean(match[1]),
      'declaration'
    );
    functions.push(fn);
    if (match[1]) exports.add(name);
  }

  for (const match of src.matchAll(
    /\b(export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:(?:async\s*)?(?:\([^;{}]*?\)|[A-Za-z_$][\w$]*)\s*=>|(?:async\s+)?function\b)/g
  )) {
    const name = match[2];
    const key = rel + '#' + name;
    if (functions.some(node => node.key === key)) {
      if (match[1]) {
        const existing = functions.find(node => node.key === key);
        existing.exported = true;
        exports.add(name);
      }
      continue;
    }

    const fn = functionNode(
      builder,
      fileNode,
      rel,
      name,
      lineAt(src, match.index),
      Boolean(match[1]),
      'binding'
    );
    functions.push(fn);
    if (match[1]) exports.add(name);
  }

  for (const match of src.matchAll(
    /\bexport\s*\{([^}]+)\}/g
  )) {
    for (const rawItem of match[1].split(',')) {
      const item = rawItem.trim();
      if (!item) continue;
      const parts = item.split(/\s+as\s+/i);
      const exportedName = (parts[1] ?? parts[0]).trim();
      if (/^[A-Za-z_$][\w$]*$/.test(exportedName)) {
        exports.add(exportedName);
      }
    }
  }

  if (/\bexport\s+default\b/.test(src)) {
    exports.add('default');
  }

  fileNode.exports = [...exports].sort();

  return {
    fileNode,
    classes,
    functions,
    imports,
    source: src,
    rel
  };
}

async function collectImports({
  builder,
  root,
  file,
  rel,
  src,
  fileNode,
  imports
}) {
  const seen = new Set();

  const patterns = [
    {
      type: 'IMPORTS',
      re: /\bimport\s+(?:[^'";]*?\s+from\s+)?(['"])([^'"]+)\1/g
    },
    {
      type: 'REEXPORTS',
      re: /\bexport\s+(?:\*|\{[^}]*\})\s+from\s+(['"])([^'"]+)\1/g
    },
    {
      type: 'DYNAMIC_IMPORTS',
      re: /\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g
    },
    {
      type: 'REQUIRES',
      re: /\brequire\s*\(\s*(['"])([^'"]+)\1\s*\)/g
    }
  ];

  for (const pattern of patterns) {
    for (const match of src.matchAll(pattern.re)) {
      const specifier = match[2];
      const dedupeKey =
        pattern.type + '\0' + specifier + '\0' + match.index;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const resolved =
        await resolveRepositoryModule(
          root,
          file,
          specifier
        );
      const target = resolved
        ? builder.node('file', resolved, {
            label: path.posix.basename(resolved),
            path: resolved,
            language: 'javascript'
          })
        : builder.node('module', specifier, {
            label: specifier,
            external: true
          });

      builder.edge(
        fileNode,
        target,
        pattern.type,
        {
          source: rel,
          evidence: match[0],
          specifier
        }
      );

      imports.push({
        type: pattern.type,
        specifier,
        target: target.key,
        resolved: Boolean(resolved)
      });
    }
  }
}

async function resolveRepositoryModule(
  root,
  fromFile,
  specifier
) {
  if (
    typeof specifier !== 'string' ||
    !specifier.startsWith('.')
  ) {
    return null;
  }

  const absoluteRoot = path.resolve(root);
  const base = path.resolve(
    path.dirname(fromFile),
    specifier
  );

  const candidates = [
    base,
    ...JS_EXTENSIONS.map(ext => base + ext),
    ...JS_EXTENSIONS.map(ext =>
      path.join(base, 'index' + ext)
    )
  ];

  for (const candidate of candidates) {
    const relative = path.relative(
      absoluteRoot,
      candidate
    );
    if (
      !relative ||
      relative.startsWith('..') ||
      path.isAbsolute(relative)
    ) {
      continue;
    }

    try {
      const stat = await fs.stat(candidate);
      if (!stat.isFile()) continue;
      return normalizePath(relative);
    } catch {
      // Try the next deterministic candidate.
    }
  }

  return null;
}

function functionNode(
  builder,
  fileNode,
  rel,
  name,
  line,
  exported,
  declarationKind
) {
  const node = builder.node(
    'function',
    rel + '#' + name,
    {
      label: name,
      path: rel,
      language: 'javascript',
      line,
      exported,
      declarationKind
    }
  );
  builder.edge(fileNode, node, 'DECLARES_FUNCTION', {
    source: rel
  });
  return node;
}

function lineAt(source, index) {
  if (!Number.isInteger(index) || index <= 0) {
    return 1;
  }
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (source.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

function normalizePath(value) {
  return String(value).replaceAll('\\', '/');
}

function stripComments(source) {
  let out = '';
  let state = 'code';
  let escaped = false;
  const templateExpressionDepth = [];

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];

    if (state === 'line-comment') {
      if (ch === '\n') {
        out += '\n';
        state = 'code';
      } else {
        out += ' ';
      }
      continue;
    }

    if (state === 'block-comment') {
      if (ch === '*' && next === '/') {
        out += '  ';
        i += 1;
        state = 'code';
      } else {
        out += ch === '\n' ? '\n' : ' ';
      }
      continue;
    }

    if (
      state === 'single' ||
      state === 'double'
    ) {
      out += ch;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (
        (state === 'single' && ch === "'") ||
        (state === 'double' && ch === '"')
      ) {
        state = 'code';
      }
      continue;
    }

    if (state === 'template') {
      if (escaped) {
        out += ch === '\n' ? '\n' : ' ';
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        out += ' ';
        escaped = true;
        continue;
      }
      if (ch === '`') {
        out += ' ';
        state = 'code';
        continue;
      }
      if (ch === '$' && next === '{') {
        out += '  ';
        i += 1;
        templateExpressionDepth.push(1);
        state = 'code';
        continue;
      }

      // Template raw text is data, not JavaScript code.
      out += ch === '\n' ? '\n' : ' ';
      continue;
    }

    if (ch === '/' && next === '/') {
      out += '  ';
      i += 1;
      state = 'line-comment';
      continue;
    }
    if (ch === '/' && next === '*') {
      out += '  ';
      i += 1;
      state = 'block-comment';
      continue;
    }
    if (ch === "'") {
      state = 'single';
      out += ch;
      continue;
    }
    if (ch === '"') {
      state = 'double';
      out += ch;
      continue;
    }
    if (ch === '`') {
      state = 'template';
      out += ' ';
      continue;
    }

    if (templateExpressionDepth.length) {
      const index = templateExpressionDepth.length - 1;
      if (ch === '{') {
        templateExpressionDepth[index] += 1;
      } else if (ch === '}') {
        templateExpressionDepth[index] -= 1;
        out += ch;
        if (templateExpressionDepth[index] === 0) {
          templateExpressionDepth.pop();
          state = 'template';
        }
        continue;
      }
    }

    out += ch;
  }

  return out;
}

