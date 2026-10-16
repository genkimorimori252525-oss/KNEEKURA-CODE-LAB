import {
  parseJsonArtifact,
  boundedArray,
  safePath,
  requireText,
  createImportResult,
  LIMITS,
} from "../../analysis-workbench/contracts.mjs";

function pair(context, options) {
  const base = requireText(options.base_snapshot_id, "base_snapshot_id");
  const head = requireText(
    options.head_snapshot_id ?? context.snapshot_id,
    "head_snapshot_id",
  );
  if (head !== context.snapshot_id)
    throw new Error("head_snapshot_id must match context snapshot_id");
  return { base, head };
}
function location(value, snapshot_id) {
  if (
    !value ||
    !Number.isSafeInteger(value.startLine) ||
    value.startLine < 1 ||
    !Number.isSafeInteger(value.endLine) ||
    value.endLine < value.startLine
  )
    throw new Error("Invalid RefactoringMiner source line range");
  return {
    path: safePath(value.filePath),
    start_line: value.startLine,
    end_line: value.endLine,
    snapshot_id,
  };
}
export function importRefactoringMiner(artifact, context, options = {}) {
  const { base, head } = pair(context, options);
  const data = parseJsonArtifact(artifact);
  const findings = [];
  for (const commit of boundedArray(data.commits, "commits")) {
    const sha = requireText(commit.sha1, "commit sha1");
    if (options.head_commit !== undefined && sha !== options.head_commit)
      throw new Error("RefactoringMiner commit sha1 must match head_commit");
    if (data.commits.length > 1)
      throw new Error("Import one commit per snapshot pair");
    for (const ref of boundedArray(commit.refactorings, "refactorings")) {
      if (findings.length >= LIMITS.maxRecords)
        throw new Error("Too many refactorings");
      const type = requireText(ref.type, "refactoring type");
      const description = requireText(
        ref.description,
        "refactoring description",
      );
      const before = boundedArray(
        ref.leftSideLocations,
        "leftSideLocations",
      ).map((v) => location(v, base));
      const after = boundedArray(
        ref.rightSideLocations,
        "rightSideLocations",
      ).map((v) => location(v, head));
      findings.push({
        kind: "refactoring",
        title: description,
        sources: [...before, ...after],
        capability: "SYNTAX",
        strength: "STRUCTURAL",
        details: {
          type,
          category: /move/i.test(type)
            ? "move"
            : /rename/i.test(type)
              ? "rename"
              : /extract/i.test(type)
                ? "extract"
                : "other",
          base_snapshot_id: base,
          head_snapshot_id: head,
          before,
          after,
          locations: {
            before: ref.leftSideLocations,
            after: ref.rightSideLocations,
          },
          behavior_equivalence: "UNKNOWN",
        },
      });
    }
  }
  return createImportResult("refactoring-miner", artifact, context, findings, {
    format: "refactoringminer-commits-json",
    warnings: [
      "Refactoring labels do not establish behavior equivalence. Base snapshot identity is caller-declared.",
    ],
  });
}

export function importRefactoringMinerAst(artifact, context, options = {}) {
  const { base, head } = pair(context, options);
  const srcPath = safePath(requireText(options.srcPath, "srcPath"));
  const dstPath = safePath(requireText(options.dstPath, "dstPath"));
  const sources = [
    { path: srcPath, snapshot_id: base },
    { path: dstPath, snapshot_id: head },
  ];
  const mappings = boundedArray(parseJsonArtifact(artifact), "AST mappings");
  const findings = mappings.map((mapping) => {
    for (const key of [
      "firstType",
      "secondType",
      "firstParentType",
      "secondParentType",
    ])
      requireText(mapping[key], key);
    for (const key of ["firstLabel", "secondLabel"])
      if (typeof mapping[key] !== "string") throw new Error(`Invalid ${key}`);
    for (const key of ["firstPos", "secondPos", "firstEndPos", "secondEndPos"])
      if (!Number.isSafeInteger(mapping[key]) || mapping[key] < 0)
        throw new Error(`Invalid ${key}`);
    if (
      mapping.firstEndPos < mapping.firstPos ||
      mapping.secondEndPos < mapping.secondPos
    )
      throw new Error("Invalid AST offset range");
    return {
      kind: "ast-mapping",
      title: `${mapping.firstType} → ${mapping.secondType}`,
      sources,
      capability: "SYNTAX",
      strength: "STRUCTURAL",
      details: {
        mapping,
        base_snapshot_id: base,
        head_snapshot_id: head,
        offset_units: "exporter-character-offsets",
        behavior_equivalence: "UNKNOWN",
      },
    };
  });
  if (options.actionText !== undefined) {
    const raw = requireText(options.actionText, "actionText");
    findings.push({
      kind: "ast-action-text",
      title: "RefactoringMiner raw AST action text",
      sources,
      capability: "SYNTAX",
      strength: "STRUCTURAL",
      details: { raw_action_text: raw, structured_actions: false },
    });
  }
  return createImportResult("refactoring-miner", artifact, context, findings, {
    format: "refactoringminer-ast-mappings-json",
    warnings: [
      "AST mappings are offset evidence, not source line ranges or behavior equivalence. Action text is retained without parsing.",
    ],
  });
}
