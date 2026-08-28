import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createCoreEngine
} from '../src/core/api.mjs';
import {
  createCorePluginAdapter,
  CORE_PLUGIN_ADAPTER_SCHEMA,
  CORE_PLUGIN_MANIFEST_SCHEMA
} from '../src/plugin.mjs';
import {
  ANALYSIS_REQUEST_SCHEMA,
  ANALYSIS_RESULT_SCHEMA,
  validateAnalysisResultV1
} from '../src/core/schema/v1.mjs';
import {
  createReasoningBridge
} from '../src/core/reasoning/bridge.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FIXTURE = path.join(ROOT, 'fixtures/forge-mini');

function request() {
  return {
    schema: ANALYSIS_REQUEST_SCHEMA,
    repository: FIXTURE,
    mode: 'TRACE',
    question: 'Trace ReimuPacket through the plugin adapter.',
    scope: {
      paths: ['ReimuPacket.java']
    },
    policy: 'precision',
    output_profile: 'compact'
  };
}

test('frozen public schema names remain core.analysis-request/v1 and core.analysis-result/v1', () => {
  assert.equal(
    ANALYSIS_REQUEST_SCHEMA,
    'core.analysis-request/v1'
  );
  assert.equal(
    ANALYSIS_RESULT_SCHEMA,
    'core.analysis-result/v1'
  );
});

test('plugin manifest publishes only the accepted read-only CORE surface', () => {
  const engine = {
    async analyze() {},
    async expand() {},
    get() { return null; },
    session: {
      async resume() {}
    }
  };
  const plugin = createCorePluginAdapter({ engine });
  const manifest = plugin.describe();

  assert.equal(plugin.schema, CORE_PLUGIN_ADAPTER_SCHEMA);
  assert.equal(
    CORE_PLUGIN_ADAPTER_SCHEMA,
    'core.plugin-adapter/v1'
  );
  assert.equal(
    manifest.schema,
    CORE_PLUGIN_MANIFEST_SCHEMA
  );
  assert.equal(manifest.read_only_target, true);
  assert.equal(manifest.owns_provider_credentials, false);
  assert.equal(
    manifest.request_schema,
    'core.analysis-request/v1'
  );
  assert.equal(
    manifest.result_schema,
    'core.analysis-result/v1'
  );
  assert.deepEqual(
    manifest.capabilities,
    [
      'core.analyze',
      'core.expand',
      'core.get',
      'core.session.resume'
    ]
  );

  for (const forbidden of [
    'write',
    'mutate',
    'delete',
    'exec',
    'shell',
    'credentials',
    'providerCredentials'
  ]) {
    assert.equal(Object.hasOwn(plugin, forbidden), false);
  }
});

test('plugin adapter delegates real analyze expand and get without changing canonical result semantics', async () => {
  const engine = createCoreEngine();
  const plugin = createCorePluginAdapter({ engine });

  const input = request();
  const result = await plugin.analyze(input);
  validateAnalysisResultV1(result);

  assert.equal(result.schema, ANALYSIS_RESULT_SCHEMA);
  assert.equal(
    engine.hasAnalysis(result.analysis_id),
    true
  );

  const node = result.affected_symbols.find(item => item.node_id);
  assert.ok(node);

  const loaded = plugin.get(node.node_id);
  assert.ok(loaded);
  assert.equal(loaded.id, node.node_id);

  const delta = await plugin.expand(
    result.analysis_id,
    {
      kind: 'GRAPH_NODE',
      ref: node.node_id
    },
    {
      scope_depth: 1
    }
  );
  assert.equal(delta.schema, 'core.analysis-delta/v1');
  assert.equal(delta.analysis_id, result.analysis_id);
});

