# CORE Host Integration Guide

This is the minimal host integration path for CORE v1.

Stable package subpaths:

~~~text
kneekura-code-lab/plugin
kneekura-code-lab/mailbox
~~~

When working directly from a source checkout, the equivalent files are
`./src/plugin.mjs` and `./src/mailbox.mjs`.

## 1. Create an engine

~~~js
import {
  createCoreEngine,
  createCorePluginAdapter
} from 'kneekura-code-lab/plugin';

const engine = createCoreEngine({
  // optional CORE-owned session/cache configuration
  // optional host ReasoningBridge
});

const plugin = createCorePluginAdapter({ engine });
~~~

CORE-owned session/cache storage must be outside the target repository.

## 2. Inspect the contract

~~~js
const manifest = plugin.describe();
~~~

Expect:

- `core.analysis-request/v1`
- `core.analysis-result/v1`
- read-only target access
- no provider credential ownership

## 3. Analyze

~~~js
const result = await plugin.analyze({
  schema: 'core.analysis-request/v1',
  repository: '/path/to/repository',
  mode: 'TRACE',
  question: 'Trace this behavior.',
  scope: {
    symbols: ['Example']
  },
  policy: 'precision',
  output_profile: 'compact'
});
~~~

Use the returned AnalysisResult as the source of truth. Do not replace Claim,
Evidence, Coverage, or verifier semantics with host prose.

For a commit-pinned Mailbox or other reproducible host job, pass the requested
full commit through `snapshot_selector`:

~~~js
const result = await plugin.analyze({
  schema: 'core.analysis-request/v1',
  repository: '/path/to/repository',
  snapshot_selector: {
    kind: 'COMMIT',
    commit: 'FULL_COMMIT_SHA'
  },
  mode: 'TRACE',
  question: 'Trace this behavior at the pinned commit.',
  policy: 'precision',
  output_profile: 'compact'
});
~~~

A COMMIT selector analyzes the Git blobs from that exact commit through a
CORE-owned temporary materialization. It does not checkout/reset the source
repository and does not consume dirty working-tree bytes. Confirm
`result.snapshot.kind === 'COMMIT'` and
`result.snapshot.base_commit === requestedCommit` before projecting a
commit-pinned external service result.

Use `{ kind: 'WORKSPACE' }` only when the current frozen working tree is
intentionally the analysis target.

## 4. Expand only when needed

~~~js
const delta = await plugin.expand(
  result.analysis_id,
  { kind: 'GRAPH_NODE', ref: 'node-id' },
  { scope_depth: 1 }
);
~~~

Expansion stays on the frozen analysis snapshot.

## 5. Resolve refs

~~~js
const evidence = plugin.get('evidence:sha256:...');
const claim = plugin.get('claim:sha256:...');
~~~

Treat stable refs as identities, not as filesystem paths.

## 6. Resume

With persistent CORE-owned SessionStore:

~~~js
const handle = await plugin.session.resume(result.session_id);
~~~

Same-snapshot reuse is dependency validated. Cross-snapshot continuation does
not automatically replay path-only evidence.

## 7. Optional ReasoningBridge

The host may inject a ReasoningBridge into the engine.

The bridge receives Evidence Capsules and returns ProposedClaims. CORE performs
canonical Claim construction and verification afterward.

Provider credentials remain in the host adapter, not in CORE.

For repeated same-snapshot queries, a host adapter may optionally expose:

~~~js
knownEvidenceIds({ analysis_id, snapshot_id, evidence_ids })
  -> string[]
~~~

Return only IDs whose canonical EvidenceRecords are already retained by that
host. CORE then sends those IDs as reuse refs and sends full records for all
remaining evidence.

## 8. Render

The same canonical AnalysisResult can be sent to:

- `renderAnalysisForAI()`
- Human Viewer
- Jolly Research Mailbox
- another consumer

Human explanation text is never verification authority.

For the Jolly Research Mailbox machine consumer:

~~~js
import {
  toJollyResearchMailbox
} from 'kneekura-code-lab/mailbox';

const mailboxEntry = toJollyResearchMailbox(result, {
  profile: 'compact'
});
~~~

