import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  EVIDENCE_RECORD_SCHEMA,
  validateEvidenceRecordV1
} from '../schema/v1.mjs';

export const PROVIDER_FAILURE_CODES = Object.freeze([
  'ANALYZER_UNSUPPORTED',
  'ANALYZER_UNAVAILABLE',
  'PARSE_FAILED',
  'RUNTIME_IDENTITY_MISMATCH',
  'TRUST_BOUNDARY_VIOLATION',
  'INTERNAL_INVARIANT'
]);

const FAILURE_CODE_SET = new Set(PROVIDER_FAILURE_CODES);

export class ProviderFailure extends Error {
  constructor(code, message, {
    providerId,
    providerVersion,
    unitRef = null,
    cause = null,
    details = null
  } = {}) {
    super(message);
    this.name = 'ProviderFailure';
    this.code = FAILURE_CODE_SET.has(code) ? code : 'INTERNAL_INVARIANT';
    this.provider_id = providerId ?? null;
    this.provider_version = providerVersion ?? null;
    this.unit_ref = unitRef;
    this.details = details;
    if (cause) this.cause = cause;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      provider_id: this.provider_id,
      provider_version: this.provider_version,
      unit_ref: this.unit_ref,
      ...(this.details ? { details: structuredClone(this.details) } : {})
    };
  }
}

export function createEvidenceProvider(spec) {
  if (!spec || typeof spec !== 'object') throw new TypeError('provider spec must be an object');
  if (typeof spec.id !== 'string' || !spec.id.trim()) throw new TypeError('provider id is required');
  if (typeof spec.version !== 'string' || !spec.version.trim()) throw new TypeError('provider version is required');
  if (typeof spec.acquire !== 'function') throw new TypeError('provider acquire function is required');

  const capabilities = Object.freeze({
    input_kinds: [...(spec.inputKinds ?? [])],
    supported_properties: [...(spec.supportedProperties ?? [])],
    deterministic: spec.deterministic !== false,
    evidence_kind: spec.evidenceKind ?? null,
    failure_classes: [...new Set([spec.failureClass ?? 'PARSE_FAILED', ...(spec.failureClasses ?? [])])]
  });

  const provider = {
    id: spec.id,
    version: spec.version,

    capabilities() {
      return structuredClone(capabilities);
    },

    async dependencyFingerprint(context, unit = {}) {
      assertContext(context);
      const descriptor = await describeUnit(context, unit);
      const custom = spec.dependencyFingerprint
        ? await spec.dependencyFingerprint(context, unit, descriptor)
        : null;
      return digestObject({
        provider_id: spec.id,
        provider_version: spec.version,
        snapshot_id: context.snapshot.snapshot_id,
        unit: descriptor.fingerprint,
        custom
      });
    },

    async acquire(context, unit = {}) {
      assertContext(context);
      const descriptor = await describeUnit(context, unit);
      const dependencyFingerprint = await provider.dependencyFingerprint(context, unit);
      const start = {
        nodes: context.builder.graph.nodes.length,
        edges: context.builder.graph.edges.length,
        diagnostics: context.builder.graph.diagnostics.length
      };

      let value;
      let thrownFailure = null;
      try {
        value = await spec.acquire(context, unit);
      } catch (error) {
        thrownFailure = new ProviderFailure(
          spec.failureClass ?? 'PARSE_FAILED',
          error?.message ? String(error.message) : 'provider acquisition failed',
          {
            providerId: spec.id,
            providerVersion: spec.version,
            unitRef: descriptor.unit_ref,
            cause: error
          }
        );
        context.builder.diagnostic('error', 'provider failed', {
          providerId: spec.id,
          providerVersion: spec.version,
          code: thrownFailure.code,
          unitRef: descriptor.unit_ref,
          error: thrownFailure.message
        });
      }

      const liveFragment = {
        nodes: context.builder.graph.nodes.slice(start.nodes),
        edges: context.builder.graph.edges.slice(start.edges),
        diagnostics: context.builder.graph.diagnostics.slice(start.diagnostics)
      };

      const unresolved = thrownFailure
        ? []
        : normalizeUnresolved(
            spec.unresolved
              ? await spec.unresolved(context, unit, liveFragment, value)
              : []
          );

      const failures = [];
      if (thrownFailure) failures.push(thrownFailure.toJSON());

      if (typeof spec.classifyDiagnostic === 'function') {
        for (const diagnostic of liveFragment.diagnostics) {
          const classified = spec.classifyDiagnostic(diagnostic, context, unit);
          if (!classified) continue;
          const code = typeof classified === 'string' ? classified : classified.code;
          const message = typeof classified === 'string'
            ? diagnostic.reason ?? diagnostic.message ?? 'provider diagnostic failure'
            : classified.message ?? diagnostic.reason ?? diagnostic.message ?? 'provider diagnostic failure';
          const details = typeof classified === 'string' ? diagnostic : { ...diagnostic, ...(classified.details ?? {}) };
          const failure = new ProviderFailure(code, String(message), {
            providerId: spec.id,
            providerVersion: spec.version,
            unitRef: descriptor.unit_ref,
            details
          }).toJSON();
          if (!failures.some(existing => existing.code === failure.code && existing.message === failure.message)) {
            failures.push(failure);
          }
        }
      }

      const shouldEmitEvidence =
        !thrownFailure &&
        Boolean(spec.evidenceKind) &&
        (
          liveFragment.nodes.length > 0 ||
          liveFragment.edges.length > 0 ||
          unresolved.length > 0 ||
          Boolean(spec.emitEmptyEvidence)
        );

      const evidence = [];
      if (shouldEmitEvidence) {
        const provenance = {
          repository_id: context.repository.repository_id,
          snapshot_id: context.snapshot.snapshot_id,
          provider_id: spec.id,
          provider_version: spec.version,
          extraction_method: spec.extractionMethod ?? 'provider-wrapper-v1',
          ...descriptor.provenance,
          ...(spec.provenance
            ? await spec.provenance(context, unit, liveFragment, value, descriptor)
            : {})
        };

        const observation = spec.observation
          ? await spec.observation(context, unit, liveFragment, value, unresolved, descriptor)
          : {
              unit_ref: descriptor.unit_ref,
              graph_delta: {
                nodes_added: liveFragment.nodes.length,
                edges_added: liveFragment.edges.length,
                diagnostics_added: liveFragment.diagnostics.length
              },
              unresolved_references: unresolved
            };

        evidence.push(createEvidenceRecord({
          kind: spec.evidenceKind,
          observation,
          provenance,
          trustClass: spec.trustClass ?? 'ENGINE_TRUSTED',
          providerId: spec.id,
          providerVersion: spec.version
        }));
      }

      return {
        provider: {
          id: spec.id,
          version: spec.version,
          capabilities: provider.capabilities()
        },
        dependency_fingerprint: dependencyFingerprint,
        unit_ref: descriptor.unit_ref,
        evidence,
        graph_fragment: {
          nodes: structuredClone(liveFragment.nodes),
          edges: structuredClone(liveFragment.edges)
        },
        diagnostics: structuredClone(liveFragment.diagnostics),
        failures,
        unresolved_references: unresolved,
        metrics: {
          nodes_added: liveFragment.nodes.length,
          edges_added: liveFragment.edges.length,
          diagnostics_added: liveFragment.diagnostics.length,
          evidence_count: evidence.length,
          unresolved_reference_count: unresolved.length
        },
        value
      };
    }
  };

  return Object.freeze(provider);
}

