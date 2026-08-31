import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

export const REPOSITORY_CAPABILITY_PROFILE_SCHEMA = 'kneekura.repository-capability-profile/v1';
export const CAPABILITY_COVERAGE_SCHEMA = 'kneekura.capability-coverage/v1';

export const FABRIC_CAPABILITIES = Object.freeze([
  'SYNTAX',
  'DECLARATION',
  'SYMBOL',
  'REFERENCE',
  'CROSS_FILE_REFERENCE',
  'CALL',
  'TYPE',
  'INHERITANCE',
  'CONFIG',
  'BUILD',
  'EMBEDDED_LANGUAGE',
  'FRAMEWORK',
  'RUNTIME',
  'AI_SEMANTIC'
]);

const SUPPORT_STATUSES = new Set(['AVAILABLE', 'PARTIAL', 'NONE']);
const EXECUTION_STATUSES = new Set(['ANALYZED', 'PARTIAL', 'FAILED', 'UNEXPLORED', 'SKIPPED']);

const MANIFEST_REQUIRED_FIELDS = Object.freeze([
  'id', 'version', 'supported_languages', 'capabilities', 'capability_contracts', 'origin',
  'authority_level', 'required_tools', 'toolchain_fingerprint', 'source_range_support',
  'semantic_identity_support', 'timeout_ms', 'resource_limits', 'cacheability', 'provenance'
]);

const IGNORED_DIRECTORIES = new Set([
  '.git', 'node_modules', 'build', 'out', 'target', '.gradle', '.idea', '.vscode',
  'run', 'dist', 'coverage', '.next', '.turbo', '.cache'
]);

const SOURCE_EXTENSIONS = new Map([
  ['.java', ['JAVA', null]],
  ['.js', ['JAVASCRIPT', null]],
  ['.mjs', ['JAVASCRIPT', 'ESM']],
  ['.cjs', ['JAVASCRIPT', 'COMMONJS']],
  ['.jsx', ['JAVASCRIPT', 'JSX']],
  ['.ts', ['TYPESCRIPT', null]],
  ['.tsx', ['TYPESCRIPT', 'TSX']],
  ['.py', ['PYTHON', null]],
  ['.go', ['GO', null]],
  ['.rs', ['RUST', null]],
  ['.c', ['C', null]],
  ['.h', ['C', 'HEADER']],
  ['.cc', ['CPP', null]],
  ['.cpp', ['CPP', null]],
  ['.cxx', ['CPP', null]],
  ['.hpp', ['CPP', 'HEADER']],
  ['.cs', ['CSHARP', null]],
  ['.kt', ['KOTLIN', null]],
  ['.kts', ['KOTLIN', 'SCRIPT']],
  ['.scala', ['SCALA', null]],
  ['.rb', ['RUBY', null]],
  ['.php', ['PHP', null]],
  ['.sh', ['SHELL', null]],
  ['.bash', ['SHELL', 'BASH']],
  ['.zsh', ['SHELL', 'ZSH']],
  ['.ps1', ['POWERSHELL', null]],
  ['.html', ['HTML', null]],
  ['.htm', ['HTML', null]],
  ['.vue', ['VUE', null]],
  ['.svelte', ['SVELTE', null]]
]);

const STRUCTURED_FORMATS = new Map([
  ['.json', 'JSON'], ['.jsonc', 'JSONC'], ['.yaml', 'YAML'], ['.yml', 'YAML'],
  ['.toml', 'TOML'], ['.xml', 'XML'], ['.hcl', 'HCL'], ['.properties', 'PROPERTIES'],
  ['.mcmeta', 'JSON'], ['.md', 'MARKDOWN'], ['.mdx', 'MDX']
]);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function upper(value) {
  return String(value ?? '').trim().toUpperCase();
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean))].sort();
}

function stringList(value, { uppercase = false } = {}) {
  if (!Array.isArray(value)) return [];
  return uniqueSorted(value.map(item => uppercase ? upper(item) : String(item ?? '').trim()));
}

