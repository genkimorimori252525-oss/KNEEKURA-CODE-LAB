import { createFabricProvider, FabricProviderError } from './common.mjs';

const DEFINITION_ROLE = 0x1;

function pick(object, snake, camel = null) {
  if (!object || typeof object !== 'object') return undefined;
  if (Object.hasOwn(object, snake)) return object[snake];
  if (camel && Object.hasOwn(object, camel)) return object[camel];
  return undefined;
}

function upper(value) {
  return String(value ?? '').trim().toUpperCase();
}

function normalizeLanguage(value) {
  const v = upper(value);
  if (v === 'JAVASCRIPT' || v === 'JS') return 'JAVASCRIPT';
  if (v === 'TYPESCRIPT' || v === 'TS') return 'TYPESCRIPT';
  if (v === 'C++') return 'CPP';
  if (v === 'C#') return 'CSHARP';
  return v || 'UNKNOWN';
}

function documentPath(document) {
  const value = pick(document, 'relative_path', 'relativePath');
  if (typeof value !== 'string' || !value.trim()) throw new FabricProviderError('PARSE_FAILED', 'SCIP document is missing relative_path');
  return value.replaceAll('\\', '/');
}

function documentPositionEncoding(document) {
  const value = pick(document, 'position_encoding', 'positionEncoding');
  if (value == null) return null;
  if (typeof value === 'number') {
    if (value === 1) return 'UTF8_BYTES';
    if (value === 2) return 'UTF16_CODE_UNITS';
    if (value === 3) return 'UNICODE_CODE_POINTS';
    return null;
  }
  const v = upper(value);
  if (v.includes('UTF8')) return 'UTF8_BYTES';
  if (v.includes('UTF16')) return 'UTF16_CODE_UNITS';
  if (v.includes('UTF32')) return 'UNICODE_CODE_POINTS';
  return null;
}

function occurrenceRange(occurrence, columnUnit) {
  if (!columnUnit) return null;
  const single = pick(occurrence, 'single_line_range', 'singleLineRange');
  if (single && typeof single === 'object') {
    return {
      start: {
        line: Number(pick(single, 'start_line', 'startLine')),
        column: Number(pick(single, 'start_character', 'startCharacter'))
      },
      end: {
        line: Number(pick(single, 'start_line', 'startLine')),
        column: Number(pick(single, 'end_character', 'endCharacter'))
      },
      provider_coordinate_system: 'SCIP_POSITION_ENCODING',
      line_base: 0,
      column_base: 0,
      column_unit: columnUnit,
      end_semantics: 'HALF_OPEN'
    };
  }

  const multi = pick(occurrence, 'multi_line_range', 'multiLineRange');
  if (multi && typeof multi === 'object') {
    return {
      start: {
        line: Number(pick(multi, 'start_line', 'startLine')),
        column: Number(pick(multi, 'start_character', 'startCharacter'))
      },
      end: {
        line: Number(pick(multi, 'end_line', 'endLine')),
        column: Number(pick(multi, 'end_character', 'endCharacter'))
      },
      provider_coordinate_system: 'SCIP_POSITION_ENCODING',
      line_base: 0,
      column_base: 0,
      column_unit: columnUnit,
      end_semantics: 'HALF_OPEN'
    };
  }

  const deprecated = occurrence?.range;
  if (Array.isArray(deprecated) && (deprecated.length === 3 || deprecated.length === 4)) {
    const [startLine, startCharacter, third, fourth] = deprecated.map(Number);
    const endLine = deprecated.length === 3 ? startLine : third;
    const endCharacter = deprecated.length === 3 ? third : fourth;
    return {
      start: { line: startLine, column: startCharacter },
      end: { line: endLine, column: endCharacter },
      provider_coordinate_system: 'SCIP_DEPRECATED_RANGE',
      line_base: 0,
      column_base: 0,
      column_unit: columnUnit,
      end_semantics: 'HALF_OPEN'
    };
  }
  return null;
}

function externalSymbolSet(index) {
  return new Set((pick(index, 'external_symbols', 'externalSymbols') ?? [])
    .map(info => String(info?.symbol ?? ''))
    .filter(Boolean));
}

function definitionsBySymbol(index) {
  const map = new Map();
  for (const document of index.documents ?? []) {
    const path = documentPath(document);
    for (const occurrence of document.occurrences ?? []) {
      const symbol = String(occurrence?.symbol ?? '');
      const roles = Number(pick(occurrence, 'symbol_roles', 'symbolRoles') ?? 0);
      if (!symbol || (roles & DEFINITION_ROLE) === 0) continue;
      if (!map.has(symbol)) map.set(symbol, []);
      map.get(symbol).push(path);
    }
  }
  return map;
}

