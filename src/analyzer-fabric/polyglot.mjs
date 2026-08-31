export const POLYGLOT_PROVIDER_CATALOG_SCHEMA = 'kneekura.polyglot-provider-catalog/v1';
export const POLYGLOT_PROVIDER_PLAN_SCHEMA = 'kneekura.polyglot-provider-plan/v1';

const SEMANTIC_CAPABILITIES = Object.freeze([
  'SYMBOL', 'REFERENCE', 'CROSS_FILE_REFERENCE', 'TYPE', 'INHERITANCE'
]);
const TS_COMPILER_CAPABILITIES = Object.freeze([
  'DECLARATION', 'SYMBOL', 'REFERENCE', 'CROSS_FILE_REFERENCE', 'CALL', 'TYPE', 'INHERITANCE'
]);

const RECOMMENDED_SCIP = Object.freeze({
  GO: descriptor('scip-go', ['GO']),
  TYPESCRIPT: descriptor('scip-typescript', ['TYPESCRIPT', 'JAVASCRIPT']),
  JAVASCRIPT: descriptor('scip-typescript', ['TYPESCRIPT', 'JAVASCRIPT']),
  C: descriptor('scip-clang', ['C', 'CPP']),
  CPP: descriptor('scip-clang', ['C', 'CPP']),
  JAVA: descriptor('scip-java', ['JAVA']),
  KOTLIN: descriptor('scip-java', ['KOTLIN'], { cross_repository: false }),
  SCALA: descriptor('scip-java', ['SCALA']),
  RUST: descriptor('rust-analyzer', ['RUST'], { adapter: 'scip-decoded-index', cross_repository: false }),
  PYTHON: descriptor('scip-python', ['PYTHON']),
  RUBY: descriptor('scip-ruby', ['RUBY']),
  CSHARP: descriptor('scip-dotnet', ['CSHARP', 'VISUAL_BASIC'], { cross_repository: false })
});

const SYNTAX_LANGUAGES = new Set([
  'JAVA','JAVASCRIPT','TYPESCRIPT','PYTHON','GO','RUST','C','CPP','CSHARP','KOTLIN','SCALA','RUBY','PHP',
  'SHELL','POWERSHELL','HTML','VUE','SVELTE','JSON','JSONC','YAML','TOML','XML','HCL','PROPERTIES','MARKDOWN','MDX',
  'GROOVY','DOCKERFILE','MAKE','CMAKE'
]);



export function createPolyglotProviderCatalog() {
  const maintained = [...Object.values(RECOMMENDED_SCIP)].sort((a, b) => compareText(`${a.provider_key}:${a.supported_languages.join(',')}`, `${b.provider_key}:${b.supported_languages.join(',')}`));
  return deepFreeze({
    schema: POLYGLOT_PROVIDER_CATALOG_SCHEMA,
    catalog_version: '2026-08-31',
    provenance: {
      authority: 'SOURCEGRAPH_RECOMMENDED_INDEXERS',
      reference: 'https://sourcegraph.com/docs/code-navigation/writing-an-indexer',
      status: 'GENERALLY_AVAILABLE_AT_CATALOG_VERSION'
    },
    maintained_precise_indexers: maintained.map(item => ({ ...item, language_profile: item.supported_languages.length === 1 ? item.supported_languages[0] : item.supported_languages.join('+') })),
    shared_adapters: [
      {
        provider_key: 'tree-sitter', adapter: 'tree-sitter-syntax', origin: 'MAINTAINED_OSS',
        authority_level: 'STRUCTURAL_EVIDENCE', capabilities: ['SYNTAX'], semantic_identity_support: false
      },
      {
        provider_key: 'ast-grep', adapter: 'ast-grep-structural', origin: 'MAINTAINED_OSS',
        authority_level: 'STRUCTURAL_EVIDENCE', capabilities: ['CONFIG','BUILD','FRAMEWORK'], semantic_identity_support: false
      }
    ],
    legacy_fallbacks: [
      { provider_key: 'builtin-java', adapter: 'legacy-core-provider', languages: ['JAVA'], role: 'LEXICAL_FALLBACK' },
      { provider_key: 'builtin-javascript', adapter: 'legacy-core-provider', languages: ['JAVASCRIPT'], role: 'LEXICAL_FALLBACK' },
      { provider_key: 'forge-semantics', adapter: 'legacy-core-provider', languages: ['JAVA'], role: 'DOMAIN_ENRICHMENT' },
      { provider_key: 'forge-1.20.1-network', adapter: 'legacy-core-provider', languages: ['JAVA'], role: 'DOMAIN_ENRICHMENT' },
      { provider_key: 'minecraft-ysm-semantics', adapter: 'legacy-core-provider', languages: ['JAVA'], role: 'DOMAIN_ENRICHMENT' },
      { provider_key: 'forge-mods-toml', adapter: 'legacy-core-provider', languages: ['TOML'], role: 'DOMAIN_ENRICHMENT' },
      { provider_key: 'minecraft-ysm-json', adapter: 'legacy-core-provider', languages: ['JSON'], role: 'DOMAIN_ENRICHMENT' }
    ],
    invariants: {
      provider_priority_decides_truth: false,
      scheduling_order_is_truth_order: false,
      missing_tool_means_absent: false,
      unavailable_provider_erases_other_evidence: false
    }
  });
}

