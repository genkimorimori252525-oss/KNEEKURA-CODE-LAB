import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  analyze,
  analyzeInternal,
  createCoreEngine,
  createReasoningBridge,
  createStaticReasoningBridge,
  packEvidenceCapsule,
  renderAnalysisForAI
} from '../src/core/api.mjs';
import { validateAnalysisResultV1 } from '../src/core/schema/v1.mjs';
import { createSessionStore } from '../src/core/session/event-log.mjs';
import {
  toJollyResearchMailbox
} from '../src/adapters/jolly-research-mailbox.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FORGE_FIXTURE = path.join(ROOT, 'fixtures/forge-mini');
const TRACE = path.join(ROOT, 'fixtures/runtime/kneekura-trace.jsonl');
const SERVER_NET = path.join(ROOT, 'fixtures/runtime/kneekura-server.net.jsonl');
const CLIENT_NET = path.join(ROOT, 'fixtures/runtime/kneekura-client.net.jsonl');

function request(overrides = {}) {
  return {
    schema: 'core.analysis-request/v1',
    repository: FORGE_FIXTURE,
    mode: 'TRACE',
    question: 'Trace ReimuPacket through the selected code path.',
    scope: {
      paths: ['ReimuPacket.java']
    },
    policy: 'precision',
    output_profile: 'compact',
    ...overrides
  };
}

test('core.analyze works deterministically without a ReasoningBridge', async () => {
  const a = await analyze(request());
  const b = await analyze(request());

  validateAnalysisResultV1(a);
  validateAnalysisResultV1(b);
  assert.equal(a.analysis_id, b.analysis_id);
  assert.equal(a.session_id, b.session_id);
  assert.equal(a.snapshot.snapshot_id, b.snapshot.snapshot_id);
  assert.equal(a.coverage.fingerprint, b.coverage.fingerprint);
  assert.equal(a.failures.some(item =>
    item.code === 'REASONING_BRIDGE_FAILED'
  ), false);
});

test('ReasoningBridge can propose a hypothesis but CORE keeps it unresolved', async () => {
  const bridge = createReasoningBridge({
    id: 'fixture-host',
    version: 'v1',
    reason: async task => {
      const target = task.capsule.target_scope.find(item => item.node_id);
      return {
        schema: 'core.proposed-claim-set/v1',
        proposals: [{
          type: 'HYPOTHESIS',
          subject: { node_id: target.node_id },
          predicate: 'fixture.host_candidate',
          object_or_value: true
        }]
      };
    }
  });

  const result = await analyze(request({
    budget: { scope_depth: 0 }
  }), {
    reasoningBridge: bridge
  });

  const claim = result.claims.find(item =>
    item.predicate === 'fixture.host_candidate'
  );
  assert.ok(claim);
  assert.equal(claim.type, 'HYPOTHESIS');
  assert.equal(claim.status, 'UNRESOLVED');
  assert.equal(
    result.verifier_records.filter(record =>
      claim.verifier_results.some(item => item.id === record.id)
    ).length,
    claim.verifier_results.length
  );
});

test('host cannot forge OBSERVED authority through ReasoningBridge', async () => {
  const bridge = createStaticReasoningBridge({
    proposals: [{
      type: 'OBSERVED',
      subject: 'anything',
      predicate: 'runtime.packet_received',
      object_or_value: true,
      status: 'VERIFIED'
    }]
  });

  const result = await analyze(request(), {
    reasoningBridge: bridge
  });

  assert.equal(result.status, 'PARTIAL');
  assert.equal(
    result.failures.some(item =>
      item.code === 'REASONING_BRIDGE_FAILED'
    ),
    true
  );
  assert.equal(
    result.claims.some(item =>
      item.predicate === 'runtime.packet_received' &&
      item.provenance_refs?.some(ref =>
        String(ref).startsWith('reasoning-bridge:')
      )
    ),
    false
  );
});

test('ReasoningBridge NEGATIVE proposal remains unresolved without negative-search authority', async () => {
  const bridge = createReasoningBridge({
    id: 'negative-host',
    version: 'v1',
    reason: async task => {
      const target = task.capsule.target_scope.find(item => item.node_id);
      return {
        schema: 'core.proposed-claim-set/v1',
        proposals: [{
          type: 'NEGATIVE',
          subject: { node_id: target.node_id },
          predicate: 'fixture.no_handler_exists',
          object_or_value: true
        }]
      };
    }
  });

  const result = await analyze(request({
    budget: { scope_depth: 0 }
  }), {
    reasoningBridge: bridge
  });

  const claim = result.claims.find(item =>
    item.predicate === 'fixture.no_handler_exists'
  );
  assert.ok(claim);
  assert.equal(claim.type, 'NEGATIVE');
  assert.equal(claim.status, 'UNRESOLVED');
  assert.equal(
    claim.verifier_results.some(record =>
      record.findings.some(finding =>
        /UNSUPPORTED|UNIVERSE|PROVIDER|CAPABILITY/.test(finding.code)
      )
    ),
    true
  );
});