The mailbox adapter preserves canonical Claim IDs/status, support and
counterevidence IDs, Coverage completeness, UNKNOWNs, warnings/failures, and
recommended validation. Its output is detached from the canonical
AnalysisResult so consumer-side formatting cannot mutate CORE state.

This machine entry is not permission to invent a narrative root cause or code
change. A mailbox host may format the entry into the service-specific
`RESULT.md` contract, but facts and certainty must remain bounded by the
canonical Claims, Evidence, Coverage, and verifier state.

## 9. Consume a KNEEKURA Mailbox REQUEST.md

A host can parse the canonical Mailbox request and construct an execution plan
without teaching CORE the Mailbox protocol:

~~~js
import {
  parseJollyResearchMailboxRequestMarkdown,
  toJollyResearchMailboxCoreExecutionPlan
} from 'kneekura-code-lab/mailbox';

const job =
  parseJollyResearchMailboxRequestMarkdown(requestMarkdown);

const plan =
  toJollyResearchMailboxCoreExecutionPlan(job, {
    repository: localRepositoryRoot
  });

const result = await core.analyze(plan.core_request);
~~~

`job.source_repository` and `plan.core_request.repository` are deliberately
different concepts. The first is Mailbox/GitHub source identity such as
`owner/repository`. The second is the local repository execution target that
CORE reads. The adapter never substitutes the GitHub name for the local path.

The execution plan always copies the required full `source_commit` into:

~~~text
snapshot_selector.kind   = COMMIT
snapshot_selector.commit = source_commit
~~~

Therefore a Mailbox job cannot silently fall back to the current workspace.

Mailbox analysis modes are mapped to the frozen CORE v1 modes according to
planner behavior:

| Mailbox mode | CORE mode |
| --- | --- |
| `architecture` | `UNDERSTAND` |
| `bug_hunt` | `DIAGNOSE` |
| `integration` | `UNDERSTAND` |
| `data_flow` | `TRACE` |
| `control_flow` | `TRACE` |
| `performance` | `AUDIT` |
| `regression` | `DIAGNOSE` |
| `dead_code` | `AUDIT` |
| `compare` | `REVIEW` |
| `general_review` | `REVIEW` |

Target paths become exact `scope.paths` seeds. Traversal, absolute paths,
Windows drive paths, backslash paths, empty segments, and glob-like targets are
rejected before CORE scope planning rather than being reinterpreted.

Caller-known observations, constraints, and exclusions are appended to the
CORE question under explicit caller-context labels. The Mailbox
`Required output` section is not copied into the analysis question because it
describes consumer rendering rather than repository evidence.

`max_output_tokens` remains a soft Mailbox result-compression target. It is
returned as `plan.output_target.max_output_tokens` and is intentionally not
converted into a CORE analysis/correctness budget.

The plan also returns `service_result_options`, preserving the exact job id,
source ref, source commit, source repository, and original Mailbox analysis mode
for `toJollyResearchMailboxServiceResult()`.

## 10. Project into the KNEEKURA Mailbox service contract

For a `service: kneekura-code-lab` job, use the conservative service
projection:

~~~js
import {
  toJollyResearchMailboxServiceResult
} from 'kneekura-code-lab/mailbox';

const serviceResult = toJollyResearchMailboxServiceResult(result, {
  jobId: 'JOB-...',
  sourceRepository: 'owner/repository',
  sourceRef: 'main',
  sourceCommit: 'FULL_COMMIT_SHA',
  analysisMode: 'bug_hunt'
});
~~~

The projection schema is:

~~~text
jolly.research-mailbox-service-result/v1
~~~

The projection is deliberately stricter than a prose renderer.

- `sourceCommit` must be a full SHA and must match
  `AnalysisResult.snapshot.base_commit` when that field exists.
- For GitHub-backed RepositoryIdentity, `sourceRepository` is validated
  against the canonical remote and emitted in normalized `owner/repository`
  form rather than echoing caller whitespace or a trailing `.git`.
- Only a `COMMIT` AnalysisResult snapshot can project to
  `completed` or `partial`. WORKSPACE/MULTI_REPO/ARCHIVE results project to
  `needs_context` because `source_commit` alone does not prove the exact
  analyzed bytes required by the mailbox service contract.
- A canonical `COMPLETE` run is not automatically a completed mailbox job:
  when no verified Claim exists, projection remains `partial`.
