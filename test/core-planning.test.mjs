import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GraphBuilder } from '../src/core/graph.mjs';
import { planScope } from '../src/core/scope/planner.mjs';
import {
  createCoverageManifest,
  updateCoverageEntry,
  finalizeCoverage,
  assertCoveragePartition
} from '../src/core/scope/coverage.mjs';
import { resolveRules } from '../src/core/rules/resolver.mjs';
import { buildSemanticAnalysisUnits } from '../src/core/scope/semantic-unit.mjs';
import { planDeterministicAnalysis } from '../src/core/planning.mjs';
import { scanRepository } from '../src/core/scan.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FORGE_FIXTURE = path.join(ROOT, 'fixtures/forge-mini');

function fixtureGraph() {
  const b = new GraphBuilder('/fixture');
  const fileA = b.node('file', 'src/A.java', { path: 'src/A.java', language: 'java' });
  const fileB = b.node('file', 'src/B.java', { path: 'src/B.java', language: 'java' });
  const fileC = b.node('file', 'src/C.java', { path: 'src/C.java', language: 'java' });
  const service = b.node('class', 'demo.a.Foo', { label: 'Foo', path: 'src/A.java', language: 'java' });
  const otherFoo = b.node('class', 'demo.b.Foo', { label: 'Foo', path: 'src/B.java', language: 'java' });
  const repo = b.node('class', 'demo.repo.Repository', { label: 'Repository', path: 'src/C.java', language: 'java' });
  const config = b.node('resource', 'config/demo.json', { label: 'demo.json', path: 'config/demo.json' });
  const unrelated = b.node('class', 'demo.unrelated.Other', { label: 'Other', path: 'src/Other.java', language: 'java' });
  const runtime = b.node('runtime_entity', 'entity-42', { label: 'entity-42', run: 'run-42', uuid: 'uuid-42', runtimeObserved: true });

  b.edge(fileA, service, 'DECLARES', { source: 'src/A.java' });
  b.edge(fileB, otherFoo, 'DECLARES', { source: 'src/B.java' });
  b.edge(fileC, repo, 'DECLARES', { source: 'src/C.java' });
  b.edge(service, repo, 'CALLS', { source: 'src/A.java', confidence: 1 });
  b.edge(repo, config, 'REFERENCES', { source: 'src/C.java', confidence: 1 });
  b.edge(repo, unrelated, 'CORRELATED_WITH', { source: 'history', confidence: 1, strength: 'CORRELATED' });

  const graph = b.finish();
  graph.meta.repository = {
    schema: 'core.repository-identity/v1',
    vcs: 'filesystem',
    canonical_identity: 'local:/fixture',
    repository_id: 'repo:sha256:' + '1'.repeat(64)
  };
  graph.meta.snapshot = {
    schema: 'core.snapshot-identity/v1',
    kind: 'WORKSPACE',
    repository_id: graph.meta.repository.repository_id,
    snapshot_id: 'snapshot:sha256:' + '2'.repeat(64),
    base_commit: null,
    content_manifest_digest: 'sha256:' + '3'.repeat(64),
    content_manifest: [],
    index_digest: null
  };
  graph.meta.platform = {
    detected: { loader: 'forge' },
    primaryTarget: { key: 'forge-1.20.1-47.x' },
    compatibility: 'PRIMARY_EXACT'
  };
  graph.meta.evidence = [{
    schema: 'core.evidence/v1',
    id: 'evidence:runtime-42',
    kind: 'RUNTIME',
    observation: { entity: 'entity-42' },
    provenance: {
      repository_id: graph.meta.repository.repository_id,
      snapshot_id: graph.meta.snapshot.snapshot_id,
      provider_id: 'runtime-test',
      provider_version: 'v1',
      extraction_method: 'fixture',
      artifact_id: 'artifact:runtime-42',
      artifact_digest: 'sha256:' + '4'.repeat(64),
      runtime_run_id: 'run-42'
    },
    integrity_digest: 'sha256:' + '5'.repeat(64),
    trust_class: 'RUNTIME_MEASURED',
    provider_id: 'runtime-test',
    provider_version: 'v1'
  }];
  return { graph, nodes: { fileA, fileB, fileC, service, otherFoo, repo, config, unrelated, runtime } };
}

