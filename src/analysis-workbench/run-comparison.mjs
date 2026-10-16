import {
  parseJsonArtifact,
  boundedArray,
  stableDigest,
  freeze,
  validateImportResult,
} from "./contracts.mjs";
import { classifyObservationReason } from "./observation-reasons.mjs";

const CONDITIONS = [
  "engine_id",
  "repository_id",
  "config_digest",
  "scope_digest",
];
const LIMITATION =
  "Saved observations only; absent events do not prove nonexecution. Source and canonical links are exporter declarations. No target execution or rewind.";
function key(finding) {
  const { operation_id, correlation_id } = finding.details ?? {};
  return typeof operation_id === "string" &&
    operation_id.length &&
    typeof correlation_id === "string" &&
    correlation_id.length
    ? JSON.stringify([operation_id, correlation_id])
    : null;
}
function indexed(findings) {
  const map = new Map();
  for (const [index, finding] of findings.entries()) {
    const anchor = key(finding);
    if (anchor !== null) {
      if (!map.has(anchor)) map.set(anchor, []);
      map.get(anchor).push({ finding, index });
    }
  }
  return map;
}
export function compareSavedRuns(leftResult, rightResult, options = {}) {
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
    kind: "saved-run-comparison",
    status: "UNKNOWN",
    mismatches,
    aligned: [],
    unaligned: [],
    differences: [],
    first_difference: null,
    observation_reasons: [],
    limitations: [LIMITATION],
  };
  if (mismatches.length) return freeze({ ...result, status: "MISMATCH" });
  const ai = indexed(a),
    bi = indexed(b);
  for (const [side, findings, own, other] of [
    ["left", a, ai, bi],
    ["right", b, bi, ai],
  ]) {
    for (const [index, finding] of findings.entries()) {
      const anchor = key(finding);
      const reason =
        anchor === null
          ? "MISSING_ANCHOR"
          : own.get(anchor).length > 1 || (other.get(anchor)?.length ?? 0) > 1
            ? "DUPLICATE_ANCHOR"
            : !other.has(anchor)
              ? "ONE_SIDED"
              : null;
      if (reason)
        result.unaligned.push({ side, index, anchor, reason, finding });
      result.observation_reasons.push({
        side,
        index,
        ...classifyObservationReason(
          finding.details?.observation_metadata ?? {},
        ),
      });
    }
  }
  const common = new Set(
    [...ai.keys()].filter(
      (k) => ai.get(k).length === 1 && bi.get(k)?.length === 1,
    ),
  );
  const leftOrder = new Map(
    a
      .map(key)
      .filter((k) => common.has(k))
      .map((k, i) => [k, i]),
  );
  const rightOrder = new Map(
    b
      .map(key)
      .filter((k) => common.has(k))
      .map((k, i) => [k, i]),
  );
  for (const [anchor, items] of ai) {
    const peers = bi.get(anchor);
    if (items.length !== 1 || peers?.length !== 1) continue;
    const { finding: av, index: ax } = items[0],
      { finding: bv, index: bx } = peers[0],
      ad = av.details ?? {},
      bd = bv.details ?? {};
    const row = {
      anchor,
      left: av,
      right: bv,
      left_index: ax,
      right_index: bx,
      status: "UNKNOWN",
      fields: [],
    };
    if (
      av.capability !== "RUNTIME" ||
      bv.capability !== "RUNTIME" ||
      !ad.clock_scope ||
      ad.clock_scope !== bd.clock_scope ||
      ad.time_unit !== "us" ||
      bd.time_unit !== "us"
    ) {
      row.reason = "INCOMPATIBLE_OR_UNKNOWN_CLOCK_OR_CAPABILITY";
      result.aligned.push(row);
      continue;
    }
    if (leftOrder.get(anchor) !== rightOrder.get(anchor))
      row.fields.push("order");
    for (const field of ["value", "name", "duration", "phase"])
      if (
        (field === "value" && ad.value_present !== bd.value_present) ||
        stableDigest(ad[field] ?? null) !== stableDigest(bd[field] ?? null)
      )
        row.fields.push(field);
    row.status = row.fields.length ? "DIFFERENCE" : "NO_OBSERVED_DIFFERENCE";
    result.aligned.push(row);
    if (row.fields.length) result.differences.push(row);
  }
  result.first_difference = result.differences[0] ?? null;
  result.status = result.differences.length
    ? "DIFFERENCES"
    : result.unaligned.length ||
        result.aligned.some((x) => x.status === "UNKNOWN") ||
        !result.aligned.length
      ? "UNKNOWN"
      : "NO_OBSERVED_DIFFERENCE";
  return freeze(result);
}
