import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function read(relative) {
  return fs.readFile(path.join(ROOT, relative), 'utf8');
}

async function contract() {
  return JSON.parse(await read('config/analyzer-provider-authority.v1.json'));
}

test('provider authority contract is frozen and providers never win truth by priority', async () => {
  const config = await contract();

  assert.equal(config.schema, 'kneekura.analyzer-provider-authority/v1');
  assert.equal(config.status, 'FROZEN');
  assert.equal(config.intent.provider_priority_decides_truth, false);
  assert.equal(config.intent.last_writer_wins, false);
  assert.equal(config.intent.provider_direct_canonical_graph_write, false);
  assert.equal(
    config.intent.canonical_fact_authority,
    'EXISTING_KNEEKURA_CORE_VERIFICATION'
  );
  assert.ok(config.fusion.rules.includes('NO_PROVIDER_PRIORITY_WINS'));
  assert.ok(config.fusion.rules.includes('NO_LAST_WRITER_WINS'));
  assert.ok(config.fusion.rules.includes('DO_NOT_DROP_COUNTEREVIDENCE'));
});

test('capability matrix is capability-scoped rather than language checkbox support', async () => {
  const config = await contract();

  for (const capability of [
    'SYNTAX',
    'DECLARATION',
    'SYMBOL',
    'REFERENCE',
    'CROSS_FILE_REFERENCE',
    'CALL',
    'TYPE',
    'INHERITANCE',
    'CONFIG',
    'FRAMEWORK',
    'RUNTIME',
    'AI_SEMANTIC'
  ]) {
    assert.ok(config.capability_taxonomy.includes(capability), capability);
  }

  assert.deepEqual(
    config.coverage_statuses,
    ['AVAILABLE', 'PARTIAL', 'NONE', 'FAILED', 'UNEXPLORED']
  );
  assert.equal(config.coverage.unit, 'CAPABILITY_PER_SCOPE');
  assert.equal(config.coverage.provider_failure_becomes_coverage_gap, true);
  assert.equal(config.coverage.missing_language_support_must_not_be_hidden, true);
});

test('provider manifest and observation envelope preserve provenance and provider detail', async () => {
  const config = await contract();

  for (const required of [
    'id',
    'version',
    'supported_languages',
    'capabilities',
    'origin',
    'authority_level',
    'required_tools',
    'source_range_support',
    'semantic_identity_support',
    'timeout_ms',
    'resource_limits',
    'cacheability',
    'provenance'
  ]) {
    assert.ok(config.provider_manifest.required.includes(required), required);
  }

  for (const required of [
    'provider_id',
    'provider_version',
    'snapshot',
    'capability',
    'observation_type',
    'subject',
    'strength',
    'origin',
    'provenance'
  ]) {
    assert.ok(config.observation.required.includes(required), required);
  }

  assert.equal(config.observation.preserve_provider_specific_payload_or_ref, true);
  assert.equal(config.observation.unknown_source_range_is_omitted_not_zero, true);
  assert.equal(config.source_range_identity.zero_is_not_unknown_sentinel, true);
});

test('provider registry and authority levels cannot become truth ranking', async () => {
  const config = await contract();

  assert.equal(
    config.provider_registry.schema,
    'kneekura.analyzer-provider-registry/v1'
  );
  assert.equal(
    config.provider_registry.multiple_providers_per_capability_allowed,
    true
  );
  assert.equal(
    config.provider_registry.execution_preference_may_control_scheduling_or_fallback,
    true
  );
  assert.equal(
    config.provider_registry.execution_preference_may_decide_truth,
    false
  );
  assert.equal(
    config.authority_levels.direct_canonicalization_for_any_level,
    false
  );
  assert.equal(
    config.authority_levels.canonical_promotion_boundary,
    'EXISTING_KNEEKURA_CORE_VERIFICATION'
  );
  for (const level of [
    'SYNTAX_ONLY',
    'STRUCTURAL_EVIDENCE',
    'RESOLVED_SEMANTIC_EVIDENCE',
    'RUNTIME_OBSERVED_EVIDENCE',
    'IMPORTED_MAPPED_EVIDENCE',
    'AI_INTERPRETATION_ONLY'
  ]) {
    assert.ok(config.authority_levels.values.includes(level), level);
  }
});

