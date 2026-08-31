import { createFabricProvider, FabricProviderError } from './common.mjs';

function normalizeLanguage(value) {
  const v = String(value ?? '').trim().toUpperCase();
  if (v === 'JS') return 'JAVASCRIPT';
  if (v === 'TS') return 'TYPESCRIPT';
  if (v === 'C++') return 'CPP';
  if (v === 'C#') return 'CSHARP';
  return v || 'UNKNOWN';
}

function point(value) {
  if (!value || typeof value !== 'object') return null;
  const line = Number(value.row ?? value.line);
  const column = Number(value.column);
  if (!Number.isInteger(line) || !Number.isInteger(column) || line < 0 || column < 0) return null;
  return { line, column };
}

function byteRange(node) {
  const start = Number(node?.start_byte ?? node?.startIndex);
  const end = Number(node?.end_byte ?? node?.endIndex);
  if (Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end >= start) {
    return {
      start_byte: start,
      end_byte: end,
      byte_unit: 'UTF8_BYTES',
      byte_base: 0,
      end_semantics: 'HALF_OPEN',
      provider_coordinate_system: 'TREE_SITTER_BYTE_OFFSETS'
    };
  }
  const startPosition = point(node?.start_position ?? node?.startPosition);
  const endPosition = point(node?.end_position ?? node?.endPosition);
  if (!startPosition || !endPosition) return null;
  return {
    start: startPosition,
    end: endPosition,
    provider_coordinate_system: 'TREE_SITTER_POINT',
    line_base: 0,
    column_base: 0,
    column_unit: 'UTF8_BYTES',
    end_semantics: 'HALF_OPEN'
  };
}

function childrenOf(node) {
  const children = node?.named_children ?? node?.namedChildren ?? node?.children;
  return Array.isArray(children) ? children : [];
}

function isNamed(node) {
  if (typeof node?.named === 'boolean') return node.named;
  if (typeof node?.isNamed === 'boolean') return node.isNamed;
  return true;
}

function flatten(rootOrNodes) {
  const roots = Array.isArray(rootOrNodes) ? rootOrNodes : [rootOrNodes];
  const out = [];
  const visit = (node, ancestry, ordinal) => {
    if (!node || typeof node !== 'object') return;
    const type = String(node.type ?? node.kind ?? '').trim();
    if (!type) return;
    const currentPath = [...ancestry, `${type}[${ordinal}]`];
    if (isNamed(node)) out.push({ node, nodePath: currentPath.join('/') });
    const children = childrenOf(node);
    let namedOrdinal = 0;
    for (const child of children) {
      visit(child, currentPath, namedOrdinal);
      namedOrdinal += 1;
    }
  };
  roots.forEach((node, index) => visit(node, [], index));
  return out;
}

export function createTreeSitterSyntaxProvider({
  id = 'tree-sitter-syntax',
  version = 'adapter-v1',
  supportedLanguages,
  toolchainFingerprint
} = {}) {
  if (!Array.isArray(supportedLanguages) || supportedLanguages.length === 0) {
    throw new TypeError('Tree-sitter provider requires supportedLanguages');
  }
  if (typeof toolchainFingerprint !== 'string' || !toolchainFingerprint.trim()) {
    throw new TypeError('Tree-sitter provider requires an exact toolchainFingerprint');
  }

  let provider;
  provider = createFabricProvider({
    manifest: {
      id,
      version,
      supported_languages: supportedLanguages,
      capabilities: ['SYNTAX'],
      capability_contracts: [
        { capability: 'SYNTAX', authority_level: 'STRUCTURAL_EVIDENCE', support_status: 'AVAILABLE' }
      ],
      origin: 'EXTERNAL_DETERMINISTIC',
      authority_level: 'STRUCTURAL_EVIDENCE',
      required_tools: ['TREE_SITTER_RUNTIME_OR_NORMALIZED_TREE'],
      toolchain_fingerprint: toolchainFingerprint,
      source_range_support: true,
      semantic_identity_support: false,
      timeout_ms: 30000,
      resource_limits: { memory_mb: 512, cpu_seconds: 30 },
      cacheability: true,
      provenance: { engine: 'tree-sitter', semantic_resolution: false }
    },
    analyze: async (input, context) => {
      const file = String(input?.file ?? '').replaceAll('\\', '/');
      const language = normalizeLanguage(input?.language);
      const tree = input?.tree ?? input?.nodes;
      if (!file) throw new FabricProviderError('PARSE_FAILED', 'Tree-sitter input requires file');
      if (!tree) throw new FabricProviderError('PARSE_FAILED', 'Tree-sitter input requires tree or nodes');
      const nodes = flatten(tree);
      return nodes.map(({ node, nodePath }) => {
        const type = String(node.type ?? node.kind);
        const range = byteRange(node);
        return {
          provider_id: provider.manifest.id,
          provider_version: provider.manifest.version,
          snapshot: {
            repository_id: String(context.repositoryId ?? context.repository_id ?? ''),
            snapshot_id: String(context.snapshotId ?? context.snapshot_id ?? '')
          },
          capability: 'SYNTAX',
          observation_type: 'SYNTAX_NODE',
          subject: {
            kind: type,
            display_name: type,
            language
          },
          strength: 'STRUCTURAL',
          origin: 'EXTERNAL_DETERMINISTIC',
          provenance: {
            path: file,
            engine: 'tree-sitter',
            toolchain_fingerprint: provider.manifest.toolchain_fingerprint,
            semantic_resolution: false
          },
          source_file: file,
          ...(range ? { source_range: range } : {}),
          raw_provider_ref: { node_path: nodePath },
          provider_payload: {
            type,
            named: isNamed(node),
            child_count: childrenOf(node).length
          }
        };
      });
    }
  });
  return provider;
}
