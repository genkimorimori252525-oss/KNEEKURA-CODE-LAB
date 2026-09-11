# KNEEKURA Code LAB ALL Mode Semantic Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable GitHub Relay `selection: all` only through three independently claimed standalone semantic host contexts, then compose their already-sealed artifacts into one deterministic ALL bundle without semantic fusion.

**Architecture:** The parent ALL Relay issue is a control-plane coordinator and never executes semantic engine tasks. It creates exactly three immutable child slots (`kneekura`, `understand-anything`, `archify`), each child runs the existing standalone Relay path after an externally supplied host-context claim, and the parent composes only verified terminal child receipts and exact sealed ZIP bytes. Existing local/in-process ALL execution remains available and shares the extracted sealed-outcome composer.

**Tech Stack:** Node.js ESM, GitHub Actions, GitHub Issue Relay protocol, existing MCP Host Bridge, deterministic ZIP packaging, Node built-in test runner.

**Spec:** `docs/superpowers/specs/2026-09-12-all-mode-semantic-isolation-design.md`

## Global Constraints

- Parent ALL execution must never call the semantic Host Bridge backend.
- Exactly three child engine slots are permitted: `kneekura`, `understand-anything`, `archify`.
- Child Issues alone are not semantic-isolation proof; each child requires a distinct externally supplied `host_context_id`.
- The assurance class for ChatGPT Web acceptance is `OPERATOR_SEPARATED_HOST_SESSION_V1`.
- Child runs inherit the parent canonical `snapshot_id` and parent `scope_digest`; child-specific request identity is bound separately by `child_request_digest`.
- Host responses and bounded source reads must remain exact child run/engine/attempt/task bound.
- Parent composition accepts only child binding metadata, accepted context claims, terminal result metadata, sanitized receipts, and sealed artifact bytes.
- Parent comparison remains `semantic_fusion=false`, `canonical_truth_promotion=false`, and `engine_substitution=false`.
- Existing standalone Relay behavior and sealed engine bytes must not change.
- `selection: all` remains fail-closed/non-terminal until real three-context acceptance passes.
- All production changes use TDD: new behavior must fail before implementation and pass afterward.

---

### Task 1: Freeze executable parent/child/context contracts

**Files:**
- Create: `src/github-relay/all-mode-contracts.mjs`
- Modify: `src/github-relay/index.mjs`
- Modify: `src/github-relay/contracts.mjs`
- Test: `test/kneekura-code-lab-github-relay-all-contracts.test.mjs`

**Interfaces:**
- Produces: `ALL_PARENT_SCHEMA`, `ALL_CHILD_BINDING_SCHEMA`, `ALL_CONTEXT_CLAIM_SCHEMA`, `ALL_CHILD_RESULT_MANIFEST_SCHEMA`.
- Produces: `createAllChildBindings({ parentRunId, parentIssueNumber, request, relayPlan })`.
- Produces: `validateAllContextClaim(value, binding)`.
- Produces: `validateAllChildResultManifest(value, binding, parentPlan)`.
- Produces: `allChildRequestDigest(binding)`.
- Consumes existing exact target and digest validators from the Relay contract layer where practical; duplicated validation logic is forbidden when an existing exported helper can be made safely reusable.

- [ ] **Step 1: Write failing contract tests**

Add tests that require exactly three fixed engine slots, verify parent/child Issue and target bindings, verify `child_request_digest`, accept idempotent identical context claims, reject context rebind, and reject wrong engine/parent/runtime/lock/snapshot/scope fields.

```js
const bindings = createAllChildBindings({
  parentRunId: 'ghr-parent',
  parentIssueNumber: 200,
  request: parentRequest,
  relayPlan: parentPlan
});
assert.deepEqual(bindings.map(row => row.engine_id), [
  'kneekura', 'understand-anything', 'archify'
]);
assert.ok(bindings.every(row => row.scope_digest === parentPlan.target.scope_digest));
assert.equal(new Set(bindings.map(row => row.child_request_digest)).size, 3);
```

Context collision/rebind coverage:

```js
assert.throws(
  () => validateAllContextClaim({ ...validClaim, engine_id: 'archify' }, bindings[0]),
  error => error?.code === 'BLOCKED_SEMANTIC_CONTEXT_ISOLATION'
);
```

- [ ] **Step 2: Run only the new test and verify RED**

Run:

```bash
node --test test/kneekura-code-lab-github-relay-all-contracts.test.mjs
```

Expected: FAIL because the ALL contract module/exports do not exist.

