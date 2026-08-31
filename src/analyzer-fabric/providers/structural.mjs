import { createFabricProvider, FabricProviderError } from './common.mjs';

const ALLOWED_CAPABILITIES = new Set(['FRAMEWORK', 'CONFIG']);

function normalizeLanguage(value) {
  const v = String(value ?? '').trim().toUpperCase();
  if (v === 'JS') return 'JAVASCRIPT';
  if (v === 'TS') return 'TYPESCRIPT';
  if (v === 'C++') return 'CPP';
  if (v === 'C#') return 'CSHARP';
  return v || 'UNKNOWN';
}

function rangeFromAstGrep(match) {
  const byteOffset = match?.range?.byteOffset ?? match?.range?.byte_offset;
  if (byteOffset && Number.isInteger(byteOffset.start) && Number.isInteger(byteOffset.end)) {
    return {
      start_byte: byteOffset.start,
      end_byte: byteOffset.end,
      byte_unit: 'UTF8_BYTES',
      byte_base: 0,
      end_semantics: 'HALF_OPEN',
      provider_coordinate_system: 'AST_GREP_JSON_BYTE_OFFSET'
    };
  }
  const start = match?.range?.start;
  const end = match?.range?.end;
  if (start && end) {
    return {
      start: { line: Number(start.line), column: Number(start.column) },
      end: { line: Number(end.line), column: Number(end.column) },
      provider_coordinate_system: 'AST_GREP_JSON_LINE_COLUMN',
      line_base: 0,
      column_base: 0,
      column_unit: 'UTF8_BYTES',
      end_semantics: 'HALF_OPEN'
    };
  }
  return null;
}

export function createAstGrepStructuralProvider({
  id = 'ast-grep-structural',
  version = 'adapter-v1',
  supportedLanguages = ['*'],
  toolchainFingerprint,
  ruleCapabilities = {}
} = {}) {
  if (typeof toolchainFingerprint !== 'string' || !toolchainFingerprint.trim()) {
    throw new TypeError('ast-grep provider requires an exact toolchainFingerprint');
  }

  const normalizedRuleCapabilities = new Map();
  for (const [ruleId, capabilityValue] of Object.entries(ruleCapabilities)) {
    const capability = String(capabilityValue ?? '').trim().toUpperCase();
    if (!ALLOWED_CAPABILITIES.has(capability)) {
      throw new TypeError(`ast-grep rule ${ruleId} has unsupported capability ${capability}`);
    }
    normalizedRuleCapabilities.set(ruleId, capability);
  }

  let provider;
  provider = createFabricProvider({
    manifest: {
      id,
      version,
      supported_languages: supportedLanguages,
      capabilities: ['FRAMEWORK', 'CONFIG'],
      capability_contracts: [
        { capability: 'FRAMEWORK', authority_level: 'STRUCTURAL_EVIDENCE', support_status: 'PARTIAL', support_reason: 'Rule-driven structural evidence only; no semantic target resolution.' },
        { capability: 'CONFIG', authority_level: 'STRUCTURAL_EVIDENCE', support_status: 'PARTIAL', support_reason: 'Only explicitly configured structural rules may emit config evidence.' }
      ],
      origin: 'STRUCTURAL_RULE',
      authority_level: 'STRUCTURAL_EVIDENCE',
      required_tools: ['AST_GREP_CLI_OR_JSON'],
      toolchain_fingerprint: toolchainFingerprint,
      source_range_support: true,
      semantic_identity_support: false,
      timeout_ms: 30000,
      resource_limits: { memory_mb: 512, cpu_seconds: 30 },
      cacheability: true,
      provenance: { engine: 'ast-grep', semantic_resolution: false }
    },
    analyze: async (input, context) => {
      const matches = Array.isArray(input) ? input : input?.matches;
      if (!Array.isArray(matches)) throw new FabricProviderError('PARSE_FAILED', 'ast-grep input requires a matches array');

      const observations = [];
      for (const [index, match] of matches.entries()) {
        const file = String(match?.file ?? '').replaceAll('\\', '/');
        if (!file) throw new FabricProviderError('PARSE_FAILED', `ast-grep match ${index} is missing file`);
        const ruleId = String(match?.ruleId ?? match?.rule_id ?? match?.rule ?? '').trim();
        if (!ruleId) throw new FabricProviderError('PARSE_FAILED', `ast-grep match ${index} is missing rule id`);
        const capability = String(match?.capability ?? normalizedRuleCapabilities.get(ruleId) ?? '').trim().toUpperCase();
        if (!ALLOWED_CAPABILITIES.has(capability)) {
          throw new FabricProviderError('TRUST_BOUNDARY_VIOLATION', `ast-grep rule ${ruleId} is not authorized to emit ${capability || 'an unspecified capability'}`);
        }
        const language = normalizeLanguage(match?.language);
        const sourceRange = rangeFromAstGrep(match);
        const sourceText = context?.sourceTextByPath?.[file];
        const byteOffset = match?.range?.byteOffset ?? match?.range?.byte_offset;
        if (sourceText != null && typeof match?.text === 'string' && byteOffset && Number.isInteger(byteOffset.start) && Number.isInteger(byteOffset.end)) {
          const actual = Buffer.from(String(sourceText), 'utf8').subarray(byteOffset.start, byteOffset.end).toString('utf8');
          if (actual !== match.text) {
            throw new FabricProviderError('TRUST_BOUNDARY_VIOLATION', `ast-grep match ${index} byte range does not match match.text`);
          }
        }
        observations.push({
          provider_id: provider.manifest.id,
          provider_version: provider.manifest.version,
          snapshot: {
            repository_id: String(context.repositoryId ?? context.repository_id ?? ''),
            snapshot_id: String(context.snapshotId ?? context.snapshot_id ?? '')
          },
          capability,
          observation_type: capability === 'FRAMEWORK' ? 'STRUCTURAL_FRAMEWORK_MATCH' : 'STRUCTURAL_CONFIG_MATCH',
          subject: {
            kind: 'structural_match',
            display_name: ruleId,
            language
          },
          strength: match?.heuristic === true ? 'HEURISTIC' : 'STRUCTURAL',
          origin: 'STRUCTURAL_RULE',
          provenance: {
            path: file,
            engine: 'ast-grep',
            rule_id: ruleId,
            toolchain_fingerprint: provider.manifest.toolchain_fingerprint,
            semantic_resolution: false
          },
          source_file: file,
          ...(sourceRange ? { source_range: sourceRange } : {}),
          raw_provider_ref: { match_index: index, rule_id: ruleId },
          provider_payload: structuredClone(match)
        });
      }
      return observations;
    }
  });
  return provider;
}
