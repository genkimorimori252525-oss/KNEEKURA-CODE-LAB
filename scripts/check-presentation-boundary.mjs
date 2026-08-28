import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.dirname(HERE);

const SOURCE_EXTENSIONS = new Set([
  '.js',
  '.mjs',
  '.cjs',
  '.jsx',
  '.ts',
  '.mts',
  '.cts',
  '.tsx'
]);

const FORBIDDEN_PACKAGE_RULES = [
  ['React', specifier =>
    specifier === 'react' ||
    specifier.startsWith('react/') ||
    specifier === 'react-dom' ||
    specifier.startsWith('react-dom/')],
  ['React Flow', specifier =>
    specifier === 'reactflow' ||
    specifier.startsWith('reactflow/') ||
    specifier === '@xyflow/react' ||
    specifier.startsWith('@xyflow/react/')],
  ['ELK', specifier =>
    specifier === 'elkjs' ||
    specifier.startsWith('elkjs/')],
  ['Dagre', specifier =>
    specifier === 'dagre' ||
    specifier.startsWith('dagre/') ||
    specifier === '@dagrejs/dagre' ||
    specifier.startsWith('@dagrejs/dagre/')],
  ['d3', specifier =>
    specifier === 'd3' ||
    specifier.startsWith('d3/') ||
    specifier.startsWith('d3-')],
  ['Archify', specifier =>
    specifier === 'archify' ||
    specifier.startsWith('archify/') ||
    specifier.startsWith('@archify/')],
  ['human-explorer', specifier =>
    specifier === 'human-explorer' ||
    specifier.startsWith('human-explorer/') ||
    specifier.startsWith('@kneekura/human-explorer')]
];

export async function auditCorePresentationBoundary({
  root = DEFAULT_ROOT,
  coreDir = path.join(root, 'src', 'core')
} = {}) {
  const repositoryRoot = path.resolve(root);
  const resolvedCore = path.resolve(coreDir);
  const forbiddenLocalRoots = [
    ['src/viewer', path.join(repositoryRoot, 'src', 'viewer')],
    ['src/presentation', path.join(repositoryRoot, 'src', 'presentation')],
    ['viewer', path.join(repositoryRoot, 'viewer')],
    ['packages/human-explorer',
      path.join(repositoryRoot, 'packages', 'human-explorer')],
    ['third_party', path.join(repositoryRoot, 'third_party')]
  ];

  const files = await listSourceFiles(resolvedCore);
  const violations = [];

  for (const file of files) {
    const source = await fs.readFile(file, 'utf8');
    const specifiers = extractModuleSpecifiers(source);

    for (const specifier of specifiers) {
      const packageViolation = forbiddenPackage(specifier);
      if (packageViolation) {
        violations.push({
          file: relative(repositoryRoot, file),
          specifier,
          reason:
            'CORE may not import Presentation/UI package: ' +
            packageViolation
        });
        continue;
      }

      const localViolation = forbiddenLocalTarget({
        importer: file,
        specifier,
        repositoryRoot,
        forbiddenLocalRoots
      });
      if (localViolation) {
        violations.push({
          file: relative(repositoryRoot, file),
          specifier,
          reason:
            'CORE may not import Presentation/UI path: ' +
            localViolation
        });
      }
    }
  }

  return violations.sort((a, b) =>
    (a.file + '\0' + a.specifier)
      .localeCompare(b.file + '\0' + b.specifier)
  );
}

export function extractModuleSpecifiers(source) {
  const found = new Set();
  const patterns = [
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bimport\s+[\s\S]*?\s+from\s+['"]([^'"]+)['"]/g,
    /\bexport\s+[\s\S]*?\s+from\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  ];

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      found.add(match[1]);
    }
  }
  return [...found];
}

function forbiddenPackage(specifier) {
  if (isLocalSpecifier(specifier)) return null;
  for (const [label, predicate] of FORBIDDEN_PACKAGE_RULES) {
    if (predicate(specifier)) return label;
  }
  return null;
}

function forbiddenLocalTarget({
  importer,
  specifier,
  repositoryRoot,
  forbiddenLocalRoots
}) {
  const normalized = normalizeSeparators(specifier);

  for (const [label] of forbiddenLocalRoots) {
    if (
      normalized === label ||
      normalized.startsWith(label + '/')
    ) {
      return label;
    }
  }

  if (!isLocalSpecifier(normalized)) return null;

  const target = normalized.startsWith('/')
    ? path.resolve(repositoryRoot, '.' + normalized)
    : path.resolve(
        path.dirname(importer),
        ...normalized.split('/').filter(Boolean)
      );

  for (const [label, forbiddenRoot] of forbiddenLocalRoots) {
    if (isWithin(target, forbiddenRoot)) return label;
  }
  return null;
}

function isLocalSpecifier(specifier) {
  const normalized = normalizeSeparators(specifier);
  return (
    normalized.startsWith('.') ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:\//.test(normalized)
  );
}

function isWithin(target, root) {
  const relativePath = path.relative(
    path.resolve(root),
    path.resolve(target)
  );
  return (
    relativePath === '' ||
    (
      !relativePath.startsWith('..' + path.sep) &&
      relativePath !== '..' &&
      !path.isAbsolute(relativePath)
    )
  );
}

async function listSourceFiles(root) {
  const files = [];

  async function visit(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }

    for (const entry of entries) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(target);
      } else if (
        entry.isFile() &&
        SOURCE_EXTENSIONS.has(path.extname(entry.name))
      ) {
        files.push(target);
      }
    }
  }

  await visit(root);
  return files.sort();
}

function normalizeSeparators(value) {
  return String(value)
    .split(String.fromCharCode(92))
    .join('/');
}

function relative(root, file) {
  return normalizeSeparators(path.relative(root, file));
}

async function main() {
  const violations = await auditCorePresentationBoundary();
  if (violations.length === 0) {
    console.log(
      'Human Presentation v2 boundary: PASS ' +
      '(src/core has no Presentation/UI imports)'
    );
    return;
  }

  console.error(
    'Human Presentation v2 boundary: FAIL (' +
    violations.length + ' violation(s))'
  );
  for (const violation of violations) {
    console.error(
      '- ' + violation.file + ': ' +
      JSON.stringify(violation.specifier) +
      ' — ' + violation.reason
    );
  }
  process.exitCode = 1;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
