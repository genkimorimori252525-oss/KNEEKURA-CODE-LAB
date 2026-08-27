# CORE Evidence Ledger and Verification v1

Status: Milestone D compatibility contract.

## Boundary

Milestone D adds the machine-verifiable conclusion layer on top of Milestones A-C:

- immutable Evidence Ledger storage
- ClaimRecord construction rules
- ClaimEvidenceLink support and counterevidence links
- deterministic safe derivations
- nine-stage verifier pipeline
- code-enforced NEGATIVE claim gate
- machine VerificationRecord output
- runtime Claim reconstruction for existing KNEEKURA network/YSM observations

It does not add sessions, cache tiers, exploration reuse, ReasoningBridge, public `core.analyze`, AI rendering, Human Viewer migration, or plugin contracts. Those remain Milestones E-H.

`kneekura.graph/v1` is not reinterpreted by this milestone.

## Evidence Ledger

The Ledger schema is `core.evidence-ledger/v1`.

EvidenceRecords remain canonical `core.evidence/v1` records produced by the provider layer. The Ledger stores deep-frozen copies and never mutates the source evidence.

Identical observations are deduplicated by canonical observation/provenance/provider identity. Runtime evidence from a different run, artifact, snapshot, or provider provenance remains a distinct record.

A finalized Ledger contains:

- repository and snapshot identities
- Coverage Manifest reference
- EvidenceRecords
- ClaimRecords
- flattened ClaimEvidenceLinks
- VerificationRecords
- deterministic Ledger fingerprint

Verified conclusions can be reconstructed from the Ledger without renderer prose.

## Claim lifecycle

Claims remain `core.claim/v1`.

Supported types:

- OBSERVED
- DERIVED
- INFERRED
- HYPOTHESIS
- NEGATIVE
- UNKNOWN

Ingress rules are enforced in code:

- OBSERVED requires DIRECT SUPPORT evidence and begins PROPOSED
- DERIVED requires a versioned derivation rule plus dependency claims and begins PROPOSED
- INFERRED begins PROPOSED
- HYPOTHESIS begins PROPOSED and cannot become a verified factual conclusion merely by running the verifier
- NEGATIVE begins PROPOSED and can become VERIFIED only through the negative gate
- UNKNOWN begins UNRESOLVED and requires an unresolved reason

The Ledger rejects a host-supplied claim that attempts to enter already VERIFIED or REJECTED. Machine verification is the only supported transition into those terminal states.

Claim IDs identify the semantic proposition. Evidence ordering, evidence expansion, Coverage references, renderer output, and verifier state do not change the Claim ID. DERIVED Claim identity also includes deterministic derivation lineage (dependency Claim IDs and rule/version).

## Safe deterministic derivations

The first registered safe rule is:

`core.derive.ysm-client-command-consumed/v1`

A verified `ysm.client_command_handled=true` observation may derive:

`ysm.client_command_consumed=true`

This corresponds to the existing M5 meaning: Forge consumed the client command.

The inverse or next-stage leap is forbidden:

`M5 consumed != M6 YSM runtime state applied`

No deterministic derivation may create M6 from M5. Formal M6 requires explicit measured `OBSERVED_YSM_MOLANG_STATE_APPLIED` evidence with the existing controlled-E2 exact-variable qualification.

## Runtime separation invariants

### Network

`OBSERVED_PACKET_SEND != OBSERVED_PACKET_RECEIVE`

A send observation cannot establish receipt. A receive Claim requires an actual `OBSERVED_PACKET_RECEIVE` graph fact and matching canonical runtime evidence.

### YSM Molang

The existing runtime stages remain:

- M0 runtime Molang intent
- M1 packet send carries Molang
- M2 packet receive carries Molang
- M3 client handler executed
- M4 YSM command dispatched
- M5 Forge client command consumed
- M6 YSM Molang runtime state applied

M5 is not M6.

`OBSERVED_YSM_STATE_CORRELATED` is counter/supporting context only and cannot be promoted into formal M6.

A formal M6 graph fact must carry:

- `controlledE2Qualified=true`
- `exactVariableIdentity=true`
- `evidenceLevel=E2_ACTUAL_PRE_POST_TRANSITION`

## Verifier pipeline

Every verification pass emits one machine `core.verification/v1` VerificationRecord for each stage:

1. Snapshot Verifier
2. Anchor Verifier
3. Path Verifier
4. Evidence-role Verifier
5. Counterexample Verifier
6. Runtime/static Verifier
7. Coverage Verifier
8. Negative Verifier
9. Staleness Verifier

Possible aggregate outcomes:

- VERIFIED
- VERIFIED_WITH_LIMITS
- REJECTED
- UNRESOLVED

A failing deterministic verifier is not hidden by prose or confidence scoring.

## NEGATIVE claim gate

Strong absence claims are code-gated.

A NEGATIVE claim can be VERIFIED only when all of the following hold:

1. the searched property is supported by an active provider
2. the search universe is explicit
3. the search universe is enumerable
4. every relevant universe item exists in Coverage
5. every relevant item is ANALYZED, REUSED, or deterministically proven irrelevant
6. no relevant item is FAILED, UNEXPLORED, or PENDING
7. evidence and Coverage belong to the accepted current snapshot
8. there is no linked counterevidence
9. CORE has a deterministic positive-property detector for that provider/property
10. no positive matching graph fact is found

If any requirement fails, the gate returns UNKNOWN/UNRESOLVED rather than converting “not found in explored scope” into “does not exist”.

Provider/analyzer failure is never evidence of absence.

## Counterevidence

Support and counterevidence are retained together.

- direct contradiction -> REJECTED
- indirect/correlated contradiction -> VERIFIED_WITH_LIMITS when other verification passes
- no contradiction -> normal verifier outcome
- unresolved verifier dependencies -> UNRESOLVED

Verification does not delete supporting evidence when a claim is rejected.

## Existing provider integration

Runtime Claim import consumes existing canonical provider EvidenceRecords and graph facts. It does not rewrite the provider layer.

Current measured predicates include packet send/receive and existing YSM runtime semantic stages. The importer only creates an OBSERVED Claim when a canonical runtime EvidenceRecord contains the corresponding graph-delta fact.

## Security and trust

Repository text remains evidence, not executable instruction.

This milestone does not execute repository-authored prompts or grant repository text authority over verifier policy.

Target repositories remain read-only.

## Milestone D acceptance

Milestone D is considered implementation-complete only when regressions demonstrate:

- identical EvidenceRecords deduplicate
- distinct runtime runs/artifacts remain distinct
- unsupported host proposals can be rejected deterministically
- M5 can safely derive command-consumed
- M5 never derives M6
- weak state correlation never becomes M6
- formal qualified M6 verifies
- send never fabricates receive
- strong NEGATIVE is impossible without the gate
- incomplete, unsupported, failed, stale, or counterevidenced negative analysis cannot verify absence
- support/counterevidence survive verification
- final conclusions reconstruct from the Ledger without renderer prose
- all pre-existing scan/workspace/runtime/pose/network/palette regressions remain green