test('SCIP, Tree-sitter, structural, runtime and AI authority boundaries fail closed', async () => {
  const config = await contract();
  const boundaries = config.authority_boundaries;

  assert.equal(
    boundaries.scip_or_compiler_semantic_index.direct_canonicalization,
    false
  );
  assert.equal(boundaries.tree_sitter.may_resolve_cross_file_semantic_target, false);
  assert.equal(boundaries.tree_sitter.direct_canonicalization, false);
  assert.equal(
    boundaries.structural_rules.may_resolve_cross_file_semantic_target,
    false
  );
  assert.equal(boundaries.runtime.static_and_runtime_semantics_remain_distinct, true);
  assert.equal(boundaries.runtime.observed_event_does_not_imply_unobserved_event, true);
  assert.equal(boundaries.ai.human_output_class, 'AI_INTERPRETATION');
  assert.equal(boundaries.ai.may_promote_canonical_fact, false);
  assert.equal(boundaries.ai.majority_vote_may_promote_canonical_fact, false);
});

test('symbol identity fusion is conservative and name-only merge is forbidden', async () => {
  const config = await contract();

  assert.equal(config.symbol_identity.default, 'FAIL_CONSERVATIVE');
  assert.equal(config.symbol_identity.name_only_merge_allowed, false);
  assert.equal(
    config.symbol_identity.ambiguous_action,
    'KEEP_SEPARATE_AND_CORRELATE_AS_CANDIDATES'
  );
  assert.equal(
    config.symbol_identity.false_positive_merge_is_worse_than_false_negative_split,
    true
  );
});

test('provider sandbox, cache, version and OSS reuse policy are explicit', async () => {
  const config = await contract();

  assert.equal(config.provider_execution_sandbox.isolated_workspace, true);
  assert.equal(config.provider_execution_sandbox.credentials_available_to_provider, false);
  assert.equal(config.provider_execution_sandbox.timeout_required, true);
  assert.equal(config.provider_execution_sandbox.cpu_budget_required, true);
  assert.equal(config.provider_execution_sandbox.memory_budget_required, true);
  assert.equal(config.provider_execution_sandbox.kill_process_tree_on_timeout, true);
  assert.equal(
    config.provider_execution_sandbox.network_default,
    'DENY_UNLESS_EXPLICITLY_DECLARED_AND_ALLOWED'
  );

  assert.deepEqual(config.cache.deterministic_provider_key, [
    'repository_snapshot_sha_or_snapshot_id',
    'provider_id',
    'provider_version',
    'provider_config_digest'
  ]);
  assert.equal(config.cache.stale_cache_may_be_canonical_evidence, false);
  assert.equal(config.versioning.floating_latest_for_canonical_run, false);

  assert.deepEqual(config.oss_reuse_policy.preference_order, [
    'REUSE_EXISTING_CLI_API_INDEXER',
    'ADAPTER_STABLE_EXPORT',
    'KNEEKURA_NATIVE_IMPLEMENTATION',
    'PINNED_VENDOR_LAST_RESORT'
  ]);
  assert.equal(config.oss_reuse_policy.wholesale_fork_merge_default, false);
});

test('normative documentation states the anti-fabrication boundaries', async () => {
  const [doc, coreFreeze] = await Promise.all([
    read('docs/ANALYZER_PROVIDER_AUTHORITY_V1.md'),
    read('docs/CORE_SCHEMA_FREEZE_V1.md')
  ]);

  for (const phrase of [
    'providers observe; CORE decides',
    'Tree-sitter is syntax authority only',
    'registry is a catalog and execution/fallback policy surface',
    'No authority level directly canonicalizes a fact',
    'Fusion is evidence-preserving, not winner-selecting',
    'Names are not identities',
    'External analyzers run as untrusted processes',
    'PINNED_VENDOR_LAST_RESORT',
    'UNKNOWN is not ABSENT',
    'packet send is not packet receive'
  ]) {
    assert.ok(doc.includes(phrase), phrase);
  }

  assert.ok(doc.includes('origin\nauthority_level\nrequired_tools'));
  assert.ok(coreFreeze.includes('UNKNOWN is not ABSENT'));
  assert.ok(coreFreeze.includes('packet send is not packet receive'));
});
