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

function assertObservationBinding(observation, manifest, context) {
  for (const [field, expected] of [
    ['provider_id', manifest.id],
    ['provider_version', manifest.version],
    ['origin', String(manifest.origin).trim().toUpperCase()]
  ]) {
    if (observation[field] !== expected) throw new TypeError(`observation ${field} conflicts with executing provider`);
  }
  for (const [field, expected] of [
    ['repository_id', context.repositoryId ?? context.repository_id],
    ['snapshot_id', context.snapshotId ?? context.snapshot_id]
  ]) {
    if (expected != null && observation.snapshot[field] !== String(expected)) {
      throw new TypeError(`observation ${field} conflicts with execution context`);
    }
  }
  const contract = manifest.capability_contracts.find(entry => entry.capability === observation.capability);
  if (!manifest.capabilities.includes(observation.capability) || !contract || contract.support_status === 'NONE') {
    throw new TypeError(`executing provider does not support observation capability ${observation.capability}`);
  }
  const fingerprint = observation.provenance.toolchain_fingerprint;
  if (fingerprint != null && String(fingerprint) !== String(manifest.toolchain_fingerprint)) {
    throw new TypeError('observation toolchain fingerprint conflicts with executing provider');
  }
}

export async function runFabricProvider(provider, input, context = {}) {
  if (!provider?.manifest || typeof provider?.analyze !== 'function') {
    throw new TypeError('runFabricProvider requires a fabric provider');
  }

  // Bind acceptance before calling provider code. A callback cannot change the
  // manifest or execution identity against which its own output is checked.
  const manifest = provider.manifest;
  const executingProvider = { manifest: {
    id: manifest.id,
    version: manifest.version,
    origin: manifest.origin,
    toolchain_fingerprint: manifest.toolchain_fingerprint,
    capabilities: [...manifest.capabilities],
    capability_contracts: manifest.capability_contracts.map(({ capability, support_status }) => ({ capability, support_status }))
  } };
  const executionContext = { ...context };
  let rawObservations;
  try {
    rawObservations = await provider.analyze(input, { ...context });
  } catch (error) {
    return {
      provider_id: executingProvider.manifest.id,
      provider_version: executingProvider.manifest.version,
      execution_status: 'FAILED',
      observations: [],
      failures: [failureRecord(executingProvider, input, executionContext, error)]
    };
  }

  if (!Array.isArray(rawObservations)) {
    const error = new FabricProviderError('TRUST_BOUNDARY_VIOLATION', 'provider analyze result must be an array of raw observations');
    return {
      provider_id: executingProvider.manifest.id,
      provider_version: executingProvider.manifest.version,
      execution_status: 'FAILED',
      observations: [],
      failures: [failureRecord(executingProvider, input, executionContext, error)]
    };
  }

  try {
    const observations = rawObservations.map(raw => {
      const observation = normalizeAnalyzerObservation(raw, {
        repositoryId: executionContext.repositoryId ?? executionContext.repository_id ?? null,
        snapshotId: executionContext.snapshotId ?? executionContext.snapshot_id ?? null,
        sourceTextByPath: executionContext.sourceTextByPath ?? {}
      });
      assertObservationBinding(observation, executingProvider.manifest, executionContext);
      return observation;
    });
    return {
      provider_id: executingProvider.manifest.id,
      provider_version: executingProvider.manifest.version,
      execution_status: 'ANALYZED',
      observations,
      failures: []
    };
  } catch (error) {
    return {
      provider_id: executingProvider.manifest.id,
      provider_version: executingProvider.manifest.version,
      execution_status: 'FAILED',
      observations: [],
      failures: [failureRecord(executingProvider, input, executionContext, error, 'TRUST_BOUNDARY_VIOLATION')]
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
