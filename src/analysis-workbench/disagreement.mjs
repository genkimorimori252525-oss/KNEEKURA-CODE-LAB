import { normalizeAnalyzerObservation } from "../analyzer-fabric/observation.mjs";
import {
  parseJsonArtifact,
  boundedArray,
  stableDigest,
  freeze,
  validateImportResult,
  normalizeContext,
  createImportResult,
} from "./contracts.mjs";

const CONDITIONS = [
  "engine_id",
  "repository_id",
  "snapshot_id",
  "config_digest",
  "scope_digest",
];
function assertions(findings) {
  const grouped = new Map(),
    incomparable = [];
  for (const [index, finding] of findings.entries()) {
    const assertion = finding.details?.assertion;
    if (
      !assertion ||
      typeof assertion.key !== "string" ||
      !assertion.key.trim() ||
      !Object.hasOwn(assertion, "value") ||
      typeof finding.capability !== "string" ||
      !finding.capability
    ) {
      incomparable.push({
        index,
        finding,
        status: "INCOMPARABLE",
        reason: "EXPLICIT_ASSERTION_REQUIRED",
      });
      continue;
    }
    const key = JSON.stringify([finding.capability, assertion.key]);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push({ index, finding, assertion });
  }
  return { grouped, incomparable };
}
/** Pairwise candidate conflicts. Never vote, merge engines, or promote truth. */
export function compareAnalyzerFindings(leftResult, rightResult, options = {}) {
  const left = parseJsonArtifact(leftResult),
    right = parseJsonArtifact(rightResult);
  validateImportResult(left);
  validateImportResult(right);
  const a = boundedArray(left.findings, "left findings"),
    b = boundedArray(right.findings, "right findings");
  const lc = left.context ?? left.provenance ?? {},
    rc = right.context ?? right.provenance ?? {};
  const mismatches = CONDITIONS.filter(
    (field) => !lc[field] || lc[field] !== rc[field],
  );
  const result = {
    kind: "analyzer-disagreement",
    status: "COMPARED",
    mismatches,
    comparisons: [],
    limitations: [
      "Explicit assertions under matching declared conditions only. Conflict candidates are not adjudicated truth; no majority voting or canonical promotion.",
    ],
  };
  if (mismatches.length) return freeze({ ...result, status: "MISMATCH" });
  const ai = assertions(a),
    bi = assertions(b);
  result.comparisons.push(
    ...ai.incomparable.map((x) => ({ ...x, side: "left" })),
    ...bi.incomparable.map((x) => ({ ...x, side: "right" })),
  );
  for (const key of new Set([...ai.grouped.keys(), ...bi.grouped.keys()])) {
    const av = ai.grouped.get(key) ?? [],
      bv = bi.grouped.get(key) ?? [];
    const row = {
      assertion_key: (av[0] ?? bv[0]).assertion.key,
      capability: (av[0] ?? bv[0]).finding.capability,
      left: av.map((x) => x.finding),
      right: bv.map((x) => x.finding),
    };
    if (av.length > 1 || bv.length > 1) {
      row.status = "INCOMPARABLE";
      row.reason = "AMBIGUOUS_ASSERTION";
    } else if (!av.length || !bv.length) row.status = "ONE_SIDED";
    else
      row.status =
        stableDigest(av[0].assertion.value) ===
        stableDigest(bv[0].assertion.value)
          ? "AGREEMENT"
          : "CONFLICT_CANDIDATE";
    result.comparisons.push(row);
  }
  return freeze(result);
}

function importFabricStatements(observations, context) {
  const c = normalizeContext(context);
  const records = boundedArray(
    parseJsonArtifact(observations),
    "Fabric observations",
  );
  const findings = records.map((raw) => {
    const observation = normalizeAnalyzerObservation(raw);
    for (const field of CONDITIONS) {
      const declared = observation.provenance[field];
      if (declared !== undefined && declared !== c[field])
        throw new TypeError(
          `Fabric observation ${field} conflicts with comparison context`,
        );
    }
    const details = {
      fabric_observation: observation,
      assertion_basis: "NONE",
    };
    const explicit = observation.provider_payload?.assertion;
    if (explicit !== undefined) {
      if (
        !explicit ||
        typeof explicit.key !== "string" ||
        !explicit.key.trim() ||
        !Object.hasOwn(explicit, "value")
      )
        throw new TypeError("Invalid explicit Fabric assertion");
      details.assertion = explicit;
      details.assertion_basis = "PROVIDER_EXPLICIT_ASSERTION";
    } else if (Object.hasOwn(observation, "object")) {
      details.assertion = {
        key: stableDigest({
          capability: observation.capability,
          observation_type: observation.observation_type,
          subject: observation.subject,
          source_file: observation.source_file ?? null,
        }),
        value: observation.object,
      };
      details.assertion_basis = "EXPLICIT_FABRIC_SUBJECT_OBJECT_STATEMENT";
    }
    return {
      kind: "fabric-statement",
      title: observation.observation_type,
      capability: observation.capability,
      strength: observation.strength,
      sources: observation.source_file
        ? [{ path: observation.source_file, snapshot_id: c.snapshot_id }]
        : [],
      details,
    };
  });
  return createImportResult("fabric-statements", records, c, findings, {
    format: "kneekura.analyzer-observation/v1",
  });
}

/** Adapt existing Fabric statements; object absence never becomes a negative assertion. */
export function compareFabricObservations(
  leftObservations,
  rightObservations,
  { leftContext, rightContext } = {},
) {
  return compareAnalyzerFindings(
    importFabricStatements(leftObservations, leftContext),
    importFabricStatements(rightObservations, rightContext),
  );
}
