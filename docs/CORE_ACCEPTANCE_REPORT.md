# CORE Milestone H Acceptance Report

Status: acceptance suite passed; plugin-readiness gate opened.

## Baseline identities

Architecture §29 names these design baselines:

| Repository | Baseline SHA | Verification |
| --- | --- | --- |
| KNEEKURA-CODE-LAB | `7a20ed6c4fdcb3ec39b072d5bb0d4c158820cb12` | commit exists |
| YSM decoded repo | `cdd903691c129ce565d4680ba83c00f2d04993d6` | commit exists and is the AT-01 oracle source |
| KNEEKURA-LAB | `15c270377d27fc06976d29fd285152a368ff9b58` | commit exists |
| reimu-mod | `ff4e3e03c3d1f44da4e1b722bb35b80209d4b8e2` | commit exists |

The complete CORE acceptance suite was executed on the current successor of
the KNEEKURA-CODE-LAB baseline, after Milestones A-G were merged.

The report does not claim that the entire test suite was executed by checking
out the old KNEEKURA-CODE-LAB baseline SHA.

## AT-01 manual YSM oracle

Pinned source:

`genkimorimori252525-oss/ysm-2.6.2-forge-mc1.20.1-releaseKaidoku`

Snapshot:

`cdd903691c129ce565d4680ba83c00f2d04993d6`

The pinned source is mapped JVM bytecode (`mapped/Class*.class`), not
reconstructed Java source.

Manually validated anchors include:

- `mapped/Class408.class`
  - blob `65e449330e1633bf4194c4c2b860ed09b412138f`
  - LivingEntityRenderer path
  - captures PoseStack Matrix4f snapshots around renderer entry
- `mapped/Class410.class`
  - blob `c291a30f60645b967038c80f97e597561a119653`
  - obtains current PoseStack.Pose plus Class768 model/float-array data
  - calls Class878.method3661
- `mapped/Class768.class`
  - blob `0ced83ab6521a3f48a35aef963790aa1c93c8edc`
  - supplies model/mesh object and render float arrays
- `mapped/Class878.class`
  - blob `1eee5f6f3475dafec9096cdfdcfd01d8458d8079`
  - method3661 combines projection/model-view Matrix4f data and calls method3662
  - method3662 has JVM access flags 266 and ACC_NATIVE
  - method3662 has no Java Code body

Accepted AT-01 conclusion:

> The final JVM-visible handoff is
> `Class878.method3662`, a static native method. The exact final per-bone
> matrix generation point inside the native ysm-core implementation remains
> UNKNOWN from the pinned mapped JVM classes.

The acceptance oracle intentionally rejects certainty that:

- Class408.field1125 is the final per-bone matrix
- Class408.field1126 is the final per-bone matrix
- Class878.field2850 is the final per-bone matrix
- Class408.method1332 is the exact final bone-matrix generator

Oracle file:

`fixtures/core/acceptance/at-01-bone-matrix-oracle.json`

## AT-01 through AT-12

Formal suite:

`test/core-acceptance.test.mjs`

First fully passing acceptance run:

- CI #503
- AT-01 through AT-12: all PASS
- full suite at that point: 197/197 PASS
- scan + Understand Anything smoke: PASS
- workspace smoke: PASS
- runtime trace smoke: PASS
- pose smoke: PASS
- network smoke: PASS
- palette/bone overlay smoke: PASS

### AT-01 — final bone-matrix trace

PASS.

Exact Java-visible anchors and native boundary are pinned. Native-internal
generation remains explicit UNKNOWN.

### AT-02 — M5 is not M6

PASS.

M5 command handled/consumed is verified while formal M6 state application is
not fabricated.

### AT-03 — send is not receive

PASS.

Send-only fixture produces no verified receive and no invented packet-loss or
client-failure conclusion.

### AT-04 — runtime identity mismatch

PASS.

Wrong-run network companion is rejected as
`RUNTIME_IDENTITY_MISMATCH`; mismatched runtime capture is not joined.

### AT-05 — cross-repository semantic path

PASS.

The workspace path preserves TLM/YSM repository boundaries through shared
Molang/animation semantic contracts and YSM-local animation/bone edges.
Cross-repository Java `CALLS` edges are not invented.

### AT-06 — negative claim qualification

PASS.

A relevant UNEXPLORED scope item produces PARTIAL Coverage and the negative
Claim remains UNRESOLVED with a Coverage gap.

### AT-07 — snapshot race

PASS.

Workspace mutation after freeze changes SnapshotIdentity and raises
`SNAPSHOT_CHANGED`.

### AT-08 — same-snapshot resume/context reuse

PASS.

Deterministic provider evidence is reused with no new provider acquisition,
verified semantics remain identical, and a host that explicitly acknowledges
stable cached Evidence IDs receives ref-only reuse on the second transmission
instead of duplicate full EvidenceRecords.

### AT-09 — selective invalidation

PASS.

Unchanged C1 parse facts remain reusable while changed content misses the old
dependency key. Claims depending on invalidated evidence are invalidated while
unrelated claims remain reusable.

### AT-10 — obfuscation ambiguity

PASS.

Two exact Class408 candidates remain an explicit ambiguous set; a merely
similar Class408Helper is not promoted into the exact candidate set.

### AT-11 — prompt injection in source data

PASS.

Instruction-like Java comments and README text do not change deterministic
Scope or Rules and do not become host authority. A symlink outside the target
root is ignored where the platform permits symlink creation.

### AT-12 — insufficient budget

PASS.

An intentionally inadequate exhaustive request returns:

- run status PARTIAL
- `BUDGET_EXHAUSTED`
- PARTIAL Coverage
- explicit UNEXPLORED budget-bound scope
- corresponding Coverage UNKNOWN entry

No false completeness is emitted.

## Plugin-readiness gate

Only after the 12 acceptance tests passed, Milestone H added:

- `src/adapters/core-plugin.mjs`
- `src/plugin.mjs`
- `docs/CORE_SCHEMA_FREEZE_V1.md`
- `docs/CORE_PLUGIN_ADAPTER.md`
- `docs/CORE_HOST_INTEGRATION.md`

Plugin/schema contract regression run:

- CI #509
- 202/202 PASS
- plugin manifest/schema tests: PASS
- real plugin analyze/expand/get delegation: PASS
- unknown host Evidence-cache ID rejection: PASS

## Remaining merge gate

Milestone H is merge-ready only when the final branch head has:

- push CI green
- PR CI green
- AT-01..AT-12 still green
- plugin contract tests green
- no unresolved review threads