- [ ] **Step 3: Implement minimal contract module**

The child request digest must include child engine and parent binding but must not replace the inherited parent scope digest:

```js
export function allChildRequestDigest(binding) {
  return `sha256:${crypto.createHash('sha256')
    .update('kneekura.github-relay.all-child-request/v1\0')
    .update(stableRelayJson({
      parent_run_id: binding.parent_run_id,
      parent_issue_number: binding.parent_issue_number,
      engine_id: binding.engine_id,
      target: binding.target,
      scope_digest: binding.scope_digest
    }))
    .digest('hex')}`;
}
```

`validateAllContextClaim()` must fail closed unless parent run, child issue, engine slot, and assurance class match exactly. It must normalize but never invent `host_context_id`.

- [ ] **Step 4: Run new test and Relay contract regression tests**

Run:

```bash
node --test test/kneekura-code-lab-github-relay-all-contracts.test.mjs test/kneekura-code-lab-github-relay-p0-p2.test.mjs
```

Expected: PASS, zero failures.

- [ ] **Step 5: Commit**

```bash
git add src/github-relay/all-mode-contracts.mjs src/github-relay/index.mjs src/github-relay/contracts.mjs test/kneekura-code-lab-github-relay-all-contracts.test.mjs
git commit -m "feat: add ALL Relay isolation contracts"
```

---

### Task 2: Extract a sealed-outcome-only ALL composer

**Files:**
- Create: `src/skill/sealed-outcome-composer.mjs`
- Modify: `src/skill/all-mode.mjs`
- Modify: `src/skill/index.mjs`
- Test: `test/kneekura-code-lab-skill-all-mode.test.mjs`
- Create: `test/kneekura-code-lab-skill-sealed-composer.test.mjs`

**Interfaces:**
- Produces: `composeSealedAllModeBundle({ runId, snapshotId, scopeDigest, outcomes, contextMetadata? })`.
- Input `outcomes` contains exactly three rows with `engine_id`, sanitized `receipt`, `sealed_bytes`, and verified `sealed_artifact` metadata.
- Existing `runAllModeBundle()` continues executing local runners, then delegates final packaging/comparison to the new composer.

- [ ] **Step 1: Write failing composer tests**

Prove exactly one outcome per engine, same snapshot/scope, no substitution, deterministic ZIP output, and metadata-only comparison.

```js
const composed = composeSealedAllModeBundle({
  runId: 'parent-run',
  snapshotId: SNAPSHOT,
  scopeDigest: SCOPE,
  outcomes: [kneekuraOutcome, uaOutcome, archifyOutcome],
  contextMetadata: [
    { engine_id: 'kneekura', host_context_id: 'ctx-a', assurance_class: 'OPERATOR_SEPARATED_HOST_SESSION_V1' },
    { engine_id: 'understand-anything', host_context_id: 'ctx-b', assurance_class: 'OPERATOR_SEPARATED_HOST_SESSION_V1' },
    { engine_id: 'archify', host_context_id: 'ctx-c', assurance_class: 'OPERATOR_SEPARATED_HOST_SESSION_V1' }
  ]
});
assert.equal(composed.comparison.semantic_fusion, false);
assert.equal(composed.comparison.canonical_truth_promotion, false);
assert.equal(composed.comparison.engine_substitution, false);
```

Also assert duplicate/missing engines throw `ALL_MODE_ENGINE_SET_INVALID` and duplicate context IDs throw `BLOCKED_SEMANTIC_CONTEXT_ISOLATION` when `contextMetadata` is supplied.

- [ ] **Step 2: Run composer tests and verify RED**

```bash
node --test test/kneekura-code-lab-skill-sealed-composer.test.mjs
```

Expected: FAIL because composer export is absent.

- [ ] **Step 3: Extract packaging/comparison logic with no semantic APIs**

Move status/comparison/run-manifest/ZIP assembly from `runAllModeBundle()` into the composer. The composer module must not import Host Bridge, source broker, engine runners, or semantic scheduler code.

- [ ] **Step 4: Make `runAllModeBundle()` delegate after runner sealing**

Local ALL keeps current runner behavior and accepted outcome validation, then calls `composeSealedAllModeBundle()` with the same sealed outcomes. Preserve existing bundle bytes for unchanged local fixture inputs; if deterministic bytes change because the manifest schema is intentionally extended, update only the explicit expected fixture after verifying semantic content is unchanged.

- [ ] **Step 5: Run focused and existing ALL tests**

