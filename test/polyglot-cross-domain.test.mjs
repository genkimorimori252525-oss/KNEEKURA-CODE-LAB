import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { profileRepository } from '../src/analyzer-fabric/profile.mjs';
import { buildPolyglotProviderPlan } from '../src/analyzer-fabric/polyglot.mjs';
import { scanRepository } from '../src/core/scan.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function strategies(plan, filePath) {
  const row = plan.files.find(file => file.path === filePath);
  assert(row, `missing plan row ${filePath}`);
  return row.strategies;
}

test('Forge fixture prefers maintained Java semantics while preserving bespoke CORE domain evidence', async () => {
  const fixtureRoot = path.join(ROOT, 'fixtures', 'forge-mini');
  const profile = await profileRepository(fixtureRoot, {
    repositoryId: 'repo:step016-forge',
    snapshotId: 'snapshot:step016-forge'
  });
  const plan = buildPolyglotProviderPlan(profile, {
    toolAvailability: { 'scip-java': false, 'tree-sitter': false, 'ast-grep': false }
  });
  assert.equal(plan.forge_context_detected, true);
  assert.equal(plan.invariants.provider_priority_decides_truth, false);

  const java = strategies(plan, 'MainMod.java');
  assert.equal(java[0].provider_key, 'scip-java');
  assert.equal(java[0].tool_status, 'UNAVAILABLE');
  assert(java.some(item => item.provider_key === 'tree-sitter' && item.role === 'SYNTAX_FALLBACK'));
  assert(java.some(item => item.provider_key === 'builtin-java' && item.role === 'LEXICAL_FALLBACK' && item.tool_status === 'AVAILABLE'));
  for (const provider of ['forge-semantics', 'forge-1.20.1-network', 'minecraft-ysm-semantics']) {
    assert(java.some(item => item.provider_key === provider && item.role === 'DOMAIN_ENRICHMENT'), provider);
  }

  const gradle = strategies(plan, 'build.gradle');
  assert.equal(gradle[0].provider_key, 'ast-grep');
  assert.equal(gradle[0].role, 'STRUCTURAL_CONFIG_OR_BUILD');
  assert.equal(gradle[0].authority_level, 'STRUCTURAL_EVIDENCE');

  const mods = strategies(plan, 'mods.toml');
  assert.equal(mods[0].provider_key, 'ast-grep');
  assert(mods.some(item => item.provider_key === 'forge-mods-toml' && item.role === 'DOMAIN_ENRICHMENT'));

  const ysm = strategies(plan, 'ysm.animation.json');
  assert(ysm.some(item => item.provider_key === 'minecraft-ysm-json' && item.role === 'DOMAIN_ENRICHMENT'));

  const graph = await scanRepository(fixtureRoot);
  const edgeTypes = new Set(graph.edges.map(edge => edge.type));
  for (const edgeType of ['MOD_ENTRYPOINT','SUBSCRIBES_EVENT','CREATES_DEFERRED_REGISTER','MIXES_INTO','DECLARES_MOD','DEPENDS_MOD','OPTIONAL_MOD']) {
    assert(edgeTypes.has(edgeType), `legacy Forge semantic edge regressed: ${edgeType}`);
  }
  const evidenceProviders = new Set((graph.meta.evidence ?? []).map(record => record.provider_id));
  for (const providerId of ['builtin-java','forge-semantics','forge-mods-toml']) {
    assert(evidenceProviders.has(providerId), `legacy CORE evidence provider regressed: ${providerId}`);
  }
});

test('profile-driven mixed-language repository schedules maintained providers and leaves unknown files explicit', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kneekura-polyglot-step016-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const files = {
    'src/main.py': 'def main():\n    return 1\n',
    'src/main.go': 'package main\nfunc main() {}\n',
    'src/lib.rs': 'pub fn value() -> i32 { 1 }\n',
    'src/native.cpp': 'int value() { return 1; }\n',
    'src/App.cs': 'public class App {}\n',
    'pyproject.toml': '[project]\nname="fixture"\n',
    '.github/workflows/ci.yml': 'name: CI\non: [push]\njobs: {}\n',
    'assets/blob.weird': 'opaque\n'
  };
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, ...relative.split('/'));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, 'utf8');
  }

  const profile = await profileRepository(root, {
    repositoryId: 'repo:step016-mixed',
    snapshotId: 'snapshot:step016-mixed'
  });
  const plan = buildPolyglotProviderPlan(profile);
  const expected = new Map([
    ['src/main.py','scip-python'],
    ['src/main.go','scip-go'],
    ['src/lib.rs','rust-analyzer'],
    ['src/native.cpp','scip-clang'],
    ['src/App.cs','scip-dotnet']
  ]);
  for (const [filePath, provider] of expected) {
    assert.equal(strategies(plan, filePath)[0].provider_key, provider, filePath);
    assert.equal(strategies(plan, filePath)[0].execution_status, 'UNEXPLORED', filePath);
  }
  assert.equal(strategies(plan, 'pyproject.toml')[0].provider_key, 'ast-grep');
  assert.equal(strategies(plan, '.github/workflows/ci.yml')[0].provider_key, 'ast-grep');
  assert.equal(strategies(plan, 'assets/blob.weird')[0].role, 'EXPLICIT_UNEXPLORED_FALLBACK');
  assert(plan.summary.explicit_unexplored_paths.includes('assets/blob.weird'));
  assert.equal(plan.invariants.missing_tool_means_absent, false);
});
