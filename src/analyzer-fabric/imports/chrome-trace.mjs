import {
  parseJsonArtifact,
  boundedArray,
  safePath,
  requireText,
  createImportResult,
} from "../../analysis-workbench/contracts.mjs";

function number(value, name, nonnegative = false) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    (nonnegative && value < 0)
  )
    throw new TypeError(`Invalid ${name}`);
  return value;
}
function source(value, context) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Invalid trace source");
  const result = {
    path: safePath(value.path),
    snapshot_id: value.snapshot_id ?? context.snapshot_id,
  };
  if (result.snapshot_id !== context.snapshot_id)
    throw new TypeError("Trace source snapshot mismatch");
  for (const key of ["start_line", "end_line"])
    if (value[key] !== undefined) {
      if (!Number.isSafeInteger(value[key]) || value[key] < 1)
        throw new TypeError(`Invalid ${key}`);
      result[key] = value[key];
    }
  if (
    result.end_line !== undefined &&
    (result.start_line === undefined || result.end_line < result.start_line)
  )
    throw new TypeError("Invalid source range");
  return result;
}

/** Import-only Chrome complete and instant events. Custom args are exporter declarations. */
export function importChromeTrace(artifact, context, options = {}) {
  const data = parseJsonArtifact(artifact);
  const events = boundedArray(
    Array.isArray(data) ? data : data?.traceEvents,
    "traceEvents",
  );
  const findings = [],
    warnings = [];
  const operationField = requireText(
    options.operation_field ?? "operation_id",
    "operation field",
  );
  const correlationField = requireText(
    options.correlation_field ?? "correlation_id",
    "correlation field",
  );
  for (const [index, event] of events.entries()) {
    if (!event || typeof event !== "object" || Array.isArray(event))
      throw new TypeError("Invalid trace event");
    const phase = requireText(event.ph, "event phase");
    if (!["X", "i", "I"].includes(phase)) {
      warnings.push(
        `Unsupported Chrome trace phase ${phase} at event ${index}; not imported`,
      );
      continue;
    }
    const args = event.args ?? {};
    if (!args || typeof args !== "object" || Array.isArray(args))
      throw new TypeError("Invalid trace args");
    const name = requireText(event.name, "event name");
    const details = {
      name,
      phase,
      event_index: index,
      timestamp: number(event.ts, "timestamp"),
      time_unit: "us",
      duration: phase === "X" ? number(event.dur, "duration", true) : null,
      operation_id:
        args[operationField] === undefined
          ? null
          : requireText(args[operationField], "operation_id"),
      correlation_id:
        args[correlationField] === undefined
          ? null
          : requireText(args[correlationField], "correlation_id"),
      clock_scope:
        args.clock_scope === undefined
          ? null
          : requireText(args.clock_scope, "clock_scope"),
      value_present: Object.hasOwn(args, "value"),
      value: args.value ?? null,
      provenance_authority: "EXPORTER_DECLARED",
      observation_metadata: args.observation_metadata ?? {},
    };
    if (args.canonical_id !== undefined)
      details.canonical_id = requireText(args.canonical_id, "canonical_id");
    findings.push({
      kind: "runtime-event",
      title: name,
      sources: args.source === undefined ? [] : [source(args.source, context)],
      capability: "RUNTIME",
      strength: "RUNTIME_OBSERVED",
      details,
    });
  }
  return createImportResult("chrome-trace", artifact, context, findings, {
    warnings,
    format: "chrome-trace-json",
  });
}