test('scope planner resolves exact paths, graph nodes, runtime refs and explicit ambiguous symbol candidates', () => {
  const { graph, nodes } = fixtureGraph();
  const plan = planScope(graph, {
    mode: 'TRACE',
    seeds: [
      { kind: 'PATH', value: 'src/A.java' },
      { kind: 'SYMBOL', value: 'Foo' },
      { kind: 'GRAPH_NODE', value: nodes.repo.id },
      { kind: 'RUNTIME_REF', value: 'run-42' }
    ]
  }, { maxDepth: 0 });

  const symbolSeed = plan.seeds.find(item => item.seed.kind === 'SYMBOL');
  assert.equal(symbolSeed.status, 'AMBIGUOUS');
  assert.equal(symbolSeed.candidate_ids.length, 2);
  assert.equal(plan.selected_ids.includes('node:' + nodes.fileA.id), true);
  const pathSeed = plan.seeds.find(item => item.seed.kind === 'PATH');
  assert.equal(pathSeed.status, 'RESOLVED');
  assert.deepEqual(pathSeed.candidate_ids, ['node:' + nodes.fileA.id]);
  assert.equal(plan.selected_ids.includes('node:' + nodes.repo.id), true);
  assert.equal(plan.selected_ids.includes('node:' + nodes.runtime.id), true);
  assert.equal(plan.selected_ids.includes('evidence:runtime-42'), true);
  assert.equal(plan.decisions.every(item => item.planner_id === 'core-scope-planner'), true);
});

test('diff file seed is resolved as a primary path seed', () => {
  const { graph, nodes } = fixtureGraph();
  const plan = planScope(graph, {
    mode: 'REVIEW',
    seeds: [{ kind: 'DIFF_FILE', value: 'src/B.java' }]
  }, { maxDepth: 0 });

  const item = plan.items.find(entry => entry.node_id === nodes.fileB.id);
  assert.ok(item);
  assert.equal(item.role, 'PRIMARY');
});

test('explicit depth horizon produces BOUNDED coverage rather than pretending completeness', () => {
  const { graph, nodes } = fixtureGraph();
  const plan = planScope(graph, {
    mode: 'TRACE',
    seeds: [{ kind: 'GRAPH_NODE', value: nodes.service.id }]
  }, { maxDepth: 1 });

  const terminal = finalizeCoverage(
    plan.coverage.entries.reduce((manifest, entry) => {
      if (entry.status === 'PENDING') updateCoverageEntry(manifest, entry.id, 'ANALYZED');
      return manifest;
    }, structuredClone(plan.coverage))
  );

  assert.equal(terminal.completeness, 'BOUNDED');
  assert.equal(
    terminal.entries.some(entry => entry.reason_code === 'DEPTH_HORIZON' && entry.status === 'UNEXPLORED'),
    true
  );
});

test('analyzer failure yields PARTIAL coverage and terminal manifest has no pending entries', () => {
  const manifest = createCoverageManifest([
    { id: 'a', role: 'PRIMARY' },
    { id: 'b', role: 'DEPENDENCY' }
  ]);
  updateCoverageEntry(manifest, 'a', 'ANALYZED');
  updateCoverageEntry(manifest, 'b', 'FAILED', {
    reason: 'parser failed',
    reasonCode: 'PARSE_FAILED'
  });
  const terminal = finalizeCoverage(manifest);

  assert.equal(terminal.completeness, 'PARTIAL');
  assertCoveragePartition(terminal, ['a','b']);
});

test('unenumerable candidate universe yields UNKNOWN even when selected items are analyzed', () => {
  const manifest = createCoverageManifest([
    { id: 'a', role: 'PRIMARY' }
  ], { universeEnumerable: false });
  updateCoverageEntry(manifest, 'a', 'ANALYZED');
  const terminal = finalizeCoverage(manifest);
  assert.equal(terminal.completeness, 'UNKNOWN');
});