```bash
node --test test/kneekura-code-lab-skill-sealed-composer.test.mjs test/kneekura-code-lab-skill-all-mode.test.mjs test/kneekura-code-lab-mcp-adapter.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/skill/sealed-outcome-composer.mjs src/skill/all-mode.mjs src/skill/index.mjs test/kneekura-code-lab-skill-all-mode.test.mjs test/kneekura-code-lab-skill-sealed-composer.test.mjs
git commit -m "refactor: compose ALL bundle from sealed outcomes"
```

---

### Task 3: Add parent/child ALL Relay orchestration without semantic backend access

**Files:**
- Create: `src/github-relay/all-mode-orchestrator.mjs`
- Modify: `src/github-relay/orchestrator.mjs`
- Modify: `src/github-relay/issue-transport.mjs`
- Modify: `src/github-relay/index.mjs`
- Test: `test/kneekura-code-lab-github-relay-all-orchestrator.test.mjs`

**Interfaces:**
- Produces: `runGithubRelayAllParentTurn({ ... })` returning control-plane actions only.
- Produces action kinds: `ALL_CHILD_CREATE`, `ALL_CONTEXTS_REQUIRED`, `ALL_COMPOSE_REQUIRED`, `ALL_RESULT`.
- Existing `runGithubRelayTurn()` routes `selection !== 'all'` unchanged. For `selection === 'all'`, it dispatches to the parent controller before `replayGithubRelayRun()` or `backend.execute()` can be reached.
- Parent input allowlist consumes only parent plan, child binding records, context claims, child terminal result manifests, and verified artifact descriptors.

- [ ] **Step 1: Write failing orchestration tests**

Use a backend spy that throws if any semantic method is called:

```js
const backend = {
  async execute() { throw new Error('semantic backend must not run for ALL parent'); }
};
const turn = await runGithubRelayTurn({ request: allRequest, backend, ...fixture });
assert.deepEqual(turn.actions.map(row => row.kind), [
  'PLAN', 'ALL_CHILD_CREATE', 'ALL_CHILD_CREATE', 'ALL_CHILD_CREATE', 'ALL_CONTEXTS_REQUIRED'
]);
```

Add replay tests proving repeated parent turns reuse immutable child slots and do not create fourth/replacement children.

- [ ] **Step 2: Verify RED**

```bash
node --test test/kneekura-code-lab-github-relay-all-orchestrator.test.mjs
```

Expected: FAIL because ALL still reaches normal replay/backend execution.

- [ ] **Step 3: Implement explicit ALL branch before semantic replay**

The first branch in `runGithubRelayTurn()` after context/continuity calculation must be conceptually:

```js
if (context.request.selection === 'all') {
  return runGithubRelayAllParentTurn({ context, ...allControlPlaneInputs });
}
```

Do not create a combined Host Response ledger for the parent.

- [ ] **Step 4: Enforce child isolation in transport parsing**

Add strict markers/schemas for parent child-binding/context-claim/control messages. Parent collection must not parse `KNEEKURA_RELAY_RESPONSE_V1` bodies as composition input.

- [ ] **Step 5: Run Relay regression suite**

```bash
node --test test/kneekura-code-lab-github-relay-all-orchestrator.test.mjs test/kneekura-code-lab-github-relay-p3a.test.mjs test/kneekura-code-lab-github-relay-p3e-stable-task-identity.test.mjs test/kneekura-code-lab-github-relay-p3f-source-recovery.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/github-relay/all-mode-orchestrator.mjs src/github-relay/orchestrator.mjs src/github-relay/issue-transport.mjs src/github-relay/index.mjs test/kneekura-code-lab-github-relay-all-orchestrator.test.mjs
git commit -m "feat: coordinate isolated ALL Relay children"
```

---

### Task 4: Seal child result manifest and verified parent composition input

**Files:**
- Create: `src/github-relay/child-result-manifest.mjs`
- Modify: `scripts/run-kneekura-github-relay.mjs`
- Modify: `src/github-relay/task-payload-transport.mjs` only if needed for bounded outer artifact staging; do not put semantic bytes in comments.
- Create: `scripts/compose-kneekura-github-relay-all.mjs`
- Test: `test/kneekura-code-lab-github-relay-all-artifacts.test.mjs`

