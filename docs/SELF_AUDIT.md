# KNEEKURA self-audit

The self-audit is an internal dogfood gate for KNEEKURA CODE-LAB. It runs the
Mailbox request-to-result path while capturing CORE internal state so structural
and Evidence invariants can be checked without expanding the public CORE API.

## Run locally

Audit the current commit:

~~~sh
npm run self-audit -- --repo . --commit HEAD
~~~

Audit an exact historical commit:

~~~sh
npm run self-audit -- --repo . --commit <full-commit-sha>
~~~

The target repository is treated as read-only. COMMIT analysis materializes
source bytes outside the repository and the harness verifies that HEAD and
working-tree status are unchanged.

## What the gate checks

The v1 harness fails when any of these structural conditions fail:

- the AnalysisResult snapshot is the exact requested COMMIT;
- the Mailbox service source pin reconciles to that snapshot;
- canonical repository identity matches the target GitHub repository;
- the graph root remains the original repository path;
- every committed analyzable JavaScript file has a JavaScript Evidence record;
- every committed analyzable JavaScript file has a graph file node;
- the JavaScript provider reports no provider failures;
- repository-relative JavaScript imports resolve to repository files;
- the graph contains no error diagnostics;
- the canonical AnalysisResult contains no failures;
- rendered RESULT.md preserves the exact source commit and snapshot id;
- the target repository remains unchanged.

Package, Node built-in, and other external module references may remain
unresolved because the lexical provider does not claim package-resolution
authority. Those references are reported separately and do not fail the
repository-relative import gate.

## Interpreting bug_hunt output

A successful structural self-audit does not mean the Mailbox service result must
be `completed`. CORE v1 does not assign a root-cause role to arbitrary Claims,
so a `bug_hunt` can conservatively remain `partial` with low confidence even
when all structural gates pass.

Likewise, the harness does not convert the absence of Claims into proof that no
bugs exist. It verifies the commit pin, Evidence/provenance pipeline, JavaScript
graph coverage, Mailbox reconciliation, and read-only boundary. Semantic bug
findings still require canonical Evidence and, where applicable, a reasoning or
runtime evidence source.

## GitHub Actions behavior

`.github/workflows/self-audit.yml` runs automatically when the self-audit
harness, CORE, JavaScript analyzer/regressions, or Mailbox adapters change. On a
feature branch it audits the merge-base with `origin/main`; after merge on
`main` it audits the new main HEAD. The workflow can also be started manually
with an explicit commit/ref.
