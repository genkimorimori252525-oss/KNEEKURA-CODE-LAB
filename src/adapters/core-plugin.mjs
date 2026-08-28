import {
  validateAnalysisRequestV1,
  validateAnalysisResultV1
} from '../core/schema/v1.mjs';

export const CORE_PLUGIN_ADAPTER_SCHEMA =
  'core.plugin-adapter/v1';
export const CORE_PLUGIN_MANIFEST_SCHEMA =
  'core.plugin-manifest/v1';

export function createCorePluginAdapter({
  engine,
  id = 'kneekura-core-plugin',
  version = 'v1'
}) {
  if (!engine || typeof engine !== 'object') {
    throw new TypeError('plugin adapter requires a CORE engine');
  }
  for (const method of ['analyze','expand','get']) {
    if (typeof engine[method] !== 'function') {
      throw new TypeError(
        'plugin adapter engine requires ' + method + '()'
      );
    }
  }
  if (typeof engine.session?.resume !== 'function') {
    throw new TypeError(
      'plugin adapter engine requires session.resume()'
    );
  }
  requireString(id, 'plugin id');
  requireString(version, 'plugin version');

  const manifest = deepFreeze({
    schema: CORE_PLUGIN_MANIFEST_SCHEMA,
    id,
    version,
    read_only_target: true,
    owns_provider_credentials: false,
    request_schema: 'core.analysis-request/v1',
    result_schema: 'core.analysis-result/v1',
    capabilities: Object.freeze([
      'core.analyze',
      'core.expand',
      'core.get',
      'core.session.resume'
    ])
  });

  const session = Object.freeze({
    async resume(sessionId, targetSnapshotId = null) {
      requireString(sessionId, 'sessionId');
      if (
        targetSnapshotId != null &&
        (typeof targetSnapshotId !== 'string' || !targetSnapshotId.trim())
      ) {
        throw new TypeError('targetSnapshotId must be a non-empty string or null');
      }
      const handle = await engine.session.resume(
        sessionId,
        targetSnapshotId
      );
      validateSessionHandle(handle, {
        sessionId,
        targetSnapshotId
      });
      return structuredClone(handle);
    }
  });

  return Object.freeze({
    schema: CORE_PLUGIN_ADAPTER_SCHEMA,
    id,
    version,

    describe() {
      return structuredClone(manifest);
    },

    async analyze(request) {
      validateAnalysisRequestV1(request);
      const result = await engine.analyze(
        structuredClone(request)
      );
      validateAnalysisResultV1(result);
      return structuredClone(result);
    },

    async expand(analysisId, target, budget = null) {
      requireString(analysisId, 'analysisId');
      const delta = await engine.expand(
        analysisId,
        structuredClone(target),
        budget == null ? undefined : structuredClone(budget)
      );
      validateAnalysisDelta(delta, analysisId);
      return structuredClone(delta);
    },

    get(ref) {
      requireString(ref, 'ref');
      const value = engine.get(ref);
      return value == null ? null : structuredClone(value);
    },

    session
  });
}

function validateAnalysisDelta(value, analysisId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('plugin engine expand() must return an object');
  }
  if (value.schema !== 'core.analysis-delta/v1') {
    throw new TypeError(
      'plugin engine expand() must return core.analysis-delta/v1'
    );
  }
  if (value.analysis_id !== analysisId) {
    throw new Error('plugin engine expand() analysis_id mismatch');
  }
}

function validateSessionHandle(value, {
  sessionId,
  targetSnapshotId
}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(
      'plugin engine session.resume() must return an object'
    );
  }
  if (value.schema !== 'core.session-handle/v1') {
    throw new TypeError(
      'plugin engine session.resume() must return core.session-handle/v1'
    );
  }
  if (value.session_id !== sessionId) {
    throw new Error(
      'plugin engine session.resume() session_id mismatch'
    );
  }
  if (
    targetSnapshotId != null &&
    value.target_snapshot_id !== targetSnapshotId
  ) {
    throw new Error(
      'plugin engine session.resume() target_snapshot_id mismatch'
    );
  }
}

function requireString(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(name + ' is required');
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object') return value;
  Object.freeze(value);
  for (const item of Object.values(value)) {
    deepFreeze(item);
  }
  return value;
}
