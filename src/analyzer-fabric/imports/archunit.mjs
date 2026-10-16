import {
  parseJsonArtifact,
  boundedArray,
  safePath,
  requireText,
  createImportResult,
  stableDigest,
  freeze,
  LIMITS,
  validateImportResult,
} from "../../analysis-workbench/contracts.mjs";

/** Explicit KNEEKURA exporter envelope, not an official ArchUnit JSON format. */
export function importArchUnit(artifact, context, options = {}) {
  const data = parseJsonArtifact(artifact);
  if (data.schema !== "kneekura.archunit.v1")
    throw new Error("Expected custom kneekura.archunit.v1 envelope");
  const baselineId = requireText(data.baseline_id, "baseline_id");
  if (typeof data.complete !== "boolean")
    throw new Error("Explicit complete boolean required");
  const ruleIds = new Set(),
    rules = [],
    findings = [];
  let total = 0;
  for (const rule of boundedArray(data.rules, "rules")) {
    const id = requireText(rule.id, "rule id"),
      description = requireText(rule.description, "rule description");
    if (ruleIds.has(id)) throw new Error("Duplicate rule id");
    ruleIds.add(id);
    rules.push({ id, description });
    const violationIds = new Set();
    for (const v of boundedArray(rule.violations, "violations")) {
      if (++total > LIMITS.maxRecords) throw new Error("Too many violations");
      const violationId = requireText(v.id, "violation id");
      if (violationIds.has(violationId))
        throw new Error("Duplicate violation id");
      violationIds.add(violationId);
      const sources = boundedArray(v.sources, "violation sources", 100).map(
        (s) => {
          const source = { path: safePath(s.path) };
          for (const k of ["start_line", "end_line"])
            if (s[k] !== undefined) {
              if (!Number.isSafeInteger(s[k]) || s[k] < 1)
                throw new Error(`Invalid ${k}`);
              source[k] = s[k];
            }
          if (
            source.end_line !== undefined &&
            (source.start_line === undefined ||
              source.end_line < source.start_line)
          )
            throw new Error("Invalid line range");
          if (s.snapshot_id !== undefined) {
            requireText(s.snapshot_id, "source snapshot");
            if (s.snapshot_id !== context.snapshot_id)
              throw new Error("Source snapshot mismatch");
            source.snapshot_id = s.snapshot_id;
          }
          return source;
        },
      );
      findings.push({
        kind: "architecture_violation",
        title: requireText(v.description, "violation description"),
        sources,
        capability: "CONFIG",
        strength: "STRUCTURAL",
        details: {
          rule_id: id,
          rule_description: description,
          violation_id: violationId,
        },
      });
    }
  }
  rules.sort((a, b) => a.id.localeCompare(b.id));
  findings.unshift({
    kind: "architecture_manifest",
    title: "ArchUnit export coverage",
    sources: [],
    capability: "CONFIG",
    strength: "STRUCTURAL",
    details: {
      baseline_id: baselineId,
      complete: data.complete,
      rules,
      rule_digest: stableDigest(rules),
      identity: {
        repository_id: context.repository_id,
        config_digest: context.config_digest,
        scope_digest: context.scope_digest,
        engine_id: context.engine_id,
        analyzer_version: context.analyzer_version,
        snapshot_id: context.snapshot_id,
      },
      exporter_declaration: true,
    },
  });
  return createImportResult("archunit", artifact, context, findings, {
    format: "kneekura.archunit.v1",
    warnings: [
      ...(data.complete
        ? []
        : [
            "Incomplete export: no resolved/new/existing classification is safe.",
          ]),
      "Custom exporter declaration; no baseline file is changed.",
    ],
  });
}
export function compareArchUnitBaseline(baselineResult, currentResult) {
  validateImportResult(baselineResult);
  validateImportResult(currentResult);
  const manifest = (result) => {
    const f = result?.findings?.filter(
      (f) => f.kind === "architecture_manifest",
    );
    if (!f || f.length !== 1)
      throw new Error("Expected an imported ArchUnit result");
    return f[0].details;
  };
  const b = manifest(baselineResult),
    c = manifest(currentResult),
    reasons = [];
  if (!b.complete || !c.complete)
    return freeze({
      comparable: false,
      status: "incomplete",
      reasons: ["Both exports must declare complete rule evaluation."],
      findings: [],
    });
  for (const key of [
    "repository_id",
    "config_digest",
    "scope_digest",
    "engine_id",
    "analyzer_version",
  ])
    if (b.identity[key] !== c.identity[key]) reasons.push(`${key} mismatch`);
  if (b.baseline_id !== c.baseline_id) reasons.push("baseline_id mismatch");
  if (b.rule_digest !== c.rule_digest) reasons.push("rule set mismatch");
  if (reasons.length)
    return freeze({
      comparable: false,
      status: "incomparable",
      reasons,
      findings: [],
    });
  const violations = (result) =>
    new Map(
      result.findings
        .filter((f) => f.kind === "architecture_violation")
        .map((f) => [
          JSON.stringify([f.details.rule_id, f.details.violation_id]),
          f,
        ]),
    );
  const before = violations(baselineResult),
    after = violations(currentResult),
    findings = [];
  for (const key of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const old = before.get(key),
      now = after.get(key),
      f = now ?? old;
    findings.push({
      rule_id: f.details.rule_id,
      violation_id: f.details.violation_id,
      status: now ? (old ? "existing" : "new") : "resolved",
      sources: f.sources,
      title: f.title,
    });
  }
  return freeze({
    comparable: true,
    status: "compared",
    baseline_id: b.baseline_id,
    baseline_snapshot_id: b.identity.snapshot_id,
    current_snapshot_id: c.identity.snapshot_id,
    reasons: [],
    findings,
    baseline_updated: false,
  });
}