test('ReasoningBridge exact symbol outside deterministic candidate set is rejected', async () => {
  const bridge = createStaticReasoningBridge({
    proposals: [{
      type: 'HYPOTHESIS',
      subject: 'MainMod',
      predicate: 'fixture.out_of_scope',
      object_or_value: true
    }]
  });

  const result = await analyze(request({
    budget: { scope_depth: 0 }
  }), {
    reasoningBridge: bridge
  });

  assert.equal(
    result.claims.some(item => item.predicate === 'fixture.out_of_scope'),
    false
  );
  assert.equal(
    result.warnings.some(item =>
      item.code === 'PROPOSAL_SUBJECT_OUT_OF_SCOPE'
    ),
    true
  );
});

test('Evidence Capsule deduplicates IDs and tiny budget forces PARTIAL/BUDGET_EXHAUSTED', async () => {
  const execution = await analyzeInternal(request({
    budget: {
      scope_depth: 0,
      capsule_bytes: 1
    }
  }));

  const ids = execution.state.capsule.evidence.map(item => item.id);
  assert.equal(ids.length, new Set(ids).size);
  assert.equal(execution.state.capsule.budget.budget_exhausted, true);
  assert.equal(execution.result.status, 'PARTIAL');
  assert.equal(
    execution.result.warnings.some(item =>
      item.code === 'BUDGET_EXHAUSTED'
    ),
    true
  );
});

test('Evidence Capsule includes only applied rules matched by selected SAUs', async () => {
  const execution = await analyzeInternal(request({
    ruleset_overrides: [{
      rule_id: 'fixture.trace-rule',
      version: 'v1',
      selectors: {
        modes: ['TRACE'],
        paths: ['ReimuPacket.java']
      },
      content_reference: 'trace-only'
    }, {
      rule_id: 'fixture.audit-rule',
      version: 'v1',
      selectors: {
        modes: ['AUDIT']
      },
      content_reference: 'audit-only'
    }]
  }));

  const capsuleRules =
    execution.state.capsule.applicable_rules.map(item => item.rule_id);
  assert.equal(capsuleRules.includes('fixture.audit-rule'), false);
  for (const ruleId of capsuleRules) {
    assert.equal(
      execution.state.planning.rules.applied.some(rule =>
        rule.rule_id === ruleId
      ),
      true
    );
  }
});

test('public engine exposes analyze, bounded expand, and stable get', async () => {
  const engine = createCoreEngine();
  const result = await engine.analyze(request({
    budget: { scope_depth: 0 }
  }));

  assert.equal(engine.hasAnalysis(result.analysis_id), true);
  const firstSymbol = result.affected_symbols[0];
  assert.ok(firstSymbol);
  const node = engine.get(firstSymbol.node_id);
  assert.ok(node);
  assert.equal(node.id, firstSymbol.node_id);

  const delta = await engine.expand(
    result.analysis_id,
    { kind: 'SYMBOL', ref: 'MainMod' },
    { scope_depth: 1 }
  );
  assert.equal(delta.schema, 'core.analysis-delta/v1');
  assert.equal(delta.analysis_id, result.analysis_id);
  assert.equal(
    delta.affected_symbols.some(item =>
      item.key === 'demo.mod.MainMod' || item.label === 'MainMod'
    ),
    true
  );
});

test('persistent core.expand records a same-snapshot child session', async () => {
  const storageRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), 'kneekura-f-public-api-')
  );
  try {
    const sessionStore = createSessionStore({
      storageRoot,
      targetRepositoryRoot: FORGE_FIXTURE
    });
    const engine = createCoreEngine({ sessionStore });
    const result = await engine.analyze(request({
      budget: { scope_depth: 0 }
    }));
    const delta = await engine.expand(
      result.analysis_id,
      { kind: 'SYMBOL', ref: 'MainMod' },
      { scope_depth: 1 }
    );

    const child = await sessionStore.replay(delta.session_id);
    assert.equal(child.parent_session_id, result.session_id);
    assert.equal(child.target_snapshot_id, result.snapshot.snapshot_id);
    assert.equal(child.finalized, true);
    assert.equal(child.metrics.coverage_expansion_count, 1);
  } finally {
    await fs.rm(storageRoot, { recursive: true, force: true });
  }
});