function semanticNamespace(toolName, symbol, path) {
  return symbol.startsWith('local ')
    ? `scip-local:${toolName}:${path}`
    : `scip:${toolName}`;
}

function subjectFor({ symbol, language, path, toolName }) {
  return {
    kind: 'scip_symbol',
    display_name: symbol,
    language,
    semantic_symbol_id: symbol,
    semantic_symbol_namespace: semanticNamespace(toolName, symbol, path)
  };
}

function provenanceFor(provider, input, toolInfo, path) {
  return {
    path,
    source_format: 'SCIP',
    tool_name: String(toolInfo?.name ?? 'unknown-scip-indexer'),
    tool_version: String(toolInfo?.version ?? ''),
    toolchain_fingerprint: provider.manifest.toolchain_fingerprint,
    ...(input?.artifactDigest ? { artifact_digest: String(input.artifactDigest) } : {})
  };
}

function makeObservation(provider, context, raw) {
  return {
    provider_id: provider.manifest.id,
    provider_version: provider.manifest.version,
    snapshot: {
      repository_id: String(context.repositoryId ?? context.repository_id ?? ''),
      snapshot_id: String(context.snapshotId ?? context.snapshot_id ?? '')
    },
    ...raw
  };
}

function relationBoolean(relation, snake, camel) {
  return Boolean(pick(relation, snake, camel));
}