function normalizeRelativePath(value) {
  const raw = String(value ?? '').replaceAll('\\', '/');
  const normalized = path.posix.normalize(raw).replace(/^\.\//, '');
  if (!normalized || normalized === '.' || normalized.startsWith('/') || normalized === '..' || normalized.startsWith('../')) {
    throw new TypeError(`unsafe repository-relative path: ${value}`);
  }
  return normalized;
}

function specialClassification(relativePath) {
  const p = relativePath.toLowerCase();
  const base = path.posix.basename(p);

  if (base === 'dockerfile' || base.startsWith('dockerfile.')) {
    return { roles: ['BUILD'], primary_language: 'DOCKERFILE', format: 'DOCKERFILE', tags: ['container-build'] };
  }
  if (base === 'makefile' || base === 'gnumakefile') {
    return { roles: ['BUILD'], primary_language: 'MAKE', format: 'MAKEFILE', tags: ['build'] };
  }
  if (base === 'cmakelists.txt' || p.endsWith('.cmake')) {
    return { roles: ['BUILD'], primary_language: 'CMAKE', format: 'CMAKE', tags: ['build'] };
  }

  const exact = new Map([
    ['package.json', ['JSON', ['CONFIG', 'BUILD'], ['node-package']]],
    ['package-lock.json', ['JSON', ['BUILD'], ['node-lockfile']]],
    ['pnpm-lock.yaml', ['YAML', ['BUILD'], ['node-lockfile']]],
    ['yarn.lock', ['YARN_LOCK', ['BUILD'], ['node-lockfile']]],
    ['tsconfig.json', ['JSON', ['CONFIG', 'BUILD'], ['typescript-config']]],
    ['jsconfig.json', ['JSON', ['CONFIG', 'BUILD'], ['javascript-config']]],
    ['cargo.toml', ['TOML', ['CONFIG', 'BUILD'], ['rust-package']]],
    ['cargo.lock', ['TOML', ['BUILD'], ['rust-lockfile']]],
    ['go.mod', ['GOMOD', ['CONFIG', 'BUILD'], ['go-module']]],
    ['go.sum', ['GOSUM', ['BUILD'], ['go-checksum']]],
    ['pyproject.toml', ['TOML', ['CONFIG', 'BUILD'], ['python-project']]],
    ['poetry.lock', ['TOML', ['BUILD'], ['python-lockfile']]],
    ['pom.xml', ['XML', ['CONFIG', 'BUILD'], ['maven']]],
    ['build.gradle', ['GROOVY', ['CONFIG', 'BUILD'], ['gradle']]],
    ['settings.gradle', ['GROOVY', ['CONFIG', 'BUILD'], ['gradle']]],
    ['build.gradle.kts', ['KOTLIN', ['CONFIG', 'BUILD'], ['gradle-kotlin']]],
    ['settings.gradle.kts', ['KOTLIN', ['CONFIG', 'BUILD'], ['gradle-kotlin']]],
    ['mods.toml', ['TOML', ['CONFIG'], ['minecraft-forge']]]
  ]);
  if (exact.has(base)) {
    const [lang, roles, tags] = exact.get(base);
    return { roles, primary_language: lang, format: lang, tags };
  }
  if (/^requirements(?:-[^/]+)?\.txt$/.test(base)) {
    return { roles: ['BUILD'], primary_language: 'REQUIREMENTS', format: 'REQUIREMENTS', tags: ['python-dependencies'] };
  }
  if (/\.(csproj|fsproj|vbproj)$/.test(base)) {
    return { roles: ['CONFIG', 'BUILD'], primary_language: 'XML', format: 'MSBUILD', tags: ['dotnet-project'] };
  }
  if (base.endsWith('.sln')) {
    return { roles: ['BUILD'], primary_language: 'DOTNET_SOLUTION', format: 'SLN', tags: ['dotnet-solution'] };
  }
  if (/^\.github\/workflows\/[^/]+\.(yml|yaml)$/.test(p)) {
    return { roles: ['CONFIG', 'BUILD'], primary_language: 'YAML', format: 'GITHUB_ACTIONS', tags: ['github-actions'] };
  }
  return null;
}

export function classifyRepositoryPath(relativePath) {
  const normalized = normalizeRelativePath(relativePath);
  const special = specialClassification(normalized);
  if (special) return { path: normalized, ...special, roles: uniqueSorted(special.roles), tags: uniqueSorted(special.tags ?? []), dialect: null, recognized: true };

  const ext = path.posix.extname(normalized).toLowerCase();
  if (SOURCE_EXTENSIONS.has(ext)) {
    const [primary_language, dialect] = SOURCE_EXTENSIONS.get(ext);
    return {
      path: normalized,
      roles: ['SOURCE'],
      primary_language,
      dialect,
      format: null,
      tags: [],
      recognized: true
    };
  }

  if (STRUCTURED_FORMATS.has(ext)) {
    const format = STRUCTURED_FORMATS.get(ext);
    const roles = ['STRUCTURED_DATA'];
    if (format === 'MARKDOWN' || format === 'MDX') roles.push('DOCUMENTATION');
    return {
      path: normalized,
      roles: uniqueSorted(roles),
      primary_language: format,
      dialect: null,
      format,
      tags: [],
      recognized: true
    };
  }

  return {
    path: normalized,
    roles: ['UNKNOWN'],
    primary_language: null,
    dialect: null,
    format: null,
    tags: [],
    recognized: false
  };
}

function normalizeFenceLanguage(value) {
  const v = upper(value).replace(/[^A-Z0-9_+#.-]/g, '');
  const aliases = new Map([
    ['JS', 'JAVASCRIPT'], ['JAVASCRIPT', 'JAVASCRIPT'], ['MJS', 'JAVASCRIPT'],
    ['TS', 'TYPESCRIPT'], ['TYPESCRIPT', 'TYPESCRIPT'], ['TSX', 'TYPESCRIPT'],
    ['JAVA', 'JAVA'], ['PY', 'PYTHON'], ['PYTHON', 'PYTHON'], ['RS', 'RUST'], ['RUST', 'RUST'],
    ['SH', 'SHELL'], ['BASH', 'SHELL'], ['ZSH', 'SHELL'], ['PS1', 'POWERSHELL'], ['POWERSHELL', 'POWERSHELL'],
    ['JSON', 'JSON'], ['JSONC', 'JSONC'], ['YAML', 'YAML'], ['YML', 'YAML'], ['TOML', 'TOML'],
    ['HTML', 'HTML'], ['CSS', 'CSS'], ['SCSS', 'SCSS'], ['SQL', 'SQL'], ['GRAPHQL', 'GRAPHQL']
  ]);
  return aliases.get(v) ?? (v || null);
}

export function detectEmbeddedLanguages(relativePath, content, classification = classifyRepositoryPath(relativePath)) {
  const text = String(content ?? '');
  const embedded = [];
  const language = classification.primary_language;
  const format = classification.format;

  if (format === 'MARKDOWN' || format === 'MDX') {
    const fence = /```\s*([A-Za-z0-9_+#.-]+)/g;
    for (const match of text.matchAll(fence)) embedded.push(normalizeFenceLanguage(match[1]));
  }

  if (language === 'HTML' || language === 'VUE' || language === 'SVELTE') {
    if (/<script\b[^>]*\blang=["'](?:ts|typescript)["']/i.test(text)) embedded.push('TYPESCRIPT');
    else if (/<script\b/i.test(text)) embedded.push('JAVASCRIPT');
    if (/<style\b[^>]*\blang=["']scss["']/i.test(text)) embedded.push('SCSS');
    else if (/<style\b/i.test(text)) embedded.push('CSS');
  }

  if (format === 'GITHUB_ACTIONS' && /\$\{\{[\s\S]*?\}\}/m.test(text)) embedded.push('GITHUB_ACTION_EXPRESSION');
  if (format === 'DOCKERFILE' && /^\s*RUN\s+/im.test(text)) embedded.push('SHELL');

  return uniqueSorted(embedded);
}

export function normalizeProviderManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') throw new TypeError('provider manifest must be an object');
  for (const field of MANIFEST_REQUIRED_FIELDS) {
    if (!Object.hasOwn(manifest, field) || manifest[field] == null) throw new TypeError(`provider manifest is missing required field ${field}`);
  }
  const id = String(manifest.id ?? '').trim();
  const version = String(manifest.version ?? '').trim();
  if (!id) throw new TypeError('provider manifest id must be a non-empty string');
  if (!version) throw new TypeError(`provider ${id} version must be a non-empty string`);

  const capabilities = stringList(manifest.capabilities, { uppercase: true });
  for (const capability of capabilities) {
    if (!FABRIC_CAPABILITIES.includes(capability)) throw new TypeError(`provider ${id} declares unknown capability ${capability}`);
  }

  const contracts = new Map();
  for (const entry of manifest.capability_contracts ?? []) {
    const capability = upper(entry?.capability);
    const support_status = upper(entry?.support_status);
    if (!capabilities.includes(capability)) throw new TypeError(`provider ${id} contract references undeclared capability ${capability}`);
    if (!SUPPORT_STATUSES.has(support_status)) throw new TypeError(`provider ${id} has invalid support status ${support_status}`);
    contracts.set(capability, Object.freeze({
      capability,
      authority_level: upper(entry?.authority_level || manifest.authority_level),
      support_status,
      ...(entry?.support_reason ? { support_reason: String(entry.support_reason) } : {})
    }));
  }
  for (const capability of capabilities) {
    if (!contracts.has(capability)) throw new TypeError(`provider ${id} is missing capability_contract for ${capability}`);
  }

  return Object.freeze({
    ...manifest,
    id,
    version,
    supported_languages: stringList(manifest.supported_languages, { uppercase: true }),
    capabilities,
    capability_contracts: Object.freeze([...contracts.values()])
  });
}

export function buildRegistry(providerManifests, registryEntries = []) {
  const manifests = providerManifests.map(item => Object.isFrozen(item) ? item : normalizeProviderManifest(item));
  const byId = new Map(manifests.map(item => [item.id, item]));
  const explicit = new Map();
  for (const entry of registryEntries ?? []) {
    const provider_id = String(entry?.provider_id ?? '').trim();
    if (!provider_id) throw new TypeError('registry provider_id must be a non-empty string');
    if (!byId.has(provider_id)) throw new TypeError(`registry references unknown provider ${provider_id}`);
    explicit.set(provider_id, Object.freeze({
      provider_id,
      manifest_ref: String(entry.manifest_ref ?? provider_id),
      enabled: entry.enabled !== false,
      execution_preference: entry.execution_preference ?? null,
      fallback_policy: entry.fallback_policy ?? null
    }));
  }

  const registry = new Map();
  for (const manifest of manifests) {
    registry.set(manifest.id, explicit.get(manifest.id) ?? Object.freeze({
      provider_id: manifest.id,
      manifest_ref: manifest.id,
      enabled: true,
      execution_preference: null,
      fallback_policy: null
    }));
  }
  return registry;
}

function languageMatches(manifest, file) {
  const langs = new Set(manifest.supported_languages);
  return langs.has('*') || (file.primary_language && langs.has(file.primary_language));
}

function contractFor(manifest, capability) {
  return manifest.capability_contracts.find(entry => entry.capability === capability) ?? null;
}

function combineSupport(refs) {
  if (refs.some(ref => ref.enabled && ref.support_status === 'AVAILABLE')) return ['AVAILABLE', null];
  if (refs.some(ref => ref.enabled && ref.support_status === 'PARTIAL')) return ['PARTIAL', 'ONLY_PARTIAL_PROVIDER_SUPPORT'];
  if (refs.some(ref => !ref.enabled && ref.support_status !== 'NONE')) return ['NONE', 'MATCHING_PROVIDERS_DISABLED'];
  return ['NONE', 'NO_ENABLED_PROVIDER_FOR_SCOPE'];
}

function combineExecution(refs) {
  const executed = refs.filter(ref => ref.enabled && ref.execution_status);
  if (executed.length === 0) return ['UNEXPLORED', 'NO_EXECUTION_RECEIPT'];

  const explicitFailures = executed.filter(ref => ref.execution_status === 'FAILED');
  const partials = executed.filter(ref => ref.execution_status === 'PARTIAL');
  const analyzed = executed.filter(ref => ref.execution_status === 'ANALYZED');
  const skipped = executed.filter(ref => ref.execution_status === 'SKIPPED');

  if (explicitFailures.length && !analyzed.length && !partials.length) return ['FAILED', 'ALL_EXECUTED_PROVIDERS_FAILED'];
  if (explicitFailures.length || partials.length) return ['PARTIAL', 'EXECUTION_PARTIAL_OR_FAILED_PROVIDER_PRESERVED'];
  if (analyzed.length) {
    const fullySupportingAnalyzerRan = analyzed.some(ref => ref.support_status === 'AVAILABLE');
    return fullySupportingAnalyzerRan
      ? ['ANALYZED', null]
      : ['PARTIAL', 'ONLY_PARTIAL_SUPPORT_PROVIDER_ANALYZED'];
  }
  if (skipped.length === executed.length) return ['SKIPPED', 'ALL_SELECTED_EXECUTIONS_SKIPPED'];
  return ['UNEXPLORED', 'NO_ANALYZER_COMPLETED'];
}

function normalizeExecutionReceipt(receipt) {
  const provider_id = String(receipt?.provider_id ?? '').trim();
  const pathValue = normalizeRelativePath(receipt?.path);
  const capability = upper(receipt?.capability);
  const execution_status = upper(receipt?.execution_status);
  if (!provider_id) throw new TypeError('execution receipt provider_id must be non-empty');
  if (!FABRIC_CAPABILITIES.includes(capability)) throw new TypeError(`unknown execution receipt capability ${capability}`);
  if (!EXECUTION_STATUSES.has(execution_status)) throw new TypeError(`invalid execution status ${execution_status}`);
  return {
    provider_id,
    path: pathValue,
    capability,
    execution_status,
    ...(receipt?.execution_reason ? { execution_reason: String(receipt.execution_reason) } : {})
  };
}

export function buildCapabilityCoverage(files, { providerManifests = [], registryEntries = [], executionReceipts = [] } = {}) {
  const manifests = providerManifests.map(item => Object.isFrozen(item) ? item : normalizeProviderManifest(item));
  const registry = buildRegistry(manifests, registryEntries);
  const fileByPath = new Map(files.map(file => [file.path, file]));
  const manifestById = new Map(manifests.map(manifest => [manifest.id, manifest]));
  const receiptMap = new Map();
  for (const raw of executionReceipts ?? []) {
    const receipt = normalizeExecutionReceipt(raw);
    const manifest = manifestById.get(receipt.provider_id);
    const file = fileByPath.get(receipt.path);
    if (!manifest) throw new TypeError(`execution receipt references unknown provider ${receipt.provider_id}`);
    if (!file) throw new TypeError(`execution receipt references unknown file ${receipt.path}`);
    if (!registry.get(receipt.provider_id).enabled) throw new TypeError(`disabled provider ${receipt.provider_id} cannot have an execution receipt`);
    if (!contractFor(manifest, receipt.capability) || !languageMatches(manifest, file)) {
      throw new TypeError(`execution receipt provider ${receipt.provider_id} does not support ${receipt.capability} for ${receipt.path}`);
    }
    receiptMap.set(`${receipt.path}\0${receipt.capability}\0${receipt.provider_id}`, receipt);
  }

  const coverage = [];
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    for (const capability of FABRIC_CAPABILITIES) {
      const provider_refs = [];
      for (const manifest of manifests) {
        const contract = contractFor(manifest, capability);
        if (!contract || !languageMatches(manifest, file)) continue;
        const reg = registry.get(manifest.id);
        const receipt = receiptMap.get(`${file.path}\0${capability}\0${manifest.id}`);
        provider_refs.push({
          provider_id: manifest.id,
          provider_version: manifest.version,
          enabled: reg.enabled,
          support_status: contract.support_status,
          authority_level: contract.authority_level,
          ...(receipt ? {
            execution_status: receipt.execution_status,
            ...(receipt.execution_reason ? { execution_reason: receipt.execution_reason } : {})
          } : {})
        });
      }
      provider_refs.sort((a, b) => a.provider_id.localeCompare(b.provider_id));
      const [support_status, support_reason] = combineSupport(provider_refs);
      const [execution_status, execution_reason] = combineExecution(provider_refs);
      coverage.push({
        schema: CAPABILITY_COVERAGE_SCHEMA,
        id: `coverage:${sha256(`${file.path}\0${capability}`).slice(0, 24)}`,
        scope: { type: 'FILE', path: file.path },
        capability,
        support_status,
        execution_status,
        provider_refs,
        ...(support_reason ? { support_reason } : {}),
        ...(execution_reason ? { execution_reason } : {})
      });
    }
  }
  return coverage;
}

async function walkRepository(rootDirectory) {
  const out = [];
  async function visit(absDir, relDir) {
    const entries = await readdir(absDir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      const abs = path.join(absDir, entry.name);
      if (entry.isDirectory()) await visit(abs, rel);
      else if (entry.isFile()) out.push({ abs, rel: normalizeRelativePath(rel) });
    }
  }
  await visit(rootDirectory, '');
  return out;
}

export async function profileRepository(rootDirectory, {
  repositoryId = path.resolve(rootDirectory),
  snapshotId = 'WORKTREE',
  providerManifests = [],
  registryEntries = [],
  executionReceipts = [],
  digestRecognizedFilesUpToBytes = 1024 * 1024
} = {}) {
  const rootStat = await stat(rootDirectory);
  if (!rootStat.isDirectory()) throw new TypeError('rootDirectory must be a directory');

  const discovered = await walkRepository(rootDirectory);
  const files = [];
  for (const item of discovered) {
    const classification = classifyRepositoryPath(item.rel);
    const fileStat = await stat(item.abs);
    let content = null;
    let contentDigest = null;
    if (classification.recognized && fileStat.size <= digestRecognizedFilesUpToBytes) {
      const bytes = await readFile(item.abs);
      content = bytes.toString('utf8');
      contentDigest = `sha256:${sha256(bytes)}`;
    }
    const embedded_languages = content === null ? [] : detectEmbeddedLanguages(item.rel, content, classification);
    files.push({
      ...classification,
      embedded_languages,
      size_bytes: fileStat.size,
      ...(contentDigest ? { content_digest: contentDigest } : {})
    });
  }

  const manifests = providerManifests.map(normalizeProviderManifest);
  const coverage = buildCapabilityCoverage(files, {
    providerManifests: manifests,
    registryEntries,
    executionReceipts
  });

  return {
    schema: REPOSITORY_CAPABILITY_PROFILE_SCHEMA,
    repository: { repository_id: String(repositoryId), snapshot_id: String(snapshotId) },
    files,
    coverage,
    summary: {
      file_count: files.length,
      recognized_file_count: files.filter(file => file.recognized).length,
      languages: uniqueSorted(files.map(file => file.primary_language)),
      embedded_languages: uniqueSorted(files.flatMap(file => file.embedded_languages)),
      roles: uniqueSorted(files.flatMap(file => file.roles))
    }
  };
}
