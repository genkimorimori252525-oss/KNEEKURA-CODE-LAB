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

## 9. Failure handling

Never flatten these states:

- PARTIAL
- UNKNOWN
- UNEXPLORED
- FAILED
- UNOBSERVED
- ABSENT

A strong absence conclusion is valid only when the negative gate verifies it.