export function createScipSemanticProvider({
  id = 'scip-semantic',
  version = 'adapter-v1',
  supportedLanguages = ['*'],
  toolchainFingerprint,
  expectedToolName = null,
  expectedToolVersion = null
} = {}) {
  if (typeof toolchainFingerprint !== 'string' || !toolchainFingerprint.trim()) {
    throw new TypeError('SCIP provider requires an exact toolchainFingerprint');
  }

  let provider;
  provider = createFabricProvider({
    manifest: {
      id,
      version,
      supported_languages: supportedLanguages,
      capabilities: ['SYMBOL', 'REFERENCE', 'CROSS_FILE_REFERENCE', 'TYPE', 'INHERITANCE'],
      capability_contracts: [
        { capability: 'SYMBOL', authority_level: 'RESOLVED_SEMANTIC_EVIDENCE', support_status: 'AVAILABLE' },
        { capability: 'REFERENCE', authority_level: 'RESOLVED_SEMANTIC_EVIDENCE', support_status: 'AVAILABLE' },
        { capability: 'CROSS_FILE_REFERENCE', authority_level: 'RESOLVED_SEMANTIC_EVIDENCE', support_status: 'AVAILABLE' },
        { capability: 'TYPE', authority_level: 'RESOLVED_SEMANTIC_EVIDENCE', support_status: 'PARTIAL', support_reason: 'Only explicit SCIP type-definition relationships are emitted.' },
        { capability: 'INHERITANCE', authority_level: 'RESOLVED_SEMANTIC_EVIDENCE', support_status: 'PARTIAL', support_reason: 'Only explicit SCIP implementation relationships are emitted.' }
      ],
      origin: 'EXTERNAL_DETERMINISTIC',
      authority_level: 'RESOLVED_SEMANTIC_EVIDENCE',
      required_tools: ['SCIP_INDEXER_OR_ARTIFACT'],
      toolchain_fingerprint: toolchainFingerprint,
      source_range_support: true,
      semantic_identity_support: true,
      timeout_ms: 120000,
      resource_limits: { memory_mb: 2048, cpu_seconds: 120 },
      cacheability: true,
      provenance: {
        format: 'SCIP',
        exact_toolchain_required: true,
        ...(expectedToolName ? { expected_tool_name: String(expectedToolName) } : {}),
        ...(expectedToolVersion ? { expected_tool_version: String(expectedToolVersion) } : {})
      }
    },
    analyze: async (input, context) => {
      const index = input?.index;
      if (!index || typeof index !== 'object' || !Array.isArray(index.documents)) {
        throw new FabricProviderError('PARSE_FAILED', 'SCIP input requires a decoded index with a documents array');
      }
      const toolInfo = pick(index.metadata ?? {}, 'tool_info', 'toolInfo') ?? {};
      const toolName = String(toolInfo?.name ?? 'unknown-scip-indexer');
      const toolVersion = String(toolInfo?.version ?? '');
      if (expectedToolName && toolName !== String(expectedToolName)) {
        throw new FabricProviderError('ANALYZER_TOOLCHAIN_MISMATCH', `SCIP indexer name ${toolName} does not match expected ${expectedToolName}`);
      }
      if (expectedToolVersion && toolVersion !== String(expectedToolVersion)) {
        throw new FabricProviderError('ANALYZER_TOOLCHAIN_MISMATCH', `SCIP indexer version ${toolVersion || '<missing>'} does not match expected ${expectedToolVersion}`);
      }
      const externalSymbols = externalSymbolSet(index);
      const definitions = definitionsBySymbol(index);
      const observations = [];

      for (const document of index.documents) {
        const path = documentPath(document);
        const language = normalizeLanguage(document.language);
        const columnUnit = documentPositionEncoding(document);
        for (const [occurrenceIndex, occurrence] of (document.occurrences ?? []).entries()) {
          const symbol = String(occurrence?.symbol ?? '');
          if (!symbol) continue;
          const roles = Number(pick(occurrence, 'symbol_roles', 'symbolRoles') ?? 0);
          const isDefinition = (roles & DEFINITION_ROLE) !== 0;
          const subject = subjectFor({ symbol, language, path, toolName });
          const sourceRange = occurrenceRange(occurrence, columnUnit);
          const provenance = provenanceFor(provider, input, toolInfo, path);
          const rawProviderRef = { document: path, occurrence_index: occurrenceIndex };
          const providerPayload = {
            symbol_roles: roles,
            syntax_kind: pick(occurrence, 'syntax_kind', 'syntaxKind') ?? null
          };

          observations.push(makeObservation(provider, context, {
            capability: isDefinition ? 'SYMBOL' : 'REFERENCE',
            observation_type: isDefinition ? 'SYMBOL_DEFINITION' : 'SYMBOL_REFERENCE',
            subject,
            strength: 'RESOLVED',
            origin: 'EXTERNAL_DETERMINISTIC',
            provenance,
            source_file: path,
            ...(sourceRange ? { source_range: sourceRange } : {}),
            raw_provider_ref: rawProviderRef,
            provider_payload: providerPayload
          }));

          if (!isDefinition) {
            const definitionPaths = definitions.get(symbol) ?? [];
            const crossFileTargets = definitionPaths.filter(target => target !== path);
            const external = definitionPaths.length === 0 && !symbol.startsWith('local ') && externalSymbols.has(symbol);
            if (crossFileTargets.length || external) {
              observations.push(makeObservation(provider, context, {
                capability: 'CROSS_FILE_REFERENCE',
                observation_type: 'CROSS_FILE_REFERENCE',
                subject,
                object: {
                  target_symbol: symbol,
                  target_files: [...new Set(crossFileTargets)].sort(),
                  external
                },
                strength: 'RESOLVED',
                origin: 'EXTERNAL_DETERMINISTIC',
                provenance,
                source_file: path,
                ...(sourceRange ? { source_range: sourceRange } : {}),
                raw_provider_ref: rawProviderRef,
                provider_payload: providerPayload
              }));
            }
          }
        }
      }

      for (const document of index.documents) {
        const path = documentPath(document);
        const language = normalizeLanguage(document.language);
        const provenance = provenanceFor(provider, input, toolInfo, path);
        for (const info of document.symbols ?? []) {
          const symbol = String(info?.symbol ?? '');
          if (!symbol) continue;
          const subject = subjectFor({ symbol, language, path, toolName });
          for (const [relationshipIndex, relation] of (info.relationships ?? []).entries()) {
            const target = String(relation?.symbol ?? '');
            if (!target) continue;
            const object = {
              kind: 'scip_symbol',
              display_name: target,
              language,
              semantic_symbol_id: target,
              semantic_symbol_namespace: semanticNamespace(toolName, target, path)
            };
            if (relationBoolean(relation, 'is_type_definition', 'isTypeDefinition')) {
              observations.push(makeObservation(provider, context, {
                capability: 'TYPE',
                observation_type: 'TYPE_DEFINITION_RELATION',
                subject,
                object,
                strength: 'RESOLVED',
                origin: 'EXTERNAL_DETERMINISTIC',
                provenance,
                raw_provider_ref: { document: path, symbol, relationship_index: relationshipIndex },
                provider_payload: structuredClone(relation)
              }));
            }
            if (relationBoolean(relation, 'is_implementation', 'isImplementation')) {
              observations.push(makeObservation(provider, context, {
                capability: 'INHERITANCE',
                observation_type: 'IMPLEMENTATION_RELATION',
                subject,
                object,
                strength: 'RESOLVED',
                origin: 'EXTERNAL_DETERMINISTIC',
                provenance,
                raw_provider_ref: { document: path, symbol, relationship_index: relationshipIndex },
                provider_payload: structuredClone(relation)
              }));
            }
          }
        }
      }

      return observations;
    }
  });
  return provider;
}