test('coverage finalizer converts silently pending items into explicit unexplored gaps', () => {
  const terminal = finalizeCoverage(createCoverageManifest([
    { id: 'a', role: 'PRIMARY' }
  ]));
  assert.equal(terminal.entries[0].status, 'UNEXPLORED');
  assert.equal(terminal.entries[0].reason_code, 'FINALIZE_BACKSTOP');
  assert.equal(terminal.completeness, 'PARTIAL');
});

test('rule resolver records applied/rejected rules and request precedence shadows repository rule', () => {
  const { graph, nodes } = fixtureGraph();
  const scope = planScope(graph, {
    mode: 'TRACE',
    seeds: [{ kind: 'GRAPH_NODE', value: nodes.service.id }]
  }, { maxDepth: 1 });

  const resolution = resolveRules({
    graph,
    request: {
      mode: 'TRACE',
      ruleset_overrides: [{
        rule_id: 'demo.same',
        version: 'request-v1',
        selectors: { modes: ['TRACE'] },
        content_reference: 'request-rule'
      }]
    },
    scope,
    repositoryRules: [{
      rule_id: 'demo.same',
      version: 'repo-v1',
      selectors: { modes: ['TRACE'] },
      content_reference: 'repo-rule'
    }, {
      rule_id: 'demo.audit-only',
      version: 'v1',
      selectors: { modes: ['AUDIT'] },
      content_reference: 'audit-only'
    }]
  });

  const winner = resolution.applied.find(rule => rule.rule_id === 'demo.same');
  assert.equal(winner.version, 'request-v1');
  assert.equal(winner.source_class, 'request');
  assert.equal(
    resolution.rejected.some(rule => rule.rule_id === 'demo.same' && /shadowed/.test(rule.reason)),
    true
  );
  assert.equal(
    resolution.rejected.some(rule => rule.rule_id === 'demo.audit-only' && /selector mismatch/.test(rule.reason)),
    true
  );
  assert.match(resolution.resolution_fingerprint, /^sha256:[0-9a-f]{64}$/);
});

test('SAUs group strong semantic relationships but do not group correlated unrelated nodes', () => {
  const { graph, nodes } = fixtureGraph();
  const scope = planScope(graph, {
    mode: 'DIAGNOSE',
    seeds: [
      { kind: 'GRAPH_NODE', value: nodes.service.id },
      { kind: 'GRAPH_NODE', value: nodes.unrelated.id }
    ]
  }, { maxDepth: 2 });
  const rules = resolveRules({ graph, request: { mode: 'DIAGNOSE' }, scope });
  const result = buildSemanticAnalysisUnits(graph, scope, rules, { maxUnitItems: 20 });

  const serviceUnit = result.units.find(unit =>
    [...unit.primary_targets, ...unit.dependency_items, ...unit.supporting_items]
      .includes('node:' + nodes.service.id)
  );
  const unrelatedUnit = result.units.find(unit =>
    [...unit.primary_targets, ...unit.dependency_items, ...unit.supporting_items]
      .includes('node:' + nodes.unrelated.id)
  );

  assert.ok(serviceUnit);
  assert.ok(unrelatedUnit);
  assert.notEqual(serviceUnit.id, unrelatedUnit.id);
  const serviceMembers = [
    ...serviceUnit.primary_targets,
    ...serviceUnit.dependency_items,
    ...serviceUnit.supporting_items
  ];
  assert.equal(serviceMembers.includes('node:' + nodes.repo.id), true);
  assert.equal(serviceMembers.includes('node:' + nodes.config.id), true);
});