export async function acquireAndRecord(provider, context, unit = {}) {
  const result = await provider.acquire(context, unit);
  recordProviderResult(context.builder, result);
  return result;
}

export function recordProviderResult(builder, result) {
  const meta = builder.graph.meta;
  meta.providers ??= [];
  meta.providerResults ??= [];
  meta.evidence ??= [];
  meta.providerFailures ??= [];
  meta.unresolvedReferences ??= [];

  if (!meta.providers.some(item =>
    item.id === result.provider.id && item.version === result.provider.version
  )) {
    meta.providers.push(structuredClone(result.provider));
  }

  for (const record of result.evidence) {
    validateEvidenceRecordV1(record);
    if (!meta.evidence.some(existing => existing.id === record.id)) {
      meta.evidence.push(structuredClone(record));
    }
  }

  for (const failure of result.failures) {
    meta.providerFailures.push(structuredClone(failure));
  }

  for (const unresolved of result.unresolved_references) {
    meta.unresolvedReferences.push({
      provider_id: result.provider.id,
      provider_version: result.provider.version,
      unit_ref: result.unit_ref,
      ...structuredClone(unresolved)
    });
  }

  meta.providerResults.push({
    provider_id: result.provider.id,
    provider_version: result.provider.version,
    unit_ref: result.unit_ref,
    dependency_fingerprint: result.dependency_fingerprint,
    evidence_ids: result.evidence.map(item => item.id),
    failure_codes: result.failures.map(item => item.code),
    unresolved_reference_count: result.unresolved_references.length,
    metrics: structuredClone(result.metrics)
  });

  return result;
}

