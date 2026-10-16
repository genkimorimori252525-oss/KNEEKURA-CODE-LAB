import {
  validateImportResult,
  boundedArray,
  freeze,
  stableDigest,
} from "../../analysis-workbench/contracts.mjs";
import { createExplorerUiModel } from "./ui-model.mjs";
import { createExplorerChangeImpact } from "./impact.mjs";

/** Additive derived links; canonical graph and result remain untouched. */
export function createWorkbenchProjection(imported, projection) {
  validateImportResult(imported);
  if (projection?.schema !== "kneekura.explorer-projection/v1")
    throw new TypeError("Explorer projection required");
  const nodes = boundedArray(
    projection.canonical?.graph?.nodes,
    "canonical nodes",
  );
  boundedArray(projection.canonical?.graph?.edges, "canonical edges", 20000);
  const c = imported.context,
    p = projection.source ?? {};
  const exact =
    p.repository_id === c.repository_id &&
    p.graph_repository_id === c.repository_id &&
    p.snapshot_id === c.snapshot_id &&
    p.graph_snapshot_id === c.snapshot_id;
  const links = [];
  for (const finding of imported.findings)
    for (const source of finding.sources) {
      let status = "UNRESOLVED_IDENTITY",
        matches = [];
      if (exact) {
        if (source.snapshot_id !== c.snapshot_id) status = "OTHER_SNAPSHOT";
        else {
          const explicit = source.canonical_id ?? finding.details?.canonical_id;
          matches = nodes.filter((n) =>
            explicit
              ? n.id === explicit
              : source.start_line !== undefined &&
                (n.file ?? n.path ?? n.source_file) === source.path &&
                (n.line ?? n.start_line ?? n.range?.start_line) ===
                  source.start_line,
          );
          status =
            matches.length === 1
              ? "MATCH"
              : matches.length > 1
                ? "AMBIGUOUS"
                : "UNRESOLVED_SOURCE";
        }
      }
      links.push({
        finding_id: finding.id,
        ...source,
        status,
        node_ids: status === "MATCH" ? [matches[0].id] : [],
        candidate_count: matches.length,
        authority: "DECLARED_SNAPSHOT_SOURCE_CORRELATION",
      });
    }
  const body = {
    schema: "kneekura.explorer-workbench/v1",
    import_id: imported.import_id,
    repository_id: c.repository_id,
    snapshot_id: c.snapshot_id,
    links,
    canonical_mutated: false,
  };
  return freeze({
    ...body,
    projection_id: "workbench-projection:" + stableDigest(body).slice(7),
  });
}
export function createSemanticChangeImpact(
  imported,
  projection,
  findingId,
  options = {},
) {
  validateImportResult(imported);
  const finding = imported.findings.find((f) => f.id === findingId);
  if (
    !finding ||
    !["refactoring", "ast-mapping", "ast-action-text"].includes(finding.kind)
  )
    throw new TypeError("exact semantic-change finding id required");
  const linked = createWorkbenchProjection(imported, projection);
  const seeds = [
    ...new Set(
      linked.links
        .filter((x) => x.finding_id === findingId && x.status === "MATCH")
        .flatMap((x) => x.node_ids),
    ),
  ];
  if (seeds.length > 20)
    throw new RangeError("semantic impact seed limit exceeded");
  const model = createExplorerUiModel(projection);
  const impacts = seeds.map((id) =>
    createExplorerChangeImpact(projection, model, id, {
      maxDepth: options.maxDepth ?? 3,
      maxItems: options.maxItems ?? 200,
    }),
  );
  return freeze({
    schema: "kneekura.semantic-change-impact/v1",
    finding_id: findingId,
    status: impacts.length ? "BOUNDED_INVESTIGATION" : "UNRESOLVED_SOURCE",
    impacts,
    source_links: linked.links.filter((x) => x.finding_id === findingId),
    behavior_equivalence: "UNKNOWN",
    limitation:
      "Strong-edge investigation scope, not verified breakage or behavior equivalence. Before/after snapshots are never conflated.",
  });
}

/** Return a new Explorer document; do not mutate canonical input. */
export function attachWorkbenchToExplorerProjection(
  imported,
  projection,
  { reportId = null } = {},
) {
  const workbench = createWorkbenchProjection(imported, projection);
  return freeze({
    ...structuredClone(projection),
    presentation: {
      ...structuredClone(projection.presentation),
      workbench: {
        schema: "kneekura.explorer-workbench-panel/v1",
        report_id: reportId,
        findings: structuredClone(imported.findings),
        links: workbench.links,
        warnings: imported.warnings,
      },
    },
  });
}