test('plugin adapter clones delegated inputs and outputs instead of sharing mutable host objects', async () => {
  const calls = [];
  const canonical = {
    schema: 'core.analysis-result/v1',
    analysis_id: 'analysis:test',
    session_id: 'session:test',
    repository: {
      schema: 'core.repository-identity/v1',
      vcs: 'filesystem',
      canonical_identity: 'filesystem:fixture',
      repository_id: 'repo:sha256:' + '1'.repeat(64)
    },
    snapshot: {
      schema: 'core.snapshot-identity/v1',
      kind: 'WORKSPACE',
      repository_id: 'repo:sha256:' + '1'.repeat(64),
      snapshot_id: 'snapshot:sha256:' + '2'.repeat(64),
      base_commit: null,
      content_manifest_digest: 'sha256:' + '3'.repeat(64),
      content_manifest: [],
      index_digest: null
    },
    status: 'COMPLETE',
    coverage: {
      schema: 'core.coverage/v1',
      completeness: 'COMPLETE',
      entries: [],
      universe_enumerable: true,
      closure: {
        kind: 'FULL',
        boundary_reached: false
      },
      snapshot_id: 'snapshot:sha256:' + '2'.repeat(64),
      fingerprint: 'sha256:' + '4'.repeat(64)
    },
    claims: [],
    evidence: [],
    evidence_refs: [],
    counterevidence_refs: [],
    graph_paths: [],
    affected_symbols: [],
    negated_hypotheses: [],
    unknowns: [],
    verifier_records: [],
    warnings: [],
    failures: [],
    recommended_validation: []
  };

  const engine = {
    async analyze(value) {
      calls.push(value);
      return canonical;
    },
    async expand(analysisId, target, budget) {
      calls.push({ analysisId, target, budget });
      return {
        schema: 'core.analysis-delta/v1',
        analysis_id: analysisId,
        target,
        budget
      };
    },
    get() {
      return { nested: { value: 1 } };
    },
    session: {
      async resume(sessionId, targetSnapshotId) {
        return {
          schema: 'core.session-handle/v1',
          session_id: sessionId,
          target_snapshot_id: targetSnapshotId
        };
      }
    }
  };
  const plugin = createCorePluginAdapter({ engine });

  const input = request();
  const output = await plugin.analyze(input);
  input.question = 'host-mutated after call';
  output.coverage.entries.push({
    id: 'mutated',
    role: 'PRIMARY',
    status: 'ANALYZED'
  });

  assert.notEqual(
    calls[0].question,
    'host-mutated after call'
  );
  assert.equal(canonical.coverage.entries.length, 0);

  const ref = plugin.get('ref:test');
  ref.nested.value = 99;
  assert.equal(engine.get().nested.value, 1);
});

test('ReasoningBridge evidence-cache capability rejects host claims of unknown evidence IDs', async () => {
  const bridge = createReasoningBridge({
    id: 'plugin-cache-host',
    version: 'v1',
    knownEvidenceIds: async () => ['evidence:not-in-task'],
    reason: async () => ({
      schema: 'core.proposed-claim-set/v1',
      proposals: []
    })
  });

  const task = {
    schema: 'core.reasoning-task/v1',
    analysis_id: 'analysis:test',
    request: {},
    capsule: {
      coverage: {
        snapshot_id: 'snapshot:test'
      },
      evidence: [{
        id: 'evidence:known',
        record: {
          schema: 'core.evidence/v1'
        }
      }],
      source_anchors: []
    },
    selected_node_ids: [],
    existing_claim_ids: []
  };

  await assert.rejects(
    () => bridge.reason(task),
    /unknown Evidence ID/
  );
});


test('plugin adapter rejects malformed expand and resume identities', async () => {
  const baseEngine = {
    async analyze() {
      throw new Error('unused');
    },
    async expand() {
      return {
        schema: 'core.analysis-delta/v1',
        analysis_id: 'analysis:wrong'
      };
    },
    get() {
      return null;
    },
    session: {
      async resume(sessionId) {
        return {
          schema: 'core.session-handle/v1',
          session_id: sessionId + ':wrong',
          target_snapshot_id: 'snapshot:test'
        };
      }
    }
  };

  const plugin = createCorePluginAdapter({ engine: baseEngine });

  await assert.rejects(
    () => plugin.expand(
      'analysis:expected',
      { kind: 'GRAPH_NODE', ref: 'node:test' }
    ),
    /analysis_id mismatch/
  );

  await assert.rejects(
    () => plugin.session.resume('session:expected'),
    /session_id mismatch/
  );

  const wrongSchemaPlugin = createCorePluginAdapter({
    engine: {
      ...baseEngine,
      async expand(analysisId) {
        return {
          schema: 'fixture.delta/v1',
          analysis_id: analysisId
        };
      },
      session: {
        async resume(sessionId) {
          return {
            schema: 'fixture.handle/v1',
            session_id: sessionId
          };
        }
      }
    }
  });

  await assert.rejects(
    () => wrongSchemaPlugin.expand(
      'analysis:expected',
      { kind: 'GRAPH_NODE', ref: 'node:test' }
    ),
    /core\.analysis-delta\/v1/
  );

  await assert.rejects(
    () => wrongSchemaPlugin.session.resume('session:expected'),
    /core\.session-handle\/v1/
  );
});

test('plugin session.resume validates requested target snapshot identity', async () => {
  const plugin = createCorePluginAdapter({
    engine: {
      async analyze() {
        throw new Error('unused');
      },
      async expand(analysisId) {
        return {
          schema: 'core.analysis-delta/v1',
          analysis_id: analysisId
        };
      },
      get() {
        return null;
      },
      session: {
        async resume(sessionId) {
          return {
            schema: 'core.session-handle/v1',
            session_id: sessionId,
            target_snapshot_id: 'snapshot:other'
          };
        }
      }
    }
  });

  await assert.rejects(
    () => plugin.session.resume(
      'session:test',
      'snapshot:expected'
    ),
    /target_snapshot_id mismatch/
  );
});