test('runtime core.analyze preserves M5 without fabricating M6', async () => {
  const result = await analyze(request({
    mode: 'RUNTIME',
    question: 'Did the measured Molang path reach formal M6?',
    runtime_artifacts: [
      { kind: 'trace', path: TRACE },
      { kind: 'network', path: SERVER_NET },
      { kind: 'network', path: CLIENT_NET }
    ]
  }));

  assert.equal(
    result.claims.some(claim =>
      claim.predicate === 'ysm.client_command_consumed' &&
      ['VERIFIED','VERIFIED_WITH_LIMITS'].includes(claim.status)
    ),
    true
  );
  assert.equal(
    result.claims.some(claim =>
      claim.predicate === 'ysm.molang_state_applied' &&
      ['VERIFIED','VERIFIED_WITH_LIMITS'].includes(claim.status)
    ),
    false
  );
  assert.equal(
    result.recommended_validation.some(item =>
      item.code === 'M6_RUNTIME_VALIDATION_RECOMMENDED'
    ),
    true
  );

  const rendered = renderAnalysisForAI(result, { profile: 'compact' });
  assert.equal(rendered.includes('M6_RUNTIME_VALIDATION_RECOMMENDED'), true);
  assert.equal(rendered.includes('ysm.client_command_consumed'), true);
});

test('AI renderer preserves semantic qualifiers across compact and forensic profiles', async () => {
  const execution = await analyzeInternal(request({
    budget: { scope_depth: 0 }
  }));
  const compact = renderAnalysisForAI(execution.result, {
    profile: 'compact'
  });
  const forensic = renderAnalysisForAI(execution.result, {
    profile: 'forensic'
  });

  for (const claim of execution.result.claims) {
    assert.equal(compact.includes(claim.id), true);
    assert.equal(compact.includes(claim.status), true);
  }
  assert.equal(
    compact.includes(execution.result.coverage.completeness),
    true
  );
  for (const unknown of execution.result.unknowns) {
    assert.equal(compact.includes(String(unknown.ref)), true);
  }
  assert.ok(forensic.length >= compact.length);
  assert.ok(
    compact.length <
    JSON.stringify(execution.state.graph).length
  );
});

test('Jolly Research Mailbox is a consumer mapping, not the canonical schema', async () => {
  const result = await analyze(request({
    budget: { scope_depth: 0 }
  }));
  const mailbox = toJollyResearchMailbox(result);

  assert.equal(mailbox.schema, 'jolly.research-mailbox-analysis/v1');
  assert.equal(mailbox.source_schema, 'core.analysis-result/v1');
  assert.equal(mailbox.analysis_id, result.analysis_id);
  assert.equal(mailbox.coverage.completeness, result.coverage.completeness);
  assert.deepEqual(
    mailbox.claims.map(item => item.id),
    result.claims.map(item => item.id)
  );
});

test('ReasoningBridge cannot smuggle authoritative ID/status/verifier fields', async () => {
  const bridge = createReasoningBridge({
    id: 'forged-host',
    version: 'v1',
    reason: async () => ({
      schema: 'core.proposed-claim-set/v1',
      proposals: [{
        type: 'INFERRED',
        id: 'claim:forged',
        status: 'VERIFIED',
        verifier_results: [{ status: 'VERIFIED' }],
        subject: 'MainMod',
        predicate: 'fixture.forged',
        object_or_value: true
      }]
    })
  });

  const result = await analyze(request(), {
    reasoningBridge: bridge
  });
  assert.equal(result.status, 'PARTIAL');
  assert.equal(
    result.failures.some(item =>
      item.code === 'REASONING_BRIDGE_FAILED' &&
      /authoritative field/.test(item.message)
    ),
    true
  );
});

test('Evidence Capsule never substitutes an LLM summary for canonical evidence records', async () => {
  const execution = await analyzeInternal(request());
  const repacked = packEvidenceCapsule({
    request: execution.state.request,
    graph: execution.state.graph,
    planning: execution.state.planning,
    ledger: execution.state.ledger,
    profile: 'forensic',
    budget: {}
  });

  for (const packed of repacked.evidence) {
    const canonical = execution.state.ledger.evidence.find(item =>
      item.id === packed.id
    );
    assert.deepEqual(packed.record, canonical);
    assert.equal(Object.hasOwn(packed, 'llm_summary'), false);
  }
});
