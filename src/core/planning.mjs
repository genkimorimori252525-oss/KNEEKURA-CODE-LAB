import crypto from 'node:crypto';
import { validateAnalysisRequestV1 } from './schema/v1.mjs';
import { planScope } from './scope/planner.mjs';
import {
  accountCoverageFromGraph,
  finalizeCoverage,
  assertCoveragePartition
} from './scope/coverage.mjs';
import { resolveRules } from './rules/resolver.mjs';
import { buildSemanticAnalysisUnits } from './scope/semantic-unit.mjs';

export function planDeterministicAnalysis(graph, request, options = {}) {
  if (request?.schema === 'core.analysis-request/v1') validateAnalysisRequestV1(request);

  const scope = planScope(graph, request ?? {}, options.scope ?? {});
  const coverageInitial = structuredClone(scope.coverage);
  const rules = resolveRules({
    graph,
    request: request ?? {},
    scope,
    repositoryRules: options.repositoryRules ?? [],
    workspaceRules: options.workspaceRules ?? [],
    globalRules: options.globalRules ?? [],
    builtinRules: options.builtinRules
  });
  const semanticUnits = buildSemanticAnalysisUnits(
    graph,
    scope,
    rules,
    options.semanticUnits ?? {}
  );

  const accounted = accountCoverageFromGraph(coverageInitial, graph);
  const coverage = finalizeCoverage(accounted);
  assertCoveragePartition(coverage, scope.items.map(item => item.id));

  const result = {
    planner: {
      id: 'core-deterministic-planning',
      version: 'v1'
    },
    scope,
    coverage_initial: coverageInitial,
    coverage,
    rules,
    semantic_units: semanticUnits
  };
  result.deterministic_fingerprint = digestObject({
    snapshot_id: graph.meta?.snapshot?.snapshot_id ?? null,
    scope: scope.deterministic_fingerprint,
    coverage: coverage.fingerprint,
    rules: rules.resolution_fingerprint,
    semantic_units: semanticUnits.deterministic_fingerprint
  });
  return result;
}

function digestObject(value) {
  return 'sha256:' + crypto.createHash('sha256').update(stableStringify(value)).digest('hex');
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
