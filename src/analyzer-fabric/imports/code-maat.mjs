import {
  parseJsonArtifact,
  boundedArray,
  safePath,
  requireText,
  createImportResult,
  LIMITS,
} from "../../analysis-workbench/contracts.mjs";

// Native Code Maat CSV is evidence supplied by the caller, never an instruction.
function csvRows(artifact) {
  if (
    typeof artifact !== "string" ||
    Buffer.byteLength(artifact) > LIMITS.maxBytes
  )
    throw new Error("CSV must be bounded text");
  const rows = [];
  let row = [],
    field = "",
    quoted = false,
    closed = false;
  const cell = () => {
    if (field.length > LIMITS.maxString) throw new Error("CSV field too long");
    row.push(field);
    field = "";
    closed = false;
    if (row.length > 128) throw new Error("Too many CSV columns");
  };
  const finish = () => {
    cell();
    rows.push(row);
    row = [];
    if (rows.length > LIMITS.maxRecords + 1)
      throw new Error("Too many CSV records");
  };
  for (let i = 0; i < artifact.length; i++) {
    const c = artifact[i];
    if (quoted) {
      if (c === '"') {
        if (artifact[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else field += c;
    } else if (c === '"') {
      if (field || closed) throw new Error("Invalid CSV quote");
      quoted = true;
    } else if (c === ",") cell();
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && artifact[i + 1] === "\n") i++;
      finish();
    } else {
      if (closed) throw new Error("Unexpected content after CSV quote");
      field += c;
    }
    if (field.length > LIMITS.maxString) throw new Error("CSV field too long");
  }
  if (quoted) throw new Error("Unclosed CSV quote");
  if (field || row.length || closed) finish();
  return rows;
}
function number(value, label, max = Number.MAX_SAFE_INTEGER) {
  if (typeof value === "string" && !/^\d+(?:\.\d+)?$/.test(value))
    throw new Error(`Invalid ${label}`);
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > max)
    throw new Error(`Invalid ${label}`);
  return n;
}
export function importCodeMaat(artifact, context, options = {}) {
  const [header, ...rows] = csvRows(artifact);
  const required = ["entity", "coupled", "degree", "average-revs"];
  if (
    !header ||
    new Set(header).size !== header.length ||
    required.some((k) => !header.includes(k))
  )
    throw new Error("Missing or duplicate Code Maat CSV headers");
  const findings = rows.map((row) => {
    if (row.length !== header.length)
      throw new Error("CSV column count mismatch");
    const get = (k) => row[header.indexOf(k)];
    const a = safePath(get("entity")),
      b = safePath(get("coupled"));
    return {
      kind: "cochange",
      title: `Logical coupling: ${a} / ${b}`,
      capability: "REFERENCE",
      strength: "HEURISTIC",
      sources: [{ path: a }, { path: b }],
      details: {
        degree_percent: number(get("degree"), "degree", 100),
        average_revisions: number(get("average-revs"), "average revisions"),
        sample_count: null,
        sample_ids: null,
        extra_columns: Object.fromEntries(
          header.filter((k) => !required.includes(k)).map((k) => [k, get(k)]),
        ),
        interpretation:
          "Historical correlation, not causality; average revisions is not a cochange sample count.",
      },
    };
  });
  return createImportResult("code-maat", artifact, context, findings, {
    format: "code-maat.coupling.csv",
    warnings: [
      "Export filtering and history coverage are caller-declared; no history was read.",
    ],
  });
}
export function analyzeCochangeHistory(artifact, context, options = {}) {
  const data = parseJsonArtifact(artifact);
  if (data.schema !== "kneekura.history.v1")
    throw new Error("Expected kneekura.history.v1");
  const maxPairs = options.max_pairs ?? LIMITS.maxRecords,
    minSamples = options.min_samples ?? 2,
    maxFiles = options.max_commit_files ?? 100;
  for (const [label, n, max] of [
    ["max_pairs", maxPairs, LIMITS.maxRecords],
    ["min_samples", minSamples, LIMITS.maxRecords],
    ["max_commit_files", maxFiles, LIMITS.maxRecords],
  ])
    if (!Number.isInteger(n) || n < 1 || n > max)
      throw new Error(`Invalid ${label}`);
  for (const flag of ["exclude_merges", "exclude_format_only"])
    if (options[flag] !== undefined && typeof options[flag] !== "boolean")
      throw new Error(`Invalid ${flag}`);
  const filters = {
    exclude_merges: options.exclude_merges ?? false,
    exclude_format_only: options.exclude_format_only ?? false,
    max_commit_files: maxFiles,
    min_samples: minSamples,
    max_pairs: maxPairs,
  };
  const seen = new Set(),
    pairs = new Map(),
    counts = new Map(),
    excluded = [];
  let eligible = 0,
    operations = 0,
    sampleBytes = 0,
    pairBytes = 0;
  for (const commit of boundedArray(data.commits, "commits")) {
    const id = requireText(commit.id, "commit id");
    if (seen.has(id)) throw new Error("Duplicate commit id");
    seen.add(id);
    for (const flag of ["merge", "format_only"])
      if (commit[flag] !== undefined && typeof commit[flag] !== "boolean")
        throw new Error(`Invalid commit ${flag}`);
    const paths = boundedArray(commit.files, "commit files").map((p) =>
      safePath(p),
    );
    if (new Set(paths).size !== paths.length)
      throw new Error("Duplicate commit path");
    paths.sort();
    const reason =
      filters.exclude_merges && commit.merge
        ? "merge"
        : filters.exclude_format_only && commit.format_only
          ? "format_only"
          : paths.length > maxFiles
            ? "large_commit"
            : null;
    if (reason) {
      excluded.push({ id, reason });
      continue;
    }
    eligible++;
    for (const p of paths) counts.set(p, (counts.get(p) ?? 0) + 1);
    for (let i = 0; i < paths.length; i++)
      for (let j = i + 1; j < paths.length; j++) {
        if (++operations > 1000000)
          throw new Error("History pair operation limit exceeded");
        const key = JSON.stringify([paths[i], paths[j]]);
        if (!pairs.has(key)) {
          if (pairs.size >= maxPairs)
            throw new Error("History pair limit exceeded");
          pairBytes += Buffer.byteLength(key);
          if (pairBytes > LIMITS.maxBytes)
            throw new Error("History pair evidence byte limit exceeded");
          pairs.set(key, []);
        }
        sampleBytes += Buffer.byteLength(id);
        if (sampleBytes > LIMITS.maxBytes)
          throw new Error("History sample evidence byte limit exceeded");
        pairs.get(key).push(id);
      }
  }
  const findings = [
    {
      kind: "history_manifest",
      title: "Declared history sample coverage",
      sources: [],
      capability: "CONFIG",
      strength: "STRUCTURAL",
      details: {
        filters,
        total_commits: seen.size,
        eligible_commits: eligible,
        excluded,
        classification:
          "Caller-declared metadata; merge/format labels are not independently verified.",
      },
    },
  ];
  for (const [key, ids] of [...pairs].sort(([a], [b]) => a.localeCompare(b)))
    if (ids.length >= minSamples) {
      const paths = JSON.parse(key),
        avg = (counts.get(paths[0]) + counts.get(paths[1])) / 2;
      findings.push({
        kind: "cochange",
        title: `Cochange: ${paths.join(" / ")}`,
        sources: paths.map((path) => ({ path })),
        capability: "REFERENCE",
        strength: "HEURISTIC",
        details: {
          sample_ids: [...ids].sort(),
          sample_count: ids.length,
          average_revisions: avg,
          degree_percent: (ids.length / avg) * 100,
          interpretation:
            "Historical correlation within the supplied eligible sample, not causality.",
        },
      });
    }
  return createImportResult("cochange-history", artifact, context, findings, {
    format: "kneekura.history.v1",
    warnings: ["No git commands executed; supplied history may be incomplete."],
  });
}