- `bug_hunt` remains `partial` until CORE has an explicit canonical
  root-cause contract. The current adapter will not relabel an arbitrary
  verified Claim as a causal root cause.
- Evidence file/symbol/line fields are emitted only when canonical Evidence
  provenance/observation contains them. Missing inline Evidence is surfaced as
  uncertainty instead of fabricated location data.
- Canonical CORE warnings are preserved in `remaining_uncertainty` and
  therefore prevent an otherwise warning-bearing result from receiving
  unqualified high aggregate confidence.
- Rejected hypotheses come from canonical negated/rejected Claim state.
- `verification_plan` is copied from canonical
  `recommended_validation`.
- An external-research request is surfaced only when CORE explicitly emits the
  `EXTERNAL_RESEARCH_REQUIRED` reason code.

CORE v1 does **not** have canonical fields that authorize arbitrary source
changes or assign a generic Claim the semantic role of “root cause”.
Therefore this projection intentionally returns:

- `root_cause.established = false` unless a future version adds an explicit
  verified causal contract;
- an empty `recommended_changes` list;
- an empty `do_not_change` list.

A host may produce human/agent wording around these fields, but it must not
promote that wording into canonical CORE authority.

## 11. Render the service RESULT.md

After creating the conservative service projection, render the Mailbox artifact
with the stable renderer:

~~~js
import {
  renderJollyResearchMailboxServiceResultMarkdown
} from 'kneekura-code-lab/mailbox';

const markdown =
  renderJollyResearchMailboxServiceResultMarkdown(
    serviceResult
  );
~~~

The renderer validates
`jolly.research-mailbox-service-result/v1`, emits the standard KNEEKURA
Mailbox RESULT.md sections in a fixed order, and does not mutate the service
result. The artifact also carries `source_snapshot_id`,
`source_snapshot_kind`, and the canonical CORE provenance block so a host can
reconcile the rendered result with the persisted service projection.

Repository-derived Evidence, rejected hypotheses, uncertainty, and other
structured dynamic values are serialized inside deterministic JSON data blocks.
They are data, not instruction authority. The renderer never invents a missing
file, symbol, line range, root cause, recommended source change, or
`do_not_change` conclusion.

Empty authority-bearing fields stay explicit. For example, an empty
`recommended_changes` array renders as a statement that canonical CORE did
not establish a source change rather than synthesizing one in prose.

## 12. Run the complete Mailbox pipeline

Hosts that already own a CORE engine can use the pure orchestration helper:

~~~js
import {
  runJollyResearchMailboxRequest
} from 'kneekura-code-lab/mailbox';

const output =
  await runJollyResearchMailboxRequest(
    requestMarkdown,
    {
      repository: localRepositoryRoot,
      core
    }
  );

await persistResult(
  output.result_markdown
);
~~~

The helper performs only this sequence:

~~~text
REQUEST.md
  -> strict Mailbox request parse
  -> commit-pinned CORE execution plan
  -> core.analyze()
  -> conservative Mailbox service projection
  -> deterministic RESULT.md rendering
~~~

It does not create a CORE engine, discover a repository, write RESULT.md, mutate
Mailbox state, or change the target repository. The host retains lifecycle,
storage, scheduling, and side-effect ownership.

`analyzeOptions` may be supplied and are forwarded unchanged to
`core.analyze()`. The soft Mailbox `max_output_tokens` target remains in the
returned execution plan and is not used to truncate canonical analysis or the
deterministic renderer.

If CORE analysis throws before a canonical `core.analysis-result/v1` exists,
the helper propagates that failure. It does not fabricate a service result,
`needs_context` artifact, Evidence, root cause, or successful RESULT.md around
a failed analysis. The host may record the operational failure separately.

The returned object contains:

- `job`: parsed Mailbox request data.
- `execution_plan`: the exact CORE request and service projection metadata.
- `analysis_result`: canonical CORE result.
- `service_result`: conservative KNEEKURA Mailbox service projection.
- `result_markdown`: deterministic RESULT.md text.

## 13. Failure handling

Never flatten these states:

- PARTIAL
- UNKNOWN
- UNEXPLORED
- FAILED
- UNOBSERVED
- ABSENT

A strong absence conclusion is valid only when the negative gate verifies it.