test('ambiguous exact symbol candidates remain separate deterministic units when no strong edge joins them', () => {
  const { graph, nodes } = fixtureGraph();
  const scope = planScope(graph, {
    mode: 'TRACE',
    seeds: [{ kind: 'SYMBOL', value: 'Foo' }]
  }, { maxDepth: 0 });
  const rules = resolveRules({ graph, request: { mode: 'TRACE' }, scope });
  const result = buildSemanticAnalysisUnits(graph, scope, rules);

  const candidateIds = new Set(['node:' + nodes.service.id, 'node:' + nodes.otherFoo.id]);
  const unitsWithCandidates = result.units.filter(unit =>
    [...unit.primary_targets, ...unit.dependency_items, ...unit.supporting_items]
      .some(id => candidateIds.has(id))
  );

  assert.equal(unitsWithCandidates.length, 2);
  assert.equal(
    unitsWithCandidates.every(unit =>
      [...unit.primary_targets, ...unit.dependency_items, ...unit.supporting_items]
        .filter(id => candidateIds.has(id)).length === 1
    ),
    true
  );
});

test('SAU size split assigns every selected item exactly once', () => {
  const b = new GraphBuilder('/split');
  const nodes = [];
  for (let i = 0; i < 7; i++) nodes.push(b.node('class', 'N' + i, { label: 'N' + i, language: 'java' }));
  for (let i = 0; i < nodes.length - 1; i++) b.edge(nodes[i], nodes[i + 1], 'CALLS');
  const graph = b.finish();
  const scope = planScope(graph, {
    mode: 'TRACE',
    seeds: [{ kind: 'GRAPH_NODE', value: nodes[0].id }]
  }, { maxDepth: 10 });
  const rules = resolveRules({ graph, request: { mode: 'TRACE' }, scope });
  const result = buildSemanticAnalysisUnits(graph, scope, rules, { maxUnitItems: 3 });

  assert.equal(result.units.length >= 3, true);
  const ids = result.units.flatMap(unit => [
    ...unit.primary_targets,
    ...unit.dependency_items,
    ...unit.supporting_items
  ]);
  assert.equal(ids.length, new Set(ids).size);
  assert.deepEqual(new Set(ids), new Set(scope.selected_ids));
});

test('deterministic planning returns stable scope/rule/SAU fingerprints for identical input', () => {
  const { graph, nodes } = fixtureGraph();
  const request = {
    mode: 'TRACE',
    seeds: [{ kind: 'GRAPH_NODE', value: nodes.service.id }]
  };
  const a = planDeterministicAnalysis(graph, request, { scope: { maxDepth: 2 } });
  const b = planDeterministicAnalysis(graph, request, { scope: { maxDepth: 2 } });

  assert.equal(a.scope.deterministic_fingerprint, b.scope.deterministic_fingerprint);
  assert.equal(a.rules.resolution_fingerprint, b.rules.resolution_fingerprint);
  assert.equal(a.semantic_units.deterministic_fingerprint, b.semantic_units.deterministic_fingerprint);
  assert.equal(a.deterministic_fingerprint, b.deterministic_fingerprint);
  assert.equal(a.coverage.entries.some(entry => entry.status === 'PENDING'), false);
});

test('item budget exhaustion is PARTIAL, not the safer explicit-depth BOUNDED state', () => {
  const { graph, nodes } = fixtureGraph();
  const plan = planScope(graph, {
    mode: 'TRACE',
    seeds: [{ kind: 'GRAPH_NODE', value: nodes.service.id }]
  }, { maxDepth: 5, maxItems: 1 });

  const manifest = structuredClone(plan.coverage);
  for (const entry of manifest.entries) {
    if (entry.status === 'PENDING') updateCoverageEntry(manifest, entry.id, 'ANALYZED');
  }
  const terminal = finalizeCoverage(manifest);
  assert.equal(terminal.completeness, 'PARTIAL');
  assert.equal(terminal.entries.some(entry => entry.reason_code === 'BUDGET_EXHAUSTED'), true);
});


