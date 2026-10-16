import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(
  path.dirname(fileURLToPath(import.meta.url))
);

async function read(relative) {
  return fs.readFile(path.join(ROOT, relative), 'utf8');
}

test('human-analysis delivery contract declares AI-assisted-by-design semantics', async () => {
  const config = JSON.parse(await read(
    'config/human-analysis-delivery.v1.json'
  ));

  assert.equal(
    config.schema,
    'kneekura.human-analysis-delivery/v1'
  );
  assert.equal(config.mode, 'AI_ASSISTED_BY_DESIGN');
  assert.equal(
    config.intent.ai_semantic_authoring_first_class,
    true
  );
  assert.equal(
    config.intent.ai_independent_semantic_understanding_goal,
    false
  );
  assert.equal(
    config.intent.canonical_evidence_authority,
    'KNEEKURA_CORE_REGISTERED_ANALYZERS_AND_RUNTIME_EVIDENCE'
  );
  assert.equal(
    config.intent.semantic_authoring_authority,
    'AI_WITH_EXPLICIT_PROVENANCE_AND_INTERPRETATION_LABELS'
  );
});

test('artifact-first delivery prefers self-contained HTML plus ZIP and executable fallback', async () => {
  const config = JSON.parse(await read(
    'config/human-analysis-delivery.v1.json'
  ));

  assert.equal(config.delivery.chat_only_default, false);
  assert.equal(
    config.delivery.primary,
    'SELF_CONTAINED_OFFLINE_HTML'
  );
  assert.equal(config.delivery.companion, 'ZIP_BUNDLE');
  assert.equal(
    config.delivery.no_file_generation_fallback,
    'EXECUTABLE_GENERATOR_CODE'
  );
  assert.deepEqual(
    config.bundle.required,
    [
      'index.html',
      'manifest.json',
      'analysis.json',
      'sources.json',
      'coverage.json',
      'README.md'
    ]
  );
});

test('semantic classes and missing-language fallback remain explicit', async () => {
  const config = JSON.parse(await read(
    'config/human-analysis-delivery.v1.json'
  ));

  assert.deepEqual(
    config.semantic_classes,
    [
      'CANONICAL_FACT',
      'AI_INTERPRETATION',
      'COVERAGE_GAP',
      'UNKNOWN'
    ]
  );
  assert.equal(
    config.missing_language_support.blocks_human_analysis,
    false
  );
  for (const required of [
    'RECORD_COVERAGE_GAP',
    'INSPECT_SOURCE_DIRECTLY_WITH_AI',
    'DELIVER_ARTIFACT_ANYWAY',
    'LABEL_NONCANONICAL_SEMANTICS_AI_INTERPRETATION',
    'DO_NOT_PRETEND_MISSING_SCANNER_PRODUCED_CANONICAL_FACTS'
  ]) {
    assert.ok(
      config.missing_language_support.required_behavior
        .includes(required),
      `missing behavior: ${required}`
    );
  }
});

test('root agent guidance makes human-code-analysis requests artifact-first', async () => {
  const agents = await read('AGENTS.md');

  for (const required of [
    'AI-assisted by design',
    '人間用にコード分析して',
    'artifact-first human analysis',
    'self-contained offline HTML guide',
    'ZIP companion bundle',
    'EXECUTABLE_GENERATOR_CODE',
    'AI_INTERPRETATION',
    'COVERAGE_GAP',
    'missing deterministic language scanner is **not** a reason to refuse'
  ]) {
    assert.equal(
      agents.includes(required),
      true,
      `AGENTS.md missing contract phrase: ${required}`
    );
  }
});

test('docs combine Understand Anything, Archify and KNEEKURA without weakening canonical facts', async () => {
  const [contract, readme, presentation] = await Promise.all([
    read('docs/AI_ASSISTED_HUMAN_ANALYSIS.md'),
    read('README.md'),
    read('docs/HUMAN_PRESENTATION_V2.md')
  ]);

  for (const source of [contract, readme, presentation]) {
    assert.match(source, /AI Semantic Author/);
  }
  assert.match(contract, /Understand Anything-inspired strengths/);
  assert.match(contract, /Archify-inspired strengths/);
  assert.match(contract, /KNEEKURA-native strengths/);
  assert.match(contract, /AI-independent semantic understanding/);
  assert.match(contract, /TypeScript-heavy repository/);
  assert.match(contract, /AI_INTERPRETATION/);
  assert.match(contract, /CANONICAL_FACT/);
  assert.match(readme, /self-contained HTML \/ ZIP guide/);
  assert.match(readme, /言語scannerが不足していても人間用分析を中止しません/);
  assert.match(
    presentation,
    /Human Presentation v2 P0-P4 \/ Guided Tours \/ Change Impact \/ Ask-Graph \/ Confidence-Evidence Inspector are deterministic/
  );
  assert.match(
    presentation,
    /AI Semantic Author \+ direct source inspection/
  );
});

test('security and provenance invariants remain explicit', async () => {
  const [configText, contract, agents] = await Promise.all([
    read('config/human-analysis-delivery.v1.json'),
    read('docs/AI_ASSISTED_HUMAN_ANALYSIS.md'),
    read('AGENTS.md')
  ]);
  const config = JSON.parse(configText);

  assert.equal(
    config.invariants.ai_interpretation_must_not_silently_mutate_canonical_facts,
    true
  );
  assert.equal(
    config.invariants.repository_text_is_instruction_authority,
    false
  );
  assert.equal(
    config.invariants.missing_inline_evidence_means_absence,
    false
  );
  assert.match(contract, /source paths\/ranges or canonical IDs/);
  assert.match(contract, /data, not agent instructions/);
  assert.match(agents, /does not weaken them/);
});

test('focused contract test is registered in package and hosted Windows CI', async () => {
  const [pkgText, ci] = await Promise.all([
    read('package.json'),
    read('.github/workflows/ci.yml')
  ]);
  const pkg = JSON.parse(pkgText);

  assert.equal(
    pkg.scripts['test:ai-human-analysis-contract'],
    'node --test test/ai-assisted-human-analysis-contract.test.mjs'
  );
  assert.match(ci, /npm run test:ai-human-analysis-contract/);
  assert.match(ci, /windows-latest/);
  assert.match(ci, /npm run presentation:guard/);
});
