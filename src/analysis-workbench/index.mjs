import {
  parseJsonArtifact,
  freeze,
  stableDigest,
  validateImportResult,
} from "./contracts.mjs";
import {
  importRefactoringMiner,
  importRefactoringMinerAst,
} from "../analyzer-fabric/imports/refactoring-miner.mjs";
import {
  importJoernSlice,
  queryJoernBackwardSlice,
} from "../analyzer-fabric/imports/joern.mjs";
import {
  importCpd,
  annotateCloneGroups,
} from "../analyzer-fabric/imports/pmd-cpd.mjs";
import {
  importCodeMaat,
  analyzeCochangeHistory,
} from "../analyzer-fabric/imports/code-maat.mjs";
import {
  importArchUnit,
  compareArchUnitBaseline,
} from "../analyzer-fabric/imports/archunit.mjs";
import { importChromeTrace } from "../analyzer-fabric/imports/chrome-trace.mjs";
import { compareSavedRuns } from "./run-comparison.mjs";
import { classifyObservationReason } from "./observation-reasons.mjs";
import {
  compareAnalyzerFindings,
  compareFabricObservations,
} from "./disagreement.mjs";
import {
  createWorkbenchProjection,
  createSemanticChangeImpact,
} from "../presentation/explorer/workbench.mjs";

const ADAPTERS = Object.freeze({
  "refactoring-miner": importRefactoringMiner,
  "refactoring-miner-ast": importRefactoringMinerAst,
  joern: importJoernSlice,
  "pmd-cpd": importCpd,
  "code-maat": importCodeMaat,
  "cochange-history": analyzeCochangeHistory,
  archunit: importArchUnit,
  "chrome-trace": importChromeTrace,
});
const OPERATIONS = Object.freeze([
  "import",
  "compare-runs",
  "compare-baseline",
  "disagreement",
  "compare-fabric",
  "observation-reason",
  "backward-slice",
  "annotate-clones",
  "semantic-impact",
]);
export function describeEvidenceWorkbench() {
  return freeze({
    schema: "kneekura.evidence-workbench-description/v1",
    adapters: Object.keys(ADAPTERS),
    operations: [...OPERATIONS],
    import_only: true,
    external_analyzer_execution: false,
    target_mutation: false,
    engine_fusion: false,
    request_schema: "kneekura.evidence-workbench-request/v1",
    max_request_bytes: 8 * 1024 * 1024,
  });
}
function operand(input) {
  if (input?.operation === "import") return runEvidenceWorkbench(input).result;
  return input;
}
export function runEvidenceWorkbench(input) {
  const request = parseJsonArtifact(input);
  if (
    request.schema &&
    request.schema !== "kneekura.evidence-workbench-request/v1"
  )
    throw new TypeError("invalid workbench request schema");
  const op = request.operation;
  let result, projection;
  switch (op) {
    case "import": {
      const adapter = ADAPTERS[request.adapter];
      if (!adapter) throw new TypeError("unknown workbench adapter");
      result = adapter(
        request.artifact,
        request.context,
        request.options ?? {},
      );
      if (request.projection)
        projection = createWorkbenchProjection(result, request.projection);
      break;
    }
    case "compare-runs":
      result = compareSavedRuns(
        operand(request.left),
        operand(request.right),
        request.options,
      );
      break;
    case "compare-baseline":
      result = compareArchUnitBaseline(
        operand(request.left),
        operand(request.right),
      );
      break;
    case "compare-fabric":
      result = compareFabricObservations(
        request.left,
        request.right,
        request.options,
      );
      break;
    case "disagreement":
      result = compareAnalyzerFindings(
        operand(request.left),
        operand(request.right),
        request.options,
      );
      break;
    case "observation-reason":
      result = classifyObservationReason(request.metadata);
      break;
    case "backward-slice":
      result = queryJoernBackwardSlice(
        operand(request.imported),
        request.options,
      );
      break;
    case "annotate-clones":
      result = annotateCloneGroups(
        operand(request.imported),
        request.annotations,
      );
      break;
    case "semantic-impact":
      result = createSemanticChangeImpact(
        operand(request.imported),
        request.projection,
        request.finding_id,
        request.options,
      );
      break;
    default:
      throw new TypeError("unknown workbench operation");
  }
  const contexts = [
    request.context,
    request.left?.context,
    request.right?.context,
    request.imported?.context,
    request.options?.leftContext,
    request.options?.rightContext,
  ].filter(Boolean);
  // Refactoring exports explicitly bind a same-repository base snapshot; keep it
  // addressable for source materialization without guessing across repositories.
  for (const input of [
    request,
    request.left,
    request.right,
    request.imported,
  ]) {
    if (!input?.context) continue;
    const bases = new Set();
    if (
      ["refactoring-miner", "refactoring-miner-ast"].includes(input.adapter) &&
      input.options?.base_snapshot_id
    )
      bases.add(input.options.base_snapshot_id);
    if (input.adapter_id === "refactoring-miner")
      for (const finding of input.findings ?? [])
        if (finding.details?.base_snapshot_id)
          bases.add(finding.details.base_snapshot_id);
    for (const snapshot_id of bases)
      contexts.push({
        ...input.context,
        snapshot_id,
        identity_role: "DECLARED_REFACTORING_BASE",
      });
  }
  const body = {
    schema: "kneekura.evidence-workbench-report/v1",
    operation: op,
    input_contexts: contexts,
    result,
    ...(projection ? { projection } : {}),
    authority: {
      derived_only: true,
      instruction_authority: false,
      canonical_mutation: false,
      external_analyzer_executed: false,
    },
    limitations: [
      "Exporter metadata is declared provenance, not an independent verification.",
      "No behavior equivalence, nonexecution, causal dependency or majority truth is inferred.",
    ],
  };
  return freeze({
    ...body,
    report_id: "workbench:" + stableDigest(body).slice(7),
  });
}
export {
  importRefactoringMiner,
  importRefactoringMinerAst,
  importJoernSlice,
  queryJoernBackwardSlice,
  importCpd,
  annotateCloneGroups,
  importCodeMaat,
  analyzeCochangeHistory,
  importArchUnit,
  compareArchUnitBaseline,
  importChromeTrace,
  compareSavedRuns,
  classifyObservationReason,
  compareAnalyzerFindings,
  compareFabricObservations,
  createWorkbenchProjection,
  createSemanticChangeImpact,
};

export { materializeWorkbenchSources } from "./source-materialization.mjs";
export {
  compileWorkbenchArtifact,
  projectWorkbenchForAgent,
  inspectWorkbenchReport,
  renderWorkbenchAgentMarkdown,
} from "./render.mjs";
export { attachWorkbenchToExplorerProjection } from "../presentation/explorer/workbench.mjs";
