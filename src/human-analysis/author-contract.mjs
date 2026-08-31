export const HUMAN_ANALYSIS_AUTHOR_DESCRIPTOR_SCHEMA =
  'kneekura.human-analysis-author-descriptor/v1';

export const HUMAN_ANALYSIS_AUTHOR_MODES = Object.freeze([
  'PRODUCTION',
  'ACCEPTANCE'
]);

const AUTHOR_BRAND = Symbol('kneekura.human-analysis-author');

export class HumanAnalysisAuthorContractError extends TypeError {
  constructor(code, message) {
    super(message);
    this.name = 'HumanAnalysisAuthorContractError';
    this.code = String(code);
  }
}

export function createProductionSemanticAuthor({
  id,
  run,
  locale = 'ja-JP',
  provider_id = null
} = {}) {
  return createAuthorDescriptor({
    id,
    run,
    locale,
    provider_id,
    mode: 'PRODUCTION'
  });
}

export function createAcceptanceSemanticAuthor({
  id,
  run,
  locale = 'en',
  provider_id = null
} = {}) {
  return createAuthorDescriptor({
    id,
    run,
    locale,
    provider_id,
    mode: 'ACCEPTANCE'
  });
}

export function assertProductionSemanticAuthor(value) {
  const author = assertHumanAnalysisAuthor(value);
  if (author.mode !== 'PRODUCTION') {
    throw new HumanAnalysisAuthorContractError(
      'PRODUCTION_AUTHOR_MODE_REQUIRED',
      `production Human Guide requires a PRODUCTION semantic author; received ${author.mode}`
    );
  }
  if (author.user_deliverable !== true || author.acceptance_fixture === true) {
    throw new HumanAnalysisAuthorContractError(
      'PRODUCTION_AUTHOR_DELIVERY_CONTRACT_INVALID',
      'production semantic author must be explicitly user-deliverable and not an acceptance fixture'
    );
  }
  return author;
}

export function assertAcceptanceSemanticAuthor(value) {
  const author = assertHumanAnalysisAuthor(value);
  if (author.mode !== 'ACCEPTANCE') {
    throw new HumanAnalysisAuthorContractError(
      'ACCEPTANCE_AUTHOR_MODE_REQUIRED',
      `acceptance pipeline requires an ACCEPTANCE semantic author; received ${author.mode}`
    );
  }
  if (author.user_deliverable !== false || author.acceptance_fixture !== true) {
    throw new HumanAnalysisAuthorContractError(
      'ACCEPTANCE_AUTHOR_DELIVERY_CONTRACT_INVALID',
      'acceptance semantic author must be non-deliverable and marked as an acceptance fixture'
    );
  }
  return author;
}

export function describeHumanAnalysisAuthor(value) {
  const author = assertHumanAnalysisAuthor(value);
  return Object.freeze({
    schema: author.schema,
    id: author.id,
    mode: author.mode,
    locale: author.locale,
    provider_id: author.provider_id,
    origin: author.origin,
    user_deliverable: author.user_deliverable,
    acceptance_fixture: author.acceptance_fixture
  });
}

export function assertHumanAnalysisAuthor(value) {
  if (!value || typeof value !== 'object' || value[AUTHOR_BRAND] !== true) {
    throw new HumanAnalysisAuthorContractError(
      'SEMANTIC_AUTHOR_DESCRIPTOR_REQUIRED',
      'Human Analysis author must be created through the explicit production/acceptance author contract'
    );
  }
  if (value.schema !== HUMAN_ANALYSIS_AUTHOR_DESCRIPTOR_SCHEMA) {
    throw new HumanAnalysisAuthorContractError(
      'SEMANTIC_AUTHOR_SCHEMA_INVALID',
      `semantic author must use ${HUMAN_ANALYSIS_AUTHOR_DESCRIPTOR_SCHEMA}`
    );
  }
  if (!HUMAN_ANALYSIS_AUTHOR_MODES.includes(value.mode)) {
    throw new HumanAnalysisAuthorContractError(
      'SEMANTIC_AUTHOR_MODE_INVALID',
      `unsupported semantic author mode: ${String(value.mode)}`
    );
  }
  if (typeof value.run !== 'function') {
    throw new HumanAnalysisAuthorContractError(
      'SEMANTIC_AUTHOR_RUN_REQUIRED',
      'semantic author run(stageEnvelope, sourceBroker) function is required'
    );
  }
  return value;
}

function createAuthorDescriptor({ id, run, locale, provider_id, mode }) {
  const normalizedId = String(id ?? '').trim();
  if (!normalizedId) {
    throw new HumanAnalysisAuthorContractError(
      'SEMANTIC_AUTHOR_ID_REQUIRED',
      'semantic author id is required'
    );
  }
  if (typeof run !== 'function') {
    throw new HumanAnalysisAuthorContractError(
      'SEMANTIC_AUTHOR_RUN_REQUIRED',
      'semantic author run(stageEnvelope, sourceBroker) function is required'
    );
  }
  const normalizedLocale = normalizeLocale(locale);
  const normalizedProviderId = provider_id == null
    ? null
    : String(provider_id).trim() || null;
  const production = mode === 'PRODUCTION';
  return Object.freeze({
    schema: HUMAN_ANALYSIS_AUTHOR_DESCRIPTOR_SCHEMA,
    id: normalizedId,
    mode,
    locale: normalizedLocale,
    provider_id: normalizedProviderId,
    origin: 'AI_SEMANTIC_AUTHOR',
    user_deliverable: production,
    acceptance_fixture: !production,
    run,
    [AUTHOR_BRAND]: true
  });
}

function normalizeLocale(value) {
  const locale = String(value ?? '').trim();
  if (!locale || locale.length > 32 || !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(locale)) {
    throw new HumanAnalysisAuthorContractError(
      'SEMANTIC_AUTHOR_LOCALE_INVALID',
      `invalid semantic author locale: ${String(value)}`
    );
  }
  return locale;
}