test('current Forge/YSM semantic edge vocabulary remains traversable and grouped deterministically', () => {
  const b = new GraphBuilder('/domain');
  const file = b.node('file', 'src/ReimuPacket.java', { path: 'src/ReimuPacket.java', language: 'java' });
  const packetClass = b.node('class', 'demo.ReimuPacket', { label: 'ReimuPacket', path: 'src/ReimuPacket.java', language: 'java' });
  const packet = b.node('network_packet', 'ReimuPacket', { label: 'ReimuPacket' });
  const handler = b.node('method', 'demo.ReimuPacket#handle(2)', { label: 'handle', path: 'src/ReimuPacket.java' });
  const molang = b.node('molang_variable', 'v.wuqi', { label: 'v.wuqi' });
  const animation = b.node('animation_name', 'idle2', { label: 'idle2' });
  const bone = b.node('bone_name', 'head', { label: 'head' });
  const resource = b.node('resource', 'ysm.animation.json', { label: 'ysm.animation.json', path: 'ysm.animation.json' });

  b.edge(file, packetClass, 'DECLARES');
  b.edge(packetClass, packet, 'IMPLEMENTS_PACKET');
  b.edge(packet, handler, 'HANDLED_BY');
  b.edge(handler, molang, 'WRITES_MOLANG');
  b.edge(molang, animation, 'PROVIDES_ANIMATION_NAME');
  b.edge(animation, bone, 'ANIMATES_BONE');
  b.edge(packetClass, resource, 'REFERENCES_RESOURCE');

  const graph = b.finish();
  const scope = planScope(graph, {
    mode: 'TRACE',
    seeds: [{ kind: 'PATH', value: 'src/ReimuPacket.java' }]
  }, { maxDepth: 6 });
  const rules = resolveRules({ graph, request: { mode: 'TRACE' }, scope });
  const saus = buildSemanticAnalysisUnits(graph, scope, rules, { maxUnitItems: 20 });

  const selected = new Set(scope.selected_ids);
  for (const node of [file, packetClass, packet, handler, molang, animation, bone, resource]) {
    assert.equal(selected.has('node:' + node.id), true, 'expected traversal to include ' + node.kind);
  }

  const domainUnit = saus.units.find(unit => unit.primary_targets.includes('node:' + file.id));
  assert.ok(domainUnit);
  const members = new Set([
    ...domainUnit.primary_targets,
    ...domainUnit.dependency_items,
    ...domainUnit.supporting_items
  ]);
  assert.equal(members.has('node:' + bone.id), true);
  assert.equal(members.has('node:' + resource.id), true);
});

test('broad external containment and co-change relationships cannot become authoritative SAU edges', () => {
  const b = new GraphBuilder('/external');
  const a = b.node('class', 'A');
  const bnode = b.node('class', 'B');
  const c = b.node('class', 'C');
  b.edge(a, bnode, 'UA_CONTAINS', { confidence: 1 });
  b.edge(bnode, c, 'CODEGRAPH_COCHANGE', { confidence: 1 });

  const graph = b.finish();
  const scope = planScope(graph, {
    mode: 'UNDERSTAND',
    seeds: [
      { kind: 'GRAPH_NODE', value: a.id },
      { kind: 'GRAPH_NODE', value: bnode.id },
      { kind: 'GRAPH_NODE', value: c.id }
    ]
  }, { maxDepth: 0 });
  const rules = resolveRules({ graph, request: { mode: 'UNDERSTAND' }, scope });
  const saus = buildSemanticAnalysisUnits(graph, scope, rules);

  assert.equal(saus.units.length, 3);
});


