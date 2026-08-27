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
      return structuredClone(
        await engine.session.resume(
          sessionId,
          targetSnapshotId
        )
      );
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
      return structuredClone(
        await engine.expand(
          analysisId,
          structuredClone(target),
          budget == null ? undefined : structuredClone(budget)
        )
      );
    },

    get(ref) {
      requireString(ref, 'ref');
      const value = engine.get(ref);
      return value == null ? null : structuredClone(value);
    },

    session
  });
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
