# History and architecture evidence

These dependency-free importers read saved artifacts only. They do not invoke Git,
Code Maat, Java, ArchUnit, or mutate a target repository or baseline. No upstream
implementation is vendored and no GPL dependency is introduced.

All APIs require context with `repository_id`, `snapshot_id`, `analyzer_version`,
`config_digest`, `scope_digest`, and `engine_id`. Shared contracts enforce byte,
record, string, depth and path limits and produce normalized Fabric observations.
Importer findings are evidence, never canonical causal edges or repair authority.
Exporter identity and completeness are declarations, not independent verification.

## Code Maat native CSV

`importCodeMaat(csvText, context)` accepts the native coupling CSV columns
`entity,coupled,degree,average-revs` in any order, plus preserved extra columns.
Quoted commas, doubled quotes, embedded newlines and CRLF are supported. Duplicate
headers, invalid numerics, degree outside 0–100, malformed quoting, absolute paths
and traversal fail closed. CSV is limited to 8 MiB, 10,000 rows, 128 columns, and
16,384 characters per field.

`degree_percent` is coupling percentage; `average_revisions` retains the exported
average revisions. Neither identifies the actual cochange sample count. Therefore
`sample_count` and `sample_ids` are null for CSV imports. Exporter filters/history
coverage cannot be inferred from CSV. Findings have HEURISTIC strength.

Reference: [Code Maat logical coupling](https://github.com/adamtornhill/code-maat#mining-logical-coupling).

## Explicit KNEEKURA history envelope

This is a separate custom format, not native Code Maat or Git output:

```json
{"schema":"kneekura.history.v1","commits":[
  {"id":"commit-1","files":["src/A.java","src/B.java"],"merge":false,"format_only":false},
  {"id":"commit-2","files":["src/A.java","src/B.java"]}
]}
```

`analyzeCochangeHistory(artifact, context, options)` accepts JSON text or an object.
Options: `exclude_merges` (default false), `exclude_format_only` (false),
`max_commit_files` (100), `min_samples` (2), `max_pairs` (10,000). Numeric options
must be integers from 1 through 10,000. Merge and format classifications must be
explicit boolean declarations if supplied; no message heuristics infer them.
Large commits are excluded, with their IDs and reasons in `history_manifest`.
Duplicate commit IDs and duplicate paths within a commit are rejected. At most
one million pair/sample operations are performed, including repeated pairs.
Expanded sample ID evidence and unique pair path evidence are each capped at 8 MiB
before materializing findings.
Exceeding any pair limit rejects the artifact rather than silently truncating.

For each eligible pair, exact supplied commit IDs and sample count are preserved.
Degree = pair sample count / average eligible revision count of both files × 100.
A file revision means one eligible commit mentioning it. All counts refer only to
the supplied sample. Minimum sample filtering never implies a dependency is absent.
Rename tracking, history fetching and completeness verification are out of scope.

## ArchUnit custom exporter envelope

ArchUnit does not promise the JSON interchange format used here. The importer
accepts only our explicitly named `kneekura.archunit.v1` schema:

```json
{"schema":"kneekura.archunit.v1","baseline_id":"architecture-main","complete":true,
 "rules":[{"id":"rule-v1","description":"Services do not access controllers",
 "violations":[{"id":"stable-violation-id","description":"Service references Controller",
 "sources":[{"path":"src/main/java/example/Service.java","start_line":12}]}]}]}
```

Include every evaluated rule, including clean rules with empty violations. Set
`complete:false` if any rule, source scope, or violation list is partial. Rule IDs
and violation IDs within a rule must be unique. Source arrays may be empty when
no exact path is available; do not fabricate paths from Java package names. Lines
are positive integers; an end line requires a start line and cannot precede it.
An optional source `snapshot_id` must match context. Limits include 10,000 rules,
10,000 total violations, and 100 sources per violation.

`compareArchUnitBaseline(baselineResult, currentResult)` requires the same explicit
baseline ID, rule IDs/descriptions digest, repository, engine, analyzer version,
config and scope digests. Snapshot changes are intentional and permitted. A new
rule or changed rule definition/configuration makes the result incomparable.
Only complete compatible exports receive new/existing/resolved classifications.
Incomplete exports retain `status: incomplete` and no classified findings. A
resolved result means absent from this complete exported evaluation, not proven
absence of all architectural issues. Violation identity is exporter-owned; changing
identity conventions requires a config/version change. No automatic refreeze or
baseline rewriting occurs. Callers must retain the original exported baseline.

Reference: [ArchUnit evaluation and freezing rules](https://www.archunit.org/userguide/html/000_Index.html#_freezing_arch_rules).

### Runnable exporter example (evaluation results)

The following Java 17 example can run in a project that already supplies ArchUnit
and Jackson Databind jars (and their dependencies). It evaluates an ordinary,
unfrozen rule; evaluating a frozen rule can hide existing violations and must not
be declared a complete baseline inventory. This original example uses ArchUnit's
`evaluate` / failure report API; it is not an official JSON exporter. A project
using a custom `ViolationStore` can alternatively serialize its complete saved
rule/violation inventory into the same envelope.

Save as `ExportArchitecture.java` and run with your project's dependency classpath:

```sh
javac -cp "$DEPENDENCY_CP" ExportArchitecture.java
java -cp ".:$DEPENDENCY_CP" ExportArchitecture target/classes > archunit.json
```

```java
import com.tngtech.archunit.core.importer.ClassFileImporter;
import com.tngtech.archunit.lang.ArchRule;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.*;
import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.noClasses;

public class ExportArchitecture {
  static String id(String text) throws Exception {
    return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
      .digest(text.getBytes(StandardCharsets.UTF_8)));
  }
  public static void main(String[] args) throws Exception {
    if (args.length != 1) throw new IllegalArgumentException("classes directory required");
    var classes = new ClassFileImporter().importPath(Path.of(args[0]));
    ArchRule rule = noClasses().that().resideInAPackage("..service..")
      .should().dependOnClassesThat().resideInAPackage("..controller..");
    var report = rule.evaluate(classes).getFailureReport();
    var violations = new ArrayList<Map<String,Object>>();
    // Distinct report lines form this exporter's declared identity convention.
    for (String detail : new TreeSet<>(report.getDetails())) {
      violations.add(Map.of("id", id(detail), "description", detail,
        "sources", List.of()));
    }
    var exportedRule = Map.of("id", "service-controller-v1",
      "description", rule.getDescription(), "violations", violations);
    var envelope = Map.of("schema", "kneekura.archunit.v1",
      "baseline_id", "architecture-main", "complete", true,
      "rules", List.of(exportedRule));
    new ObjectMapper().writeValue(System.out, envelope);
  }
}
```

Here completeness covers exactly the one declared rule over the imported classes;
it does not mean every project rule or source file was analyzed. Bind your context's
scope digest to that class import and config digest to the rule/exporter definition.
Hashing report text means line/text changes may classify a violation as resolved
plus new; applications needing semantic continuity should supply stable IDs from
a richer exporter and mark that identity scheme in config. The Java example is
provided for use in the caller's Java project; automated tests exercise saved JSON,
not a live JVM or real Code Maat/ArchUnit installation.