test('real forge-mini graph plans ReimuPacket and YSM Molang scope without LLM authority', async () => {
  const graph = await scanRepository(FORGE_FIXTURE);
  const request = {
    mode: 'TRACE',
    seeds: [
      { kind: 'SYMBOL', value: 'demo.net.ReimuPacket' },
      { kind: 'SYMBOL', value: 'v.wuqi' }
    ]
  };

  const first = planDeterministicAnalysis(graph, request, {
    scope: { maxDepth: 4 },
    semanticUnits: { maxUnitItems: 30 }
  });
  const second = planDeterministicAnalysis(graph, request, {
    scope: { maxDepth: 4 },
    semanticUnits: { maxUnitItems: 30 }
  });

  const packetSeed = first.scope.seeds.find(item =>
    item.seed.kind === 'SYMBOL' && item.seed.value === 'demo.net.ReimuPacket'
  );
  const molangSeed = first.scope.seeds.find(item =>
    item.seed.kind === 'SYMBOL' && item.seed.value === 'v.wuqi'
  );

  assert.equal(packetSeed.status, 'RESOLVED');
  assert.equal(molangSeed.status, 'RESOLVED');
  assert.equal(molangSeed.resolution_method, 'CANONICAL_ALIAS');
  const molangCandidate = first.scope.items.find(item =>
    molangSeed.candidate_ids.includes(item.id)
  );
  assert.ok(molangCandidate);
  assert.equal(
    graph.nodes.find(node => node.id === molangCandidate.node_id)?.key,
    'variable.wuqi'
  );
  assert.equal(first.coverage_initial.entries.some(entry => entry.status === 'PENDING'), true);
  assert.equal(first.coverage.entries.some(entry => entry.status === 'PENDING'), false);
  assert.equal(
    first.scope.decisions.every(decision =>
      decision.reason &&
      decision.cause &&
      decision.planner_id === 'core-scope-planner' &&
      decision.planner_version === 'v1'
    ),
    true
  );
  assert.equal(first.rules.applied.some(rule => rule.rule_id === 'core.java.structural'), true);
  assert.equal(first.rules.applied.some(rule => rule.rule_id === 'core.forge.network-semantics'), true);
  assert.equal(first.rules.applied.some(rule => rule.rule_id === 'core.ysm.semantic-contracts'), true);

  const packetNode = graph.nodes.find(node =>
    node.kind === 'class' && node.key === 'demo.net.ReimuPacket'
  );
  const packetSemantic = graph.nodes.find(node =>
    node.kind === 'network_message' && node.label === 'ReimuPacket'
  );
  assert.ok(packetNode);
  assert.ok(packetSemantic);

  const packetUnit = first.semantic_units.units.find(unit =>
    [...unit.primary_targets, ...unit.dependency_items, ...unit.supporting_items]
      .includes('node:' + packetNode.id)
  );
  assert.ok(packetUnit);
  assert.equal(
    [...packetUnit.primary_targets, ...packetUnit.dependency_items, ...packetUnit.supporting_items]
      .includes('node:' + packetSemantic.id),
    true
  );

  assert.equal(first.deterministic_fingerprint, second.deterministic_fingerprint);
  assert.equal(Object.hasOwn(first, 'claims'), false);
});


test('Molang source aliases resolve deterministically without fuzzy symbol matching', () => {
  const b = new GraphBuilder('/molang-alias');
  const canonical = b.node('molang_variable', 'variable.foo', { label: 'variable.foo' });
  const unrelated = b.node('molang_variable', 'variable.foobar', { label: 'variable.foobar' });
  const graph = b.finish();

  const alias = planScope(graph, {
    mode: 'TRACE',
    seeds: [{ kind: 'SYMBOL', value: 'v.foo' }]
  }, { maxDepth: 0 });
  const seed = alias.seeds[0];

  assert.equal(seed.status, 'RESOLVED');
  assert.equal(seed.resolution_method, 'CANONICAL_ALIAS');
  assert.deepEqual(seed.candidate_ids, ['node:' + canonical.id]);
  assert.equal(seed.candidate_ids.includes('node:' + unrelated.id), false);
});


test('analysis mode without a deterministic seed is UNKNOWN instead of vacuously COMPLETE', () => {
  const { graph } = fixtureGraph();
  const result = planDeterministicAnalysis(graph, { mode: 'TRACE' });

  assert.equal(result.scope.seeds.length, 0);
  assert.equal(result.scope.universe_enumerable, false);
  assert.equal(result.coverage.completeness, 'UNKNOWN');
  const unresolved = result.coverage.entries.find(entry =>
    entry.reason_code === 'SCOPE_UNRESOLVABLE'
  );
  assert.ok(unresolved);
  assert.equal(unresolved.status, 'UNEXPLORED');
});


