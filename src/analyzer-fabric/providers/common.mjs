import { normalizeAnalyzerObservation } from '../observation.mjs';
import { normalizeProviderManifest } from '../profile.mjs';

export const ANALYZER_PROVIDER_FAILURE_SCHEMA = 'kneekura.analyzer-provider-failure/v1';

export const FABRIC_PROVIDER_FAILURE_TYPES = Object.freeze([
  'ANALYZER_UNSUPPORTED',
  'ANALYZER_UNAVAILABLE',
  'PARSE_FAILED',
  'RUNTIME_IDENTITY_MISMATCH',
  'TRUST_BOUNDARY_VIOLATION',
  'INTERNAL_INVARIANT',
  'ANALYZER_TIMEOUT',
  'ANALYZER_RESOURCE_LIMIT',
  'ANALYZER_TOOLCHAIN_MISMATCH'
]);

const FAILURE_TYPES = new Set(FABRIC_PROVIDER_FAILURE_TYPES);

export class FabricProviderError extends Error {
  constructor(failureType, message, details = null) {
    super(message);
    this.name = 'FabricProviderError';
    this.failure_type = FAILURE_TYPES.has(failureType) ? failureType : 'INTERNAL_INVARIANT';
    this.details = details;
  }
}

export function createFabricProvider({ manifest, analyze }) {
  if (typeof analyze !== 'function') throw new TypeError('fabric provider analyze must be a function');
  const normalizedManifest = normalizeProviderManifest(manifest);
  return Object.freeze({
    manifest: normalizedManifest,
    analyze
  });
}

function scopeFrom(input, context) {
  const explicit = input?.scope ?? context?.scope;
  if (explicit && typeof explicit === 'object') return structuredClone(explicit);
  if (typeof input?.file === 'string' && input.file) return { type: 'FILE', path: input.file };
  return { type: 'REPOSITORY' };
}

function failureRecord(provider, input, context, error, overrideType = null) {
  const manifest = provider.manifest;
  const failureType = overrideType ?? error?.failure_type ?? 'INTERNAL_INVARIANT';
  return {
    schema: ANALYZER_PROVIDER_FAILURE_SCHEMA,
    provider_id: manifest.id,
    provider_version: manifest.version,
    failure_type: FAILURE_TYPES.has(failureType) ? failureType : 'INTERNAL_INVARIANT',
    message: String(error?.message ?? error ?? 'provider failed'),
    scope: scopeFrom(input, context),
    provenance: {
      repository_id: String(context?.repositoryId ?? context?.repository_id ?? ''),
      snapshot_id: String(context?.snapshotId ?? context?.snapshot_id ?? ''),
      provider_id: manifest.id,
      provider_version: manifest.version,
      toolchain_fingerprint: manifest.toolchain_fingerprint,
      ...(error?.details ? { details: structuredClone(error.details) } : {})
    }
  };
}

export async function runFabricProvider(provider, input, context = {}) {
  if (!provider?.manifest || typeof provider?.analyze !== 'function') {
    throw new TypeError('runFabricProvider requires a fabric provider');
  }

  let rawObservations;
  try {
    rawObservations = await provider.analyze(input, context);
  } catch (error) {
    return {
      provider_id: provider.manifest.id,
      provider_version: provider.manifest.version,
      execution_status: 'FAILED',
      observations: [],
      failures: [failureRecord(provider, input, context, error)]
    };
  }

  if (!Array.isArray(rawObservations)) {
    const error = new FabricProviderError('TRUST_BOUNDARY_VIOLATION', 'provider analyze result must be an array of raw observations');
    return {
      provider_id: provider.manifest.id,
      provider_version: provider.manifest.version,
      execution_status: 'FAILED',
      observations: [],
      failures: [failureRecord(provider, input, context, error)]
    };
  }

  try {
    const observations = rawObservations.map(raw => normalizeAnalyzerObservation(raw, {
      repositoryId: context.repositoryId ?? context.repository_id ?? null,
      snapshotId: context.snapshotId ?? context.snapshot_id ?? null,
      sourceTextByPath: context.sourceTextByPath ?? {}
    }));
    return {
      provider_id: provider.manifest.id,
      provider_version: provider.manifest.version,
      execution_status: 'ANALYZED',
      observations,
      failures: []
    };
  } catch (error) {
    return {
      provider_id: provider.manifest.id,
      provider_version: provider.manifest.version,
      execution_status: 'FAILED',
      observations: [],
      failures: [failureRecord(provider, input, context, error, 'TRUST_BOUNDARY_VIOLATION')]
    };
  }
}

export async function runFabricProviders(runs, context = {}) {
  if (!Array.isArray(runs)) throw new TypeError('runs must be an array');
  const results = [];
  for (const run of runs) {
    results.push(await runFabricProvider(run.provider, run.input, context));
  }
  return {
    results,
    observations: results.flatMap(result => result.observations),
    failures: results.flatMap(result => result.failures),
    execution_status: results.some(result => result.execution_status === 'FAILED')
      ? (results.some(result => result.execution_status === 'ANALYZED') ? 'PARTIAL' : 'FAILED')
      : 'ANALYZED'
  };
}
