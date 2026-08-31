import path from 'node:path';
import { createHash } from 'node:crypto';

export function normalizeRepoPath(rootDirectory, fileName) {
  const root = path.resolve(rootDirectory);
  const absolute = path.resolve(fileName);
  const relative = path.relative(root, absolute).replaceAll('\\', '/');
  if (!relative || relative === '.' || relative.startsWith('../') || path.isAbsolute(relative)) return null;
  if (relative.split('/').includes('node_modules')) return null;
  return relative;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sourceRange(text, startUtf16, endUtf16) {
  return {
    start_byte: Buffer.byteLength(text.slice(0, startUtf16), 'utf8'),
    end_byte: Buffer.byteLength(text.slice(0, endUtf16), 'utf8'),
    byte_unit: 'UTF8_BYTES',
    byte_base: 0,
    end_semantics: 'HALF_OPEN',
    provider_coordinate_system: 'TYPESCRIPT_UTF16_SOURCE_POSITIONS'
  };
}

export function isDeclarationName(ts, node) {
  const parent = node?.parent;
  if (!parent) return false;
  if (parent.name === node) {
    return ts.isClassDeclaration(parent) ||
      ts.isInterfaceDeclaration(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isTypeAliasDeclaration(parent) ||
      ts.isEnumDeclaration(parent) ||
      ts.isEnumMember(parent) ||
      ts.isModuleDeclaration(parent) ||
      ts.isBindingElement(parent);
  }
  return false;
}

export function symbolAt(checker, ts, node) {
  let symbol = checker.getSymbolAtLocation(node) ?? null;
  if (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    try { symbol = checker.getAliasedSymbol(symbol); } catch { /* preserve original alias */ }
  }
  return symbol;
}

export function firstRepositoryDeclaration(symbol, rootDirectory) {
  for (const declaration of symbol?.declarations ?? []) {
    const sourceFile = declaration.getSourceFile?.();
    if (!sourceFile) continue;
    const relative = normalizeRepoPath(rootDirectory, sourceFile.fileName);
    if (relative) return { declaration, sourceFile, relative };
  }
  return null;
}

export function declarationIdentity(ts, symbol, declarationInfo, rootDirectory) {
  const { declaration, sourceFile, relative } = declarationInfo;
  const nameNode = declaration.name ?? declaration;
  const start = nameNode.getStart(sourceFile, false);
  const end = nameNode.getEnd();
  const escapedName = String(symbol?.escapedName ?? symbol?.name ?? nameNode.getText(sourceFile));
  const basis = `${relative}\0${start}\0${end}\0${ts.SyntaxKind[declaration.kind] ?? declaration.kind}\0${escapedName}`;
  return {
    semantic_symbol_id: `tsdecl:sha256:${sha256(basis)}`,
    semantic_symbol_namespace: 'typescript-compiler:repository-local',
    declaration_path: relative,
    declaration_start_utf16: start,
    declaration_end_utf16: end,
    display_name: escapedName
  };
}

export function isDirectCallTarget(ts, node) {
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isCallExpression(parent) && parent.expression === node) return true;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node && ts.isCallExpression(parent.parent) && parent.parent.expression === parent) return true;
  return false;
}

export function isTypeUse(ts, node) {
  const parent = node.parent;
  return Boolean(parent && (
    (ts.isTypeReferenceNode(parent) && parent.typeName === node) ||
    (ts.isExpressionWithTypeArguments(parent) && parent.expression === node)
  ));
}

export function isHeritageUse(ts, node) {
  let current = node.parent;
  while (current && !ts.isHeritageClause(current) && !ts.isSourceFile(current)) current = current.parent;
  return Boolean(current && ts.isHeritageClause(current));
}

export function makeRawObservation(provider, context, {
  capability,
  observationType,
  sourceFile,
  sourceText,
  node,
  identity,
  target = null,
  strength = 'RESOLVED',
  syntaxKind,
  tsconfigPath
}) {
  const start = node.getStart(sourceFile, false);
  const end = node.getEnd();
  return {
    provider_id: provider.manifest.id,
    provider_version: provider.manifest.version,
    snapshot: {
      repository_id: String(context.repositoryId ?? context.repository_id ?? ''),
      snapshot_id: String(context.snapshotId ?? context.snapshot_id ?? '')
    },
    capability,
    observation_type: observationType,
    subject: {
      kind: 'typescript_symbol',
      display_name: identity.display_name,
      language: sourceFile.fileName.endsWith('.tsx') ? 'TYPESCRIPT' : 'TYPESCRIPT',
      semantic_symbol_id: identity.semantic_symbol_id,
      semantic_symbol_namespace: identity.semantic_symbol_namespace
    },
    ...(target ? { object: target } : {}),
    strength,
    origin: 'EXTERNAL_DETERMINISTIC',
    provenance: {
      path: normalizeRepoPath(context.rootDirectory ?? context.root_directory, sourceFile.fileName),
      engine: 'typescript-compiler-api',
      typescript_version: String(context.typescriptVersion ?? ''),
      toolchain_fingerprint: provider.manifest.toolchain_fingerprint,
      tsconfig_path: tsconfigPath,
      semantic_resolution: true
    },
    source_file: normalizeRepoPath(context.rootDirectory ?? context.root_directory, sourceFile.fileName),
    source_range: sourceRange(sourceText, start, end),
    raw_provider_ref: {
      syntax_kind: syntaxKind,
      utf16_start: start,
      utf16_end: end
    },
    provider_payload: {
      declaration_path: identity.declaration_path,
      declaration_start_utf16: identity.declaration_start_utf16,
      declaration_end_utf16: identity.declaration_end_utf16
    }
  };
}