test('coverage fingerprint is snapshot-bound for safe future cache invalidation', () => {
  const make = snapshotId => {
    const manifest = createCoverageManifest([
      { id: 'same-node', role: 'PRIMARY' }
    ], { snapshotId });
    updateCoverageEntry(manifest, 'same-node', 'ANALYZED');
    return finalizeCoverage(manifest);
  };

  const a = make('snapshot:sha256:' + 'a'.repeat(64));
  const b = make('snapshot:sha256:' + 'b'.repeat(64));
  assert.notEqual(a.fingerprint, b.fingerprint);
});

test('SAU fingerprint changes when its deterministic budget contract changes', () => {
  const { graph, nodes } = fixtureGraph();
  const scope = planScope(graph, {
    mode: 'TRACE',
    seeds: [{ kind: 'GRAPH_NODE', value: nodes.service.id }]
  }, { maxDepth: 2 });
  const rules = resolveRules({ graph, request: { mode: 'TRACE' }, scope });

  const a = buildSemanticAnalysisUnits(graph, scope, rules, { maxUnitItems: 20 });
  const b = buildSemanticAnalysisUnits(graph, scope, rules, { maxUnitItems: 21 });

  const unitA = a.units.find(unit =>
    [...unit.primary_targets, ...unit.dependency_items, ...unit.supporting_items]
      .includes('node:' + nodes.service.id)
  );
  const unitB = b.units.find(unit =>
    [...unit.primary_targets, ...unit.dependency_items, ...unit.supporting_items]
      .includes('node:' + nodes.service.id)
  );
  assert.ok(unitA);
  assert.ok(unitB);
  assert.notEqual(unitA.deterministic_fingerprint, unitB.deterministic_fingerprint);
});


test('semantic relationship matching is case-normalized without weakening correlated-edge rejection', () => {
  const b = new GraphBuilder('/case');
  const a = b.node('class', 'A');
  const target = b.node('class', 'B');
  const unrelated = b.node('class', 'C');
  b.edge(a, target, 'calls', { confidence: 1 });
  b.edge(target, unrelated, 'codegraph_cochange', { confidence: 1 });

  const graph = b.finish();
  const scope = planScope(graph, {
    mode: 'TRACE',
    seeds: [{ kind: 'GRAPH_NODE', value: a.id }]
  }, { maxDepth: 2 });

  assert.equal(scope.selected_ids.includes('node:' + target.id), true);
  assert.equal(scope.selected_ids.includes('node:' + unrelated.id), false);
});

test('runtime evidence scope IDs reuse canonical EvidenceRecord IDs without double prefixing', () => {
  const { graph } = fixtureGraph();
  const plan = planScope(graph, {
    mode: 'RUNTIME',
    seeds: [{ kind: 'RUNTIME_REF', value: 'artifact:runtime-42' }]
  }, { maxDepth: 0 });

  const evidenceItem = plan.items.find(item => item.evidence_id === 'evidence:runtime-42');
  assert.ok(evidenceItem);
  assert.equal(evidenceItem.id, 'evidence:runtime-42');
});

test('SAU purpose is semantic and does not encode a pre-sort ordinal', () => {
  const { graph, nodes } = fixtureGraph();
  const scope = planScope(graph, {
    mode: 'TRACE',
    seeds: [
      { kind: 'GRAPH_NODE', value: nodes.service.id },
      { kind: 'GRAPH_NODE', value: nodes.unrelated.id }
    ]
  }, { maxDepth: 1 });
  const rules = resolveRules({ graph, request: { mode: 'TRACE' }, scope });
  const saus = buildSemanticAnalysisUnits(graph, scope, rules);

  assert.equal(saus.units.every(unit => /^Semantic unit: /.test(unit.purpose)), true);
  assert.equal(saus.units.every(unit => !/^Semantic unit \d+:/.test(unit.purpose)), true);
});
