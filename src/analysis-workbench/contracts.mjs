import { createHash } from "node:crypto";
import { normalizeAnalyzerObservation } from "../analyzer-fabric/observation.mjs";
import { ENGINE_IDS } from "../skill/contracts.mjs";

export const IMPORT_SCHEMA = "kneekura.evidence-import/v1";
export const LIMITS = Object.freeze({
  maxBytes: 8 * 1024 * 1024,
  maxRecords: 10000,
  maxString: 16384,
  maxDepth: 64,
  maxNodes: 200,
  maxEdges: 20000,
});

export function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value))
    return value;
  Object.freeze(value);
  for (const item of Object.values(value)) freeze(item);
  return value;
}
export function requireText(value, label = "text") {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > LIMITS.maxString ||
    /[\u0000]/u.test(value)
  )
    throw new TypeError(`${label} must be nonempty bounded text`);
  return value;
}
export function safePath(value) {
  const p = requireText(value, "source path").replaceAll("\\", "/");
  if (
    p.startsWith("/") ||
    /^[A-Za-z]:/.test(p) ||
    p.split("/").some((x) => x === ".." || x === "" || x === ".") ||
    /[\u0000-\u001f\u007f]/u.test(p)
  )
    throw new TypeError("unsafe repository-relative source path");
  return p;
}
export function boundedArray(
  value,
  label = "records",
  max = LIMITS.maxRecords,
) {
  if (!Number.isInteger(max) || max < 0 || max > LIMITS.maxEdges)
    throw new RangeError("invalid record limit");
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  if (value.length > max)
    throw new RangeError(`${label} exceeds record limit ${max}`);
  return value;
}
function inspectJson(
  value,
  depth = 0,
  seen = new Set(),
  budget = { nodes: 0 },
) {
  if (depth > LIMITS.maxDepth)
    throw new RangeError("JSON depth limit exceeded");
  if (++budget.nodes > 500000) throw new RangeError("JSON node limit exceeded");
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError("JSON numbers must be finite");
    return;
  }
  if (typeof value === "string") {
    if (value.length > LIMITS.maxString)
      throw new RangeError("JSON string limit exceeded");
    return;
  }
  if (
    typeof value !== "object" ||
    (!Array.isArray(value) &&
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  )
    throw new TypeError("artifact must contain only JSON data");
  if (seen.has(value)) throw new TypeError("cyclic JSON");
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (["__proto__", "constructor", "prototype"].includes(key))
      throw new TypeError("unsafe JSON key");
    // Raw native XML/CSV is one artifact, not an individual semantic field.
    // Its adapter still validates every decoded field under maxString.
    if (
      key === "artifact" &&
      value.operation === "import" &&
      typeof child === "string"
    ) {
      if (Buffer.byteLength(child) > LIMITS.maxBytes)
        throw new RangeError("artifact byte limit exceeded");
    } else inspectJson(child, depth + 1, seen, budget);
  }
  seen.delete(value);
}
export function parseJsonArtifact(artifact) {
  let data = artifact;
  if (Buffer.isBuffer(data)) data = data.toString("utf8");
  if (typeof data === "string") {
    if (Buffer.byteLength(data) > LIMITS.maxBytes)
      throw new RangeError("artifact byte limit exceeded");
    data = JSON.parse(data);
  }
  inspectJson(data);
  if (Buffer.byteLength(JSON.stringify(data)) > LIMITS.maxBytes)
    throw new RangeError("artifact byte limit exceeded");
  return structuredClone(data);
}
function stable(value) {
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + stable(value[k]))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
export function stableDigest(value) {
  return "sha256:" + createHash("sha256").update(stable(value)).digest("hex");
}
export function artifactDigest(artifact) {
  const bytes = Buffer.isBuffer(artifact)
    ? artifact
    : Buffer.from(typeof artifact === "string" ? artifact : stable(artifact));
  if (bytes.length > LIMITS.maxBytes)
    throw new RangeError("artifact byte limit exceeded");
  return "sha256:" + createHash("sha256").update(bytes).digest("hex");
}
export function normalizeContext(input) {
  const c = parseJsonArtifact(input);
  if (!c || typeof c !== "object" || Array.isArray(c))
    throw new TypeError("context object required");
  for (const k of [
    "repository_id",
    "snapshot_id",
    "analyzer_version",
    "config_digest",
    "scope_digest",
    "engine_id",
  ])
    requireText(c[k], `context.${k}`);
  if (!ENGINE_IDS.includes(c.engine_id))
    throw new TypeError("one isolated engine_id is required");
  return c;
}
function sourceRef(source, context) {
  if (!source || typeof source !== "object")
    throw new TypeError("source reference must be an object");
  const s = {
    ...source,
    path: safePath(source.path),
    snapshot_id: source.snapshot_id ?? context.snapshot_id,
  };
  requireText(s.snapshot_id, "source snapshot");
  if (
    s.start_line !== undefined &&
    (!Number.isSafeInteger(s.start_line) || s.start_line < 1)
  )
    throw new TypeError("source start_line must be positive integer");
  if (
    s.end_line !== undefined &&
    (!Number.isSafeInteger(s.end_line) || s.end_line < (s.start_line ?? 1))
  )
    throw new TypeError("source end_line is invalid");
  if (s.end_line !== undefined && s.start_line === undefined)
    throw new TypeError("source end_line requires start_line");
  return s;
}
export function createImportResult(
  adapterId,
  artifact,
  context,
  findings,
  { warnings = [], format = "KNEEKURA_DECLARED", coverage = "PARTIAL" } = {},
) {
  requireText(adapterId, "adapter id");
  requireText(format, "format");
  const c = normalizeContext(context);
  const artifact_digest = artifactDigest(artifact);
  const normalized = boundedArray(findings, "findings").map((input, index) => {
    const f = parseJsonArtifact(input);
    requireText(f.kind, "finding kind");
    requireText(f.title, "finding title");
    const sources = boundedArray(f.sources ?? [], "finding sources", 1000).map(
      (s) => sourceRef(s, c),
    );
    const basis = {
      ...f,
      sources,
      details: f.details ?? {},
      record_pointer: f.record_pointer ?? `/${index}`,
    };
    delete basis.id;
    return {
      ...basis,
      id:
        "finding:" +
        stableDigest({
          adapterId,
          artifact_digest,
          context: c,
          ...basis,
        }).slice(7),
    };
  });
  const observations = normalized.map((f) => {
    const source = f.sources.find((s) => s.snapshot_id === c.snapshot_id);
    return normalizeAnalyzerObservation({
      provider_id: adapterId,
      provider_version: c.analyzer_version,
      capability: f.capability ?? "SYNTAX",
      strength: f.strength ?? "STRUCTURAL",
      origin: "IMPORTED_ARTIFACT",
      observation_type: f.kind,
      subject: { finding_id: f.id },
      snapshot: { repository_id: c.repository_id, snapshot_id: c.snapshot_id },
      provenance: {
        ...c,
        artifact_digest,
        format,
        provenance_verification: "EXPORTER_DECLARED",
      },
      ...(source
        ? {
            source_file: source.path,
            ...(source.start_line
              ? {
                  source_range: {
                    native_coordinates: {
                      provider_coordinate_system: "DECLARED_LINE_RANGE",
                      start_line: source.start_line,
                      end_line: source.end_line ?? source.start_line,
                    },
                  },
                }
              : {}),
          }
        : {}),
      raw_provider_ref: { artifact_digest, record_pointer: f.record_pointer },
      provider_payload: {
        finding_id: f.id,
        details: f.details,
        sources: f.sources,
      },
    });
  });
  const body = {
    schema: IMPORT_SCHEMA,
    adapter_id: adapterId,
    format,
    context: c,
    artifact_digest,
    findings: normalized,
    observations,
    warnings: boundedArray(warnings, "warnings").map((x) =>
      requireText(x, "warning"),
    ),
    coverage,
    authority: {
      import_only: true,
      external_analyzer_executed: false,
      provenance_verification: "EXPORTER_DECLARED",
      canonical_graph_mutated: false,
      behavior_equivalence: false,
    },
  };
  return freeze({
    ...body,
    import_id: "import:" + stableDigest(body).slice(7),
  });
}
export function validateImportResult(result) {
  if (result?.schema !== IMPORT_SCHEMA)
    throw new TypeError("invalid evidence import schema");
  const body = structuredClone(result);
  delete body.import_id;
  if (result.import_id !== "import:" + stableDigest(body).slice(7))
    throw new TypeError("import digest mismatch");
  normalizeContext(result.context);
  boundedArray(result.findings, "findings");
  boundedArray(result.observations, "observations");
  for (const f of result.findings) {
    requireText(f.id, "finding id");
    for (const s of f.sources ?? []) sourceRef(s, result.context);
  }
  return true;
}
