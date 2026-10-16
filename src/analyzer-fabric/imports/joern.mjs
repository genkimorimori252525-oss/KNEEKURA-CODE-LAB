import {
  parseJsonArtifact,
  boundedArray,
  safePath,
  requireText,
  createImportResult,
  LIMITS,
  freeze,
  validateImportResult,
} from "../../analysis-workbench/contracts.mjs";
const warning =
  "Static slice reachability is not evidence of observed execution or complete data flow.";
function id(value) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
    return String(value);
  if (
    typeof value === "string" &&
    /^\d{1,19}$/.test(value) &&
    BigInt(value) <= 9223372036854775807n
  )
    return value;
  throw new Error("Invalid or unsafe Joern node id");
}
function text(value, label) {
  if (typeof value !== "string" || value.length > LIMITS.maxString)
    throw new Error(`Invalid ${label}`);
  return value;
}
function optional(value, label, arrays = false) {
  if (arrays && Array.isArray(value)) {
    if (value.length > 1) throw new Error(`Invalid optional ${label}`);
    value = value[0];
  }
  if (value == null) return null;
  if (label === "lineNumber" || label === "columnNumber") {
    if (!Number.isSafeInteger(value) || value < 1)
      throw new Error(`Invalid ${label}`);
  } else text(value, label);
  return value;
}
function source(path, line, context) {
  if (!path) return [];
  return [
    {
      path: safePath(path),
      ...(line == null ? {} : { start_line: line, end_line: line }),
      snapshot_id: context.snapshot_id,
    },
  ];
}
function definition(value) {
  if (typeof value === "string") value = parseJsonArtifact(value);
  if (!value || Array.isArray(value) || typeof value !== "object")
    throw new Error("Invalid Joern DefComponent");
  for (const key of ["name", "typeFullName"]) text(value[key], key);
  if (value.label !== undefined) text(value.label, "label");
  const result = {
    ...value,
    lineNumber: optional(value.lineNumber, "lineNumber"),
    columnNumber: optional(value.columnNumber, "columnNumber"),
  };
  if (value.position !== undefined && !Number.isSafeInteger(value.position))
    throw new Error("Invalid definition position");
  if (value.resolvedMethod !== undefined)
    result.resolvedMethod = optional(value.resolvedMethod, "resolvedMethod");
  return result;
}
function call(value, argument = false) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid observed call");
  for (const key of ["callName", "returnType"]) text(value[key], key);
  const result = {
    ...value,
    paramTypes: boundedArray(value.paramTypes, "paramTypes").map((v) =>
      text(v, "paramType"),
    ),
    resolvedMethod: optional(value.resolvedMethod, "resolvedMethod", argument),
    lineNumber: optional(value.lineNumber, "lineNumber", argument),
    columnNumber: optional(value.columnNumber, "columnNumber", argument),
  };
  if (
    argument &&
    !(
      Number.isSafeInteger(value.position) || typeof value.position === "string"
    )
  )
    throw new Error("Invalid argument position");
  if (typeof value.position === "string") text(value.position, "position");
  return result;
}
export function importJoernSlice(artifact, context, options = {}) {
  const data = parseJsonArtifact(artifact),
    findings = [];
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new Error("Joern slice object required");
  if (Object.hasOwn(data, "nodes") || Object.hasOwn(data, "edges")) {
    if (Object.hasOwn(data, "objectSlices"))
      throw new Error("Ambiguous Joern slice format");
    const nodes = boundedArray(data.nodes, "nodes", 1000).map((value) => {
      requireText(value.label, "node label");
      text(value.code, "node code");
      for (const key of ["name", "typeFullName", "parentMethod", "parentFile"])
        if (value[key] !== undefined) text(value[key], key);
      if (value.parentFile) safePath(value.parentFile);
      return {
        ...value,
        id: id(value.id),
        lineNumber: optional(value.lineNumber, "lineNumber"),
        columnNumber: optional(value.columnNumber, "columnNumber"),
      };
    });
    const ids = new Set(nodes.map((n) => n.id));
    if (ids.size !== nodes.length) throw new Error("Duplicate Joern node id");
    const edges = boundedArray(data.edges, "edges", LIMITS.maxEdges).map(
      (value) => {
        const edge = {
          src: id(value.src),
          dst: id(value.dst),
          label: requireText(value.label, "edge label"),
        };
        if (!ids.has(edge.src) || !ids.has(edge.dst))
          throw new Error("Joern edge endpoint references missing node");
        return edge;
      },
    );
    findings.push({
      kind: "dataflow-slice",
      title: `Joern static data-flow slice (${nodes.length} nodes)`,
      sources: nodes.flatMap((n) =>
        source(n.parentFile, n.lineNumber, context),
      ),
      capability: "REFERENCE",
      strength: "STRUCTURAL",
      details: { nodes, edges, observed_execution: false },
    });
    return createImportResult("joern", artifact, context, findings, {
      format: "joern-data-flow-slice-json",
      warnings: [warning],
    });
  }
  let records = 0;
  const count = () => {
    if (++records > LIMITS.maxRecords)
      throw new Error("Joern usage record limit exceeded");
  };
  for (const method of boundedArray(data.objectSlices, "objectSlices")) {
    count();
    text(method.code, "method code");
    requireText(method.fullName, "method fullName");
    const line = optional(method.lineNumber, "lineNumber");
    optional(method.columnNumber, "columnNumber");
    const sources = source(
      requireText(method.fileName, "method fileName"),
      line,
      context,
    );
    const slices = boundedArray(method.slices, "object usage slices").map(
      (slice) => {
        count();
        const targetObj = definition(slice.targetObj),
          definedBy =
            slice.definedBy == null ? null : definition(slice.definedBy);
        const invokedCalls = boundedArray(
          slice.invokedCalls,
          "invokedCalls",
        ).map((c) => {
          count();
          return call(c);
        });
        const argToCalls = boundedArray(slice.argToCalls, "argToCalls").map(
          (c) => {
            count();
            return call(c, true);
          },
        );
        return { targetObj, definedBy, invokedCalls, argToCalls };
      },
    );
    findings.push({
      kind: "usage-slice",
      title: method.fullName,
      sources,
      capability: "REFERENCE",
      strength: "STRUCTURAL",
      details: { ...method, slices, observed_execution: false },
    });
  }
  for (const type of boundedArray(data.userDefinedTypes, "userDefinedTypes")) {
    count();
    requireText(type.name, "type name");
    const fields = boundedArray(type.fields, "fields").map((f) => {
      count();
      return definition(f);
    });
    const procedures = boundedArray(type.procedures, "procedures").map((c) => {
      count();
      return call(c);
    });
    const line = optional(type.lineNumber, "lineNumber");
    optional(type.columnNumber, "columnNumber");
    findings.push({
      kind: "usage-type",
      title: type.name,
      sources: source(type.fileName, line, context),
      capability: "REFERENCE",
      strength: "STRUCTURAL",
      details: { ...type, fields, procedures, observed_execution: false },
    });
  }
  return createImportResult("joern", artifact, context, findings, {
    format: "joern-program-usage-slice-json",
    warnings: [warning],
  });
}
export function queryJoernBackwardSlice(
  result,
  { sinkId, maxDepth = 8, maxNodes = 200 } = {},
) {
  validateImportResult(result);
  if (
    result.adapter_id !== "joern" ||
    result.format !== "joern-data-flow-slice-json"
  )
    throw new Error("Backward query requires Joern data-flow import");
  if (
    !Number.isInteger(maxDepth) ||
    maxDepth < 0 ||
    maxDepth > 64 ||
    !Number.isInteger(maxNodes) ||
    maxNodes < 1 ||
    maxNodes > 1000
  )
    throw new Error("Invalid query depth/node bounds");
  const graph = result.findings[0].details,
    sink = id(sinkId),
    byId = new Map(graph.nodes.map((n) => [n.id, n]));
  if (!byId.has(sink)) throw new Error("Unknown sink node");
  const incoming = new Map();
  for (const edge of graph.edges) {
    if (!incoming.has(edge.dst)) incoming.set(edge.dst, []);
    incoming.get(edge.dst).push(edge);
  }
  const visited = new Set([sink]),
    queue = [{ id: sink, depth: 0 }];
  let truncated = false;
  for (let i = 0; i < queue.length; i++) {
    const item = queue[i];
    for (const edge of incoming.get(item.id) ?? []) {
      if (visited.has(edge.src)) continue;
      if (item.depth >= maxDepth || visited.size >= maxNodes) {
        truncated = true;
        continue;
      }
      visited.add(edge.src);
      queue.push({ id: edge.src, depth: item.depth + 1 });
    }
  }
  const edges = graph.edges.filter(
    (e) => visited.has(e.src) && visited.has(e.dst),
  );
  return freeze({
    import_id: result.import_id,
    sink_id: sink,
    nodes: queue.map((n) => byId.get(n.id)),
    edges,
    truncated,
    max_depth: maxDepth,
    max_nodes: maxNodes,
    observed_execution: false,
    warning,
  });
}
