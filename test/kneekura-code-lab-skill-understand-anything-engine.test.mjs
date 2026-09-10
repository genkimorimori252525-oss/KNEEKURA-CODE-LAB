import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyUaOrchestration, reconcileUaCoverage, validateUaKnowledgeGraph } from '../src/skill/engines/understand-anything.mjs';

test('UA native claim requires upstream-subagent mode, separate contexts, and host isolation', () => {
  assert.deepEqual(classifyUaOrchestration({ mode: 'native-upstream-subagents', isolation: 'separate-contexts' }, { semanticSubagentIsolation: true }), { mode: 'native-upstream-subagents', isolation: 'separate-contexts', orchestrationMode: 'native', claimLevel: 'NATIVE' });
  assert.equal(classifyUaOrchestration({ mode: 'native-upstream-subagents', isolation: 'shared-context' }, { semanticSubagentIsolation: true }).claimLevel, 'COMPATIBLE');
  assert.equal(classifyUaOrchestration({ mode: 'native-upstream-subagents', isolation: 'separate-contexts' }, { semanticSubagentIsolation: false }).claimLevel, 'COMPATIBLE');
  assert.equal(classifyUaOrchestration({ mode: 'portable-compatible', isolation: 'separate-contexts' }, { semanticSubagentIsolation: true }).claimLevel, 'COMPATIBLE');
});

test('UA coverage reconciliation makes target ignore losses visible', () => {
  const coverage = reconcileUaCoverage({ entries: [
    { path: 'src/a.js', classification: 'semantic-input' },
    { path: 'src/b.js', classification: 'semantic-input' },
    { path: 'large.bin', classification: 'metadata-only' }
  ] }, [{ path: 'src/a.js' }]);
  assert.deepEqual(coverage.hostSemanticInputs, ['src/a.js', 'src/b.js']);
  assert.deepEqual(coverage.missingHostSemanticInputs, ['src/b.js']);
});

test('UA graph validation enforces layer and tour references', () => {
  const good = { nodes: [{ id: 'file:src/a.js', type: 'file', name: 'a.js', summary: 'A', tags: ['a'] }], edges: [], layers: [{ id: 'layer:one', name: 'One', description: 'One', nodeIds: ['file:src/a.js'] }], tour: [{ order: 1, title: 'Start', description: 'Start', nodeIds: ['file:src/a.js'] }] };
  assert.equal(validateUaKnowledgeGraph(good).ok, true);
  const bad = structuredClone(good); bad.layers[0].nodeIds = []; bad.tour[0].nodeIds = ['file:missing.js'];
  const result = validateUaKnowledgeGraph(bad);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some(issue => issue.includes('not assigned to a layer')));
  assert.ok(result.issues.some(issue => issue.includes('references missing node')));
});