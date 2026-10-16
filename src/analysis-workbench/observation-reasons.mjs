import { parseJsonArtifact, freeze } from "./contracts.mjs";

/** Reasons describe declared collection coverage, never prove nonexecution. */
export function classifyObservationReason(metadata = {}) {
  const value = parseJsonArtifact(metadata);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Observation metadata must be an object");
  const reasons = [];
  if (value.identity_match === false) reasons.push("IDENTITY_MISMATCH");
  if (value.instrumented === false) reasons.push("NOT_INSTRUMENTED");
  if (
    value.sampled_out === true ||
    (Number.isSafeInteger(value.dropped_count) && value.dropped_count > 0)
  )
    reasons.push("SAMPLED_OR_DROPPED");
  return freeze({
    reason: reasons[0] ?? "UNKNOWN",
    reasons: reasons.length ? reasons : ["UNKNOWN"],
    execution: "UNKNOWN",
    authority: reasons.length ? "EXPORTER_DECLARED" : "UNKNOWN",
    limitation: "Absence of observed evidence does not establish nonexecution.",
  });
}