**Interfaces:**
- Child Actions artifact contains exactly `result.zip`, `engine-receipt.json`, `child-result-manifest.json` for successful/partial terminal children.
- Produces: `createChildResultManifest({ binding, contextClaim, relayResult, receipt, sealedBytes })`.
- Produces: `verifyChildCompositionInput({ manifest, receipt, sealedBytes, expectedBinding, parentPlan })`.
- Parent compose script accepts three verified child inputs and delegates to `composeSealedAllModeBundle()`.

- [ ] **Step 1: Write failing artifact/manifest tests**

Assert the manifest binds parent run, parent issue, child issue, engine, host context, assurance class, runtime revision, engine-lock digest, target identities, `result.zip` digest/bytes, and receipt digest.

Tamper tests must reject one-byte ZIP changes, receipt changes, wrong child Issue, wrong runtime, wrong scope, wrong engine, and duplicated context ID.

- [ ] **Step 2: Verify RED**

```bash
node --test test/kneekura-code-lab-github-relay-all-artifacts.test.mjs
```

Expected: FAIL because manifest/composer transport is absent.

- [ ] **Step 3: Add child artifact staging without changing `result.zip` bytes**

The existing result ZIP remains the exact standalone engine artifact. Compute its digest from bytes and write the sanitized receipt and manifest alongside it in a fresh staging directory. Never unpack/repack `result.zip` for child transport.

- [ ] **Step 4: Add parent verification/composition script**

The script must recompute every digest before invoking the sealed composer and must fail with integrity errors rather than PARTIAL when target/runtime/lock/context/artifact identity is invalid.

- [ ] **Step 5: Run focused tests and standalone Relay regressions**

```bash
node --test test/kneekura-code-lab-github-relay-all-artifacts.test.mjs test/kneekura-code-lab-github-relay-p3c-task-payload.test.mjs test/kneekura-code-lab-github-relay-p4-runtime-migration.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/github-relay/child-result-manifest.mjs scripts/run-kneekura-github-relay.mjs scripts/compose-kneekura-github-relay-all.mjs test/kneekura-code-lab-github-relay-all-artifacts.test.mjs
git commit -m "feat: bind child sealed results for ALL composition"
```

---

### Task 5: Activate workflow support while preserving standalone preparation

**Files:**
- Modify: `.github/workflows/kneekura-github-relay.yml`
- Modify: `scripts/publish-kneekura-github-relay.mjs`
- Test: `test/kneekura-code-lab-github-relay-all-workflow.test.mjs`
- Modify: `docs/github-relay-v1.md`

**Interfaces:**
- Parent ALL turn prepares no UA/Archify engine runtime and executes no semantic engine.
- Child standalone UA still receives Node 22 + pinned UA prep.
- Child standalone Archify still receives pinned Archify prep.
- Allowed external marker `KNEEKURA_RELAY_CONTEXT_CLAIM_V1` triggers child execution; workflow-token-created child Issues do not rely on recursive Actions triggering.
- Parent compose turn can read exact child Actions artifacts with the minimum necessary GitHub permission.

- [ ] **Step 1: Write failing workflow text/behavior tests**

Assert that `selection == 'all'` is not included in the UA/Archify prep conditions and that a context-claim marker is gated as an allowed external activation event.

Assert parent control path has the Actions-artifact read permission it needs but no additional repository mutation authority beyond Issue control/transport requirements.

- [ ] **Step 2: Verify RED**

```bash
node --test test/kneekura-code-lab-github-relay-all-workflow.test.mjs
```

Expected: FAIL on missing context-claim/parent compose support.

- [ ] **Step 3: Implement workflow/publisher changes**

Keep engine preparation single-engine only. Add parent/child control outputs and artifact staging paths without making `selection: all` enter normal semantic replay.

- [ ] **Step 4: Update Relay documentation**

Document the parent/child lifecycle, operational context assurance class, and explicit limitation that ChatGPT Web context separation is operator-attested rather than provider-signed.

- [ ] **Step 5: Run workflow and Relay tests**

```bash
node --test test/kneekura-code-lab-github-relay-all-workflow.test.mjs test/kneekura-code-lab-github-relay-p3b-workflow.test.mjs test/kneekura-code-lab-github-relay-p4-ua-prep.test.mjs test/kneekura-code-lab-github-relay-p4-ua-fast-prep.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/kneekura-github-relay.yml scripts/publish-kneekura-github-relay.mjs docs/github-relay-v1.md test/kneekura-code-lab-github-relay-all-workflow.test.mjs
git commit -m "feat: activate isolated ALL Relay workflow"
```

---

### Task 6: Prove isolation adversarially in fixture acceptance