export function createEvidenceRecord({
  kind,
  observation,
  provenance,
  trustClass,
  providerId,
  providerVersion
}) {
  const basis = {
    schema: EVIDENCE_RECORD_SCHEMA,
    kind,
    observation,
    provenance,
    trust_class: trustClass,
    provider_id: providerId,
    provider_version: providerVersion
  };
  const integrityDigest = digestObject(basis);
  const id = 'evidence:sha256:' + sha256(stableStringify({
    ...basis,
    integrity_digest: integrityDigest
  }));
  const record = {
    schema: EVIDENCE_RECORD_SCHEMA,
    id,
    kind,
    observation: structuredClone(observation),
    provenance: structuredClone(provenance),
    integrity_digest: integrityDigest,
    trust_class: trustClass,
    provider_id: providerId,
    provider_version: providerVersion
  };
  validateEvidenceRecordV1(record);
  return record;
}

async function describeUnit(context, unit) {
  const dependencies = [];
  let primary = null;

  if (unit.file) {
    primary = await describeFile(context, unit.file, Boolean(unit.artifact));
    dependencies.push(primary.fingerprint);
  } else if (unit.java?.rel) {
    primary = await describeRepositoryPath(context, unit.java.rel);
    dependencies.push(primary.fingerprint);
  }

  for (const dependency of unit.dependencyFiles ?? []) {
    dependencies.push((await describeFile(context, dependency, true)).fingerprint);
  }

  const fallbackRef =
    unit.ref ??
    unit.java?.rel ??
    (unit.file ? normalizeSlashes(String(unit.file)) : 'snapshot:' + context.snapshot.snapshot_id);

  const unitRef = primary?.unit_ref ?? String(fallbackRef);
  const provenance = primary?.provenance ?? (
    unit.artifact
      ? { artifact_id: 'artifact-input:sha256:' + sha256(String(fallbackRef)) }
      : {}
  );

  return {
    unit_ref: unitRef,
    provenance,
    fingerprint: {
      unit_ref: unitRef,
      dependencies
    }
  };
}

async function describeFile(context, file, artifact) {
  const absolute = path.resolve(String(file));
  const relative = relativeInside(context.root, absolute);

  if (!artifact && relative) {
    return describeRepositoryPath(context, relative);
  }

  try {
    const bytes = await fs.readFile(absolute);
    const digest = 'sha256:' + sha256(bytes);
    return {
      unit_ref: 'artifact:' + digest,
      provenance: {
        artifact_id: 'artifact:' + digest,
        artifact_digest: digest
      },
      fingerprint: {
        kind: 'artifact',
        digest
      }
    };
  } catch {
    const normalized = normalizeSlashes(absolute);
    return {
      unit_ref: 'artifact-input:sha256:' + sha256(normalized),
      provenance: {
        artifact_id: 'artifact-input:sha256:' + sha256(normalized)
      },
      fingerprint: {
        kind: 'artifact-unavailable',
        ref_digest: 'sha256:' + sha256(normalized)
      }
    };
  }
}

async function describeRepositoryPath(context, relativePath) {
  const relative = normalizeRepositoryPath(relativePath);
  const entry = context.snapshot.content_manifest?.find(item => item.path === relative);
  if (entry) {
    return {
      unit_ref: relative,
      provenance: { path: relative },
      fingerprint: {
        kind: 'repository-path',
        path: relative,
        state: entry.state,
        digest: entry.digest
      }
    };
  }

  try {
    const bytes = await fs.readFile(path.join(context.root, relative));
    const digest = 'sha256:' + sha256(bytes);
    return {
      unit_ref: relative,
      provenance: { path: relative },
      fingerprint: {
        kind: 'repository-path',
        path: relative,
        digest
      }
    };
  } catch {
    return {
      unit_ref: relative,
      provenance: { path: relative },
      fingerprint: {
        kind: 'repository-path',
        path: relative,
        unavailable: true
      }
    };
  }
}

function normalizeUnresolved(items) {
  if (!Array.isArray(items)) return [];
  return items
    .filter(item => item && typeof item === 'object')
    .map(item => structuredClone(item));
}

function assertContext(context) {
  if (!context?.builder?.graph) throw new TypeError('provider context requires a GraphBuilder');
  if (!context?.repository?.repository_id) throw new TypeError('provider context requires RepositoryIdentity');
  if (!context?.snapshot?.snapshot_id) throw new TypeError('provider context requires SnapshotIdentity');
  if (typeof context.root !== 'string' || !context.root) throw new TypeError('provider context requires repository root');
}

function relativeInside(root, absolute) {
  const rel = path.relative(path.resolve(root), absolute);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return normalizeRepositoryPath(rel);
}

function normalizeRepositoryPath(value) {
  return normalizeSlashes(String(value)).replace(/^\.\/+/, '').replace(/^\/+/, '');
}

function normalizeSlashes(value) {
  return value.replace(/\\/g, '/');
}

function digestObject(value) {
  return 'sha256:' + sha256(stableStringify(value));
}

function stableStringify(value) {
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key =>
      JSON.stringify(key) + ':' + stableStringify(value[key])
    ).join(',') + '}';
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}