export function buildPolyglotProviderPlan(profile, { toolAvailability = {} } = {}) {
  if (!profile || !Array.isArray(profile.files)) throw new TypeError('polyglot plan requires repository profile files');
  const forge = detectsForge(profile.files);
  const files = [...profile.files].sort((a, b) => compareText(a.path, b.path)).map(file => ({
    path: String(file.path),
    primary_language: file.primary_language ?? null,
    format: file.format ?? null,
    roles: [...(file.roles ?? [])].sort(compareText),
    tags: [...(file.tags ?? [])].sort(compareText),
    embedded_languages: [...(file.embedded_languages ?? [])].sort(compareText),
    strategies: strategiesFor(file, { forge, toolAvailability }).map((strategy, index) => deepFreeze({
      priority: index + 1,
      priority_semantics: 'SCHEDULING_ONLY',
      provider_priority_decides_truth: false,
      execution_status: 'UNEXPLORED',
      ...strategy
    }))
  }));
  return deepFreeze({
    schema: POLYGLOT_PROVIDER_PLAN_SCHEMA,
    repository: profile.repository ? structuredClone(profile.repository) : null,
    profile_schema: profile.schema ?? null,
    forge_context_detected: forge,
    files,
    summary: summarize(files),
    invariants: {
      provider_priority_decides_truth: false,
      last_writer_wins: false,
      missing_tool_means_absent: false,
      uncovered_capability_state: 'UNEXPLORED',
      legacy_domain_analyzers_can_promote_canonical_truth: false
    }
  });
}

function strategiesFor(file, context) {
  const language = String(file.primary_language ?? '').toUpperCase();
  const roles = new Set(file.roles ?? []);
  const out = [];

  if (roles.has('CONFIG') || roles.has('BUILD') || roles.has('STRUCTURED_DATA')) {
    out.push(strategy('ast-grep', 'ast-grep-structural', 'STRUCTURAL_CONFIG_OR_BUILD', 'STRUCTURAL_EVIDENCE',
      roles.has('BUILD') ? ['BUILD','CONFIG','FRAMEWORK'] : ['CONFIG','FRAMEWORK'], context.toolAvailability));
  }

  if (language === 'TYPESCRIPT' && roles.has('SOURCE')) {
    out.push(strategy('typescript-compiler-semantic', 'typescript-compiler', 'PRIMARY_COMPILER_SEMANTIC', 'RESOLVED_SEMANTIC_EVIDENCE', TS_COMPILER_CAPABILITIES, context.toolAvailability, { builtin: true }));
    out.push(maintainedStrategy(RECOMMENDED_SCIP.TYPESCRIPT, 'MAINTAINED_SEMANTIC_ALTERNATIVE', context.toolAvailability));
  } else if (RECOMMENDED_SCIP[language] && roles.has('SOURCE')) {
    out.push(maintainedStrategy(RECOMMENDED_SCIP[language], 'PRIMARY_MAINTAINED_SEMANTIC', context.toolAvailability));
  }

  if (SYNTAX_LANGUAGES.has(language) || (file.embedded_languages ?? []).length) {
    out.push(strategy('tree-sitter', 'tree-sitter-syntax', 'SYNTAX_FALLBACK', 'STRUCTURAL_EVIDENCE', ['SYNTAX'], context.toolAvailability));
  }

  if (roles.has('SOURCE')) {
    out.push(strategy('ast-grep', 'ast-grep-structural', 'STRUCTURAL_ENRICHMENT', 'STRUCTURAL_EVIDENCE', ['FRAMEWORK'], context.toolAvailability));
  }

  if (language === 'JAVA') {
    out.push(strategy('builtin-java', 'legacy-core-provider', 'LEXICAL_FALLBACK', 'STRUCTURAL_EVIDENCE', ['DECLARATION','REFERENCE','INHERITANCE'], context.toolAvailability, { builtin: true, bespoke_fallback: true }));
    if (context.forge) {
      out.push(strategy('forge-semantics', 'legacy-core-provider', 'DOMAIN_ENRICHMENT', 'STRUCTURAL_EVIDENCE', ['FRAMEWORK'], context.toolAvailability, { builtin: true, domain: 'FORGE' }));
      out.push(strategy('forge-1.20.1-network', 'legacy-core-provider', 'DOMAIN_ENRICHMENT', 'STRUCTURAL_EVIDENCE', ['FRAMEWORK'], context.toolAvailability, { builtin: true, domain: 'FORGE_NETWORK' }));
      out.push(strategy('minecraft-ysm-semantics', 'legacy-core-provider', 'DOMAIN_ENRICHMENT', 'STRUCTURAL_EVIDENCE', ['EMBEDDED_LANGUAGE','FRAMEWORK'], context.toolAvailability, { builtin: true, domain: 'MINECRAFT_YSM' }));
    }
  }
  if (language === 'JAVASCRIPT') {
    out.push(strategy('builtin-javascript', 'legacy-core-provider', 'LEXICAL_FALLBACK', 'STRUCTURAL_EVIDENCE', ['DECLARATION','REFERENCE'], context.toolAvailability, { builtin: true, bespoke_fallback: true }));
  }
  if (context.forge && String(file.path).toLowerCase().endsWith('mods.toml')) {
    out.push(strategy('forge-mods-toml', 'legacy-core-provider', 'DOMAIN_ENRICHMENT', 'STRUCTURAL_EVIDENCE', ['CONFIG','FRAMEWORK'], context.toolAvailability, { builtin: true, domain: 'FORGE' }));
  }
  if (context.forge && language === 'JSON' && /(?:ysm|animation|model)/i.test(String(file.path))) {
    out.push(strategy('minecraft-ysm-json', 'legacy-core-provider', 'DOMAIN_ENRICHMENT', 'STRUCTURAL_EVIDENCE', ['EMBEDDED_LANGUAGE','FRAMEWORK'], context.toolAvailability, { builtin: true, domain: 'MINECRAFT_YSM' }));
  }

  if (out.length === 0) {
    out.push({
      provider_key: 'no-maintained-provider-selected', adapter: null, role: 'EXPLICIT_UNEXPLORED_FALLBACK',
      origin: 'KNEEKURA_PLANNER', authority_level: 'NONE', capabilities: [], tool_status: 'UNEXPLORED',
      reason: 'No maintained or trusted adapter is selected for this file classification; do not infer absence.'
    });
  }
  return dedupe(out);
}