**Files:**
- Create: `scripts/validate-kneekura-code-lab-relay-all-isolation.mjs`
- Create: `test/kneekura-code-lab-github-relay-all-acceptance.test.mjs`
- Modify: `package.json` to add a bounded validation script if consistent with existing project scripts.

**Interfaces:**
- Validator builds one parent fixture and three child fixture histories.
- It must explicitly attempt cross-child response reuse and source-request reuse and require rejection.
- It must verify no parent semantic Host Task was emitted.
- It must verify deterministic composition from three verified fixture child ZIPs.

- [ ] **Step 1: Write fixture acceptance test first**

The test must fail unless these exact invariants are observed:

```js
assert.equal(report.parent_semantic_task_count, 0);
assert.equal(report.context_ids_distinct, true);
assert.equal(report.cross_child_response_rejected, true);
assert.equal(report.cross_child_source_request_rejected, true);
assert.equal(report.comparison.semantic_fusion, false);
assert.equal(report.comparison.canonical_truth_promotion, false);
assert.equal(report.comparison.engine_substitution, false);
assert.equal(report.deterministic_bundle, true);
```

- [ ] **Step 2: Verify RED**

```bash
node --test test/kneekura-code-lab-github-relay-all-acceptance.test.mjs
```

Expected: FAIL until validator exists.

- [ ] **Step 3: Implement validator with no network dependency**

Use local fixtures and exact protocol modules. Do not weaken production validators for fixture convenience.

- [ ] **Step 4: Run focused acceptance and full npm tests**

```bash
node --test test/kneekura-code-lab-github-relay-all-acceptance.test.mjs
npm test
```

Expected: zero failures.

- [ ] **Step 5: Commit**

```bash
git add scripts/validate-kneekura-code-lab-relay-all-isolation.mjs test/kneekura-code-lab-github-relay-all-acceptance.test.mjs package.json
git commit -m "test: prove ALL Relay semantic isolation"
```

---

### Task 7: Real KNEEKURA-LAB three-context acceptance and release gate

**Files:**
- Create acceptance record under: `docs/acceptance/` if that directory is introduced by implementation; otherwise use `docs/` with a specific filename such as `KNEEKURA_CODE_LAB_ALL_RELAY_ACCEPTANCE_20260912.md`.
- No production code changes are permitted during the acceptance run except a separately reviewed fix discovered by evidence, which must restart the affected verification gate.

**Interfaces:**
- Exact target revision: `genkimorimori252525-oss/KNEEKURA-LAB@e96e40ab0fc7a8995a1972d8f9defb2aa894ad0e`.
- Parent ALL Issue plus exactly three child Issues.
- Three distinct externally supplied `host_context_id` values using assurance class `OPERATOR_SEPARATED_HOST_SESSION_V1`.
- Parent composes only after the three children are terminal and artifacts are verified.

- [ ] **Step 1: Create the parent ALL Relay request against the exact target revision**

Use `semanticContextMode: "per-engine"`. Confirm the parent returns three immutable child slots and does not emit a semantic Host Task.

- [ ] **Step 2: Claim each child from a deliberately separate semantic host session**

Record the three distinct opaque context IDs. Do not process two child semantic tasks from the same claimed host context.

- [ ] **Step 3: Complete each child through its existing standalone Relay flow**

KNEEKURA, UA, and Archify each independently reach terminal sealed result. No child response is copied into a sibling.

- [ ] **Step 4: Trigger parent composition and verify exact child bytes**

Recompute each child `result.zip` digest/bytes, validate sanitized receipt and child manifest, then produce the parent ALL bundle.

- [ ] **Step 5: Inspect final parent bundle**

Verify parent run manifest has one child per engine, same target snapshot/scope, three distinct context IDs, expected assurance class, and exact child artifact identities. Verify operational comparison flags remain all false.

- [ ] **Step 6: Run one adversarial cross-child replay attempt against the accepted protocol**

A response from one child must fail against a sibling binding with an exact binding/isolation error.

- [ ] **Step 7: Run fresh final verification before claiming completion**

Verify the exact acceptance Actions runs are successful, artifact digests match inspected bytes, relevant PR checks are green, and no shared-context ALL fallback is enabled.

- [ ] **Step 8: Commit the acceptance record**

```bash
git add docs/<final-acceptance-record>.md
git commit -m "docs: record ALL Relay isolation acceptance"
```

The production behavior is accepted only after this task passes. Before then, ALL Relay must remain blocked or non-terminal rather than silently using shared semantic context.