# Static evidence imports

These dependency-free adapters import saved artifacts. They do not install or run upstream tools, execute analyzed repositories, alter canonical CORE, or establish behavior equivalence. All provenance is attributed to the caller/exporter, not independently verified. Findings and Fabric observations retain repository, snapshot, analyzer version, config/scope, engine and artifact digest identity.

## Public functions

- `importRefactoringMiner(artifact, context, options)`
- `importRefactoringMinerAst(artifact, context, options)`
- `importJoernSlice(artifact, context, options)`
- `queryJoernBackwardSlice(importResult, {sinkId, maxDepth=8, maxNodes=200})`
- `importCpd(xmlText, context, options)`
- `annotateCloneGroups(importResult, annotations)`

All import functions return the shared immutable evidence-import contract. Context requires `repository_id`, `snapshot_id`, `analyzer_version`, `config_digest`, `scope_digest`, and one isolated `engine_id`. JSON accepts objects or serialized text; CPD accepts XML text only. Paths must already be repository-relative; absolute exporter paths must be deliberately converted by the caller before import. No implicit filesystem lookup or base-directory stripping occurs.

## RefactoringMiner

Native commits JSON is `{commits:[{sha1, refactorings:[{type, description, leftSideLocations, rightSideLocations}]}]}`. Location fields include `filePath`, `startLine`, `endLine`; the native location objects are also preserved in details. Imports accept at most one commit per declared snapshot pair.

Require `options.base_snapshot_id`. `options.head_snapshot_id` defaults to and must equal context snapshot. Git commit IDs and KNEEKURA snapshot IDs belong to different identity domains: optional `options.head_commit` checks native `sha1` explicitly; raw commit hashes are never implicitly compared with snapshot digests. Pair identity remains caller-declared. Rename/move/extract categories aid navigation, with before/after source references carrying their respective snapshot IDs. They are not equivalence claims.

Actual AST mapping JSON is a top-level array of `firstType`, `secondType`, `firstLabel`, `secondLabel`, `firstParentType`, `secondParentType`, `firstPos`, `secondPos`, `firstEndPos`, `secondEndPos`. It has neither paths nor source lines. `importRefactoringMinerAst` therefore also requires explicit `srcPath` and `dstPath` options. Offset evidence is retained without manufacturing line coordinates. Optional bounded `actionText` retains the separate native `*_actions.txt` export as raw text; structured AST actions are not invented or parsed. It is bound into the finding identity separately from the mapping artifact digest. Do not derive paths from flattened export filenames.

Sources: [native output documentation](https://github.com/tsantalis/RefactoringMiner/blob/master/documentation/how-to.md), [pinned 3.1.4 MappingExportModel](https://github.com/tsantalis/RefactoringMiner/blob/6045904aaf4aeb75a1c935070feb4f780339045c/src/main/java/org/refactoringminer/astDiff/utils/MappingExportModel.java).

## Joern

Data-flow input is `{nodes:[...], edges:[...]}`. Nodes retain `id`, `label`, `code`, optional name/type/method/file and source coordinates; edges retain `src`, `dst`, `label`. Node IDs normalize to decimal strings and unsafe JavaScript numeric IDs fail closed: export large Long IDs as strings before precision is lost. Duplicate node IDs and dangling edge endpoints are rejected. Input is capped at 1,000 nodes and 20,000 edges. Query walks incoming edges across their preserved labels, with visited-node cycle protection, maximum depth 64 and output maximum 1,000 nodes. `truncated` explicitly indicates omitted reachable predecessors. This is graph reachability over saved static evidence, not a claim that a sink executed or a complete taint analysis.

Usage input is `{objectSlices:[{code,fullName,fileName,slices:[{targetObj,definedBy,invokedCalls,argToCalls}],lineNumber?,columnNumber?}],userDefinedTypes:[{name,fields,procedures,fileName?,lineNumber?,columnNumber?}]}`. Definition components and call fields are preserved. Current upstream custom serialization can JSON-encode `targetObj`/`definedBy` as strings: only these specific fields are decoded once, to validated objects. Direct object components also support the documentation shape. Current derived optional fields accept scalar/null/omitted. The custom `argToCalls` writer also produces empty/single-element arrays for optional method/line/column fields, which are normalized specifically there. Arbitrary recursively encoded JSON is not accepted.

Sources: [Joern slicing documentation](https://docs.joern.io/cpg-slicing/), [pinned serializer definitions](https://github.com/joernio/joern/blob/3218f990c258a29e5715198a94d776b7aeabfdff/dataflowengineoss/src/main/scala/io/joern/dataflowengineoss/slicing/package.scala). Fixtures are schema-derived examples, not claims of running Joern locally.

## PMD CPD

Use official XML `pmd-cpd` reports. Each `duplication` retains positive `lines`/`tokens`, at least two child `file` occurrence ranges, and optional literal `codefragment`. Root-level `file` elements are inventory and do not become clone occurrences. If an occurrence omits `endline`, it is derived as `line + duplication.lines - 1`. XML predefined/numeric entities and CDATA are supported without external resolution. DTD/entity declarations, malformed nesting, duplicate attributes, unknown report structures and unsafe paths are rejected. Report errors become coverage warnings. There is no claimed official CPD JSON format.

`annotateCloneGroups(result, [{finding_id, label, note}])` verifies the import and group IDs and returns a separate `kneekura.clone-annotations/v1` envelope with `HUMAN_ANNOTATION` authority. It does not modify imported evidence or authorize deletion. Token similarity is never semantic equivalence.

Source: [PMD report formats](https://pmd.github.io/pmd/pmd_userdocs_cpd_report_formats.html).

## Verification and limits

Fixtures under `fixtures/workbench/static/` are small synthetic examples matching documented/pinned schemas, not live analyzer captures. Run `node --test test/workbench-static-imports.test.mjs`. Tests cover source identity, native serializer quirks, immutability, deterministic IDs, malformed/oversized input, traversal paths, unsafe numeric IDs, missing endpoints, bounded traversal and annotation separation. Shared artifact limit is 8 MiB; strings/record arrays/nesting and source references have additional shared bounds. XML counts every element against its structural record budget. Unknown coverage remains partial. Rendering must escape all imported text.