function maintainedStrategy(item, role, availability) {
  return strategy(item.provider_key, item.adapter, role, item.authority_level, item.capabilities, availability, {
    origin: item.origin, supported_languages: item.supported_languages, maintained_status: item.maintained_status,
    cross_repository: item.cross_repository, semantic_identity_support: item.semantic_identity_support, capability_contracts: item.capability_contracts
  });
}

function strategy(providerKey, adapter, role, authority, capabilities, availability, extra = {}) {
  const hasExplicit = Object.prototype.hasOwnProperty.call(availability, providerKey);
  const builtin = extra.builtin === true;
  const toolStatus = builtin ? 'AVAILABLE' : hasExplicit ? (availability[providerKey] ? 'AVAILABLE' : 'UNAVAILABLE') : 'UNEXPLORED';
  return {
    provider_key: providerKey,
    adapter,
    role,
    origin: extra.origin ?? (builtin ? 'KNEEKURA_BUILTIN' : 'MAINTAINED_OSS'),
    authority_level: authority,
    capabilities: [...capabilities],
    tool_status: toolStatus,
    semantic_identity_support: extra.semantic_identity_support ?? authority === 'RESOLVED_SEMANTIC_EVIDENCE',
    ...(extra.supported_languages ? { supported_languages: [...extra.supported_languages] } : {}),
    ...(extra.maintained_status ? { maintained_status: extra.maintained_status } : {}),
    ...(extra.cross_repository != null ? { cross_repository: extra.cross_repository } : {}),
    ...(extra.capability_contracts ? { capability_contracts: structuredClone(extra.capability_contracts) } : {}),
    ...(extra.bespoke_fallback ? { bespoke_fallback: true } : {}),
    ...(extra.domain ? { domain: extra.domain } : {})
  };
}

function descriptor(providerKey, languages, { adapter = 'scip-decoded-index', cross_repository = true } = {}) {
  return Object.freeze({
    provider_key: providerKey,
    adapter,
    origin: 'MAINTAINED_OSS',
    maintained_status: 'GENERALLY_AVAILABLE',
    supported_languages: Object.freeze([...languages]),
    authority_level: 'RESOLVED_SEMANTIC_EVIDENCE',
    capabilities: SEMANTIC_CAPABILITIES,
    capability_contracts: Object.freeze(SEMANTIC_CAPABILITIES.map(capability => Object.freeze({
      capability,
      support_status: ['TYPE','INHERITANCE'].includes(capability) ? 'PARTIAL' : 'AVAILABLE',
      authority_level: 'RESOLVED_SEMANTIC_EVIDENCE'
    }))),
    semantic_identity_support: true,
    cross_repository
  });
}

function detectsForge(files) {
  return files.some(file => (file.tags ?? []).includes('minecraft-forge') || String(file.path).toLowerCase().endsWith('mods.toml'));
}
function summarize(files) {
  const providers = new Set(), languages = new Set(), explicitUnexplored = [];
  for (const file of files) {
    if (file.primary_language) languages.add(file.primary_language);
    for (const s of file.strategies) providers.add(s.provider_key);
    if (file.strategies.some(s => s.role === 'EXPLICIT_UNEXPLORED_FALLBACK')) explicitUnexplored.push(file.path);
  }
  return { files: files.length, languages: [...languages].sort(compareText), provider_keys: [...providers].sort(compareText), explicit_unexplored_paths: explicitUnexplored.sort(compareText) };
}
function dedupe(items) { const out=[]; const seen=new Set(); for (const item of items) { const key = `${item.provider_key}\0${item.role}`; if (seen.has(key)) continue; seen.add(key); out.push(item); } return out; }
function compareText(a,b) { const left=String(a), right=String(b); return left < right ? -1 : left > right ? 1 : 0; }
function deepFreeze(value) { if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value; Object.freeze(value); for (const child of Object.values(value)) deepFreeze(child); return value; }
