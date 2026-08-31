import { createFabricProvider } from './common.mjs';
import { analyzeTypeScriptProgram } from './typescript-compiler-analyze.mjs';

export function createTypeScriptCompilerProvider({
  typescript,
  id = 'typescript-compiler-semantic',
  version = 'adapter-v1',
  expectedTypeScriptVersion = null,
  toolchainFingerprint = null
} = {}) {
  if (!typescript || typeof typescript.createProgram !== 'function') {
    throw new TypeError('TypeScript compiler provider requires a TypeScript compiler API object');
  }
  const tsVersion = String(typescript.version ?? 'unknown');
  const fingerprint = toolchainFingerprint ?? `typescript@${expectedTypeScriptVersion ?? tsVersion}`;
  let provider;
  provider = createFabricProvider({
    manifest: {
      id,
      version,
      supported_languages: ['TYPESCRIPT'],
      capabilities: ['DECLARATION','SYMBOL','REFERENCE','CROSS_FILE_REFERENCE','CALL','TYPE','INHERITANCE'],
      capability_contracts: [
        { capability: 'DECLARATION', authority_level: 'RESOLVED_SEMANTIC_EVIDENCE', support_status: 'PARTIAL', support_reason: 'Named compiler-bound repository declarations only; anonymous and unsupported declaration forms remain uncovered.' },
        { capability: 'SYMBOL', authority_level: 'RESOLVED_SEMANTIC_EVIDENCE', support_status: 'PARTIAL', support_reason: 'Repository-local compiler-resolved named symbols only; external and unresolved symbols remain outside canonical identity.' },
        { capability: 'REFERENCE', authority_level: 'RESOLVED_SEMANTIC_EVIDENCE', support_status: 'PARTIAL', support_reason: 'Compiler-resolved repository-local identifier references only; unresolved/external references are not promoted.' },
        { capability: 'CROSS_FILE_REFERENCE', authority_level: 'RESOLVED_SEMANTIC_EVIDENCE', support_status: 'PARTIAL', support_reason: 'Resolved repository-local cross-file references only; external package targets remain uncovered.' },
        { capability: 'CALL', authority_level: 'RESOLVED_SEMANTIC_EVIDENCE', support_status: 'PARTIAL', support_reason: 'Only direct compiler-resolved identifier/member calls are emitted.' },
        { capability: 'TYPE', authority_level: 'RESOLVED_SEMANTIC_EVIDENCE', support_status: 'PARTIAL', support_reason: 'Only explicit compiler-resolved type-name uses are emitted.' },
        { capability: 'INHERITANCE', authority_level: 'RESOLVED_SEMANTIC_EVIDENCE', support_status: 'PARTIAL', support_reason: 'Only explicit heritage-clause symbol uses are emitted.' }
      ],
      origin: 'EXTERNAL_DETERMINISTIC',
      authority_level: 'RESOLVED_SEMANTIC_EVIDENCE',
      required_tools: ['TYPESCRIPT_COMPILER_API'],
      toolchain_fingerprint: fingerprint,
      source_range_support: true,
      semantic_identity_support: true,
      timeout_ms: 120000,
      resource_limits: { memory_mb: 2048, cpu_seconds: 120 },
      cacheability: true,
      provenance: {
        engine: 'typescript-compiler-api',
        expected_typescript_version: String(expectedTypeScriptVersion ?? tsVersion),
        repository_local_semantic_identity_only: true
      }
    },
    analyze: async (input, context) => analyzeTypeScriptProgram({ typescript, provider, input, context, expectedTypeScriptVersion, tsVersion })

  });
  return provider;
}
