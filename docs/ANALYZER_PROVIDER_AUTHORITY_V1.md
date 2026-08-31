# Analyzer Provider / Capability / Evidence Authority v1

Status: **frozen normative contract** for the next KNEEKURA-CODE-LAB analyzer fabric.

Machine-readable contract: `config/analyzer-provider-authority.v1.json`.

This contract governs the boundary between external/builtin analyzers and the existing KNEEKURA Evidence Plane. It is intentionally additive: **`src/core/**` canonical semantics are not redefined here.**

## 1. Core rule: providers observe; CORE decides

An analyzer provider never becomes truth merely because it has higher priority, a newer timestamp, or a stronger marketing claim.

The flow is:

```text
provider
  -> Analyzer Observation
  -> Evidence-preserving Fusion
  -> existing KNEEKURA Evidence / Claim verification
  -> canonical result
```

The following are forbidden:

- provider-priority-wins;
- last-writer-wins;
- direct provider writes that silently overwrite canonical graph meaning;
- AI-majority-vote promotion;
- treating missing provider output as negative evidence.

A SCIP/compiler result can be much stronger than a syntax match, but it is still an observation with provenance. Canonical promotion belongs to the existing KNEEKURA verification boundary.

### 1.1 Legacy CORE compatibility bridge

The repository already has v1 provider wrappers in `src/core/evidence/provider.mjs` and `providers.mjs`. Those wrappers predate the new Fabric contract and intentionally call existing analyzers that can mutate the current `GraphBuilder`. Their `ProviderFailure` and dependency-fingerprint shapes are also existing CORE compatibility surfaces.

Step-009 does **not** rewrite those semantics. They are a narrowly scoped migration exception:

- existing CORE v1 wrappers may continue their current builder mutation while they preserve the frozen v1 behavior;
- new Analyzer Provider Fabric providers must not copy that direct-write pattern;
- legacy ProviderFailure/fingerprint shapes enter the Fabric only through an explicit adapter;
- wrapping legacy output must preserve its existing meaning rather than reinterpret it as stronger Evidence;
- this exception is not a provider-authority precedent and must not become a shortcut around Observation/Fusion.

In short: **legacy CORE is bridged; new Fabric is clean.** `src/core/**` semantics remain unchanged by step-009.

## 2. Capability taxonomy

Language support is not a boolean checkbox. Coverage is recorded per scope and capability:

- `SYNTAX`
- `DECLARATION`
- `SYMBOL`
- `REFERENCE`
- `CROSS_FILE_REFERENCE`
- `CALL`
- `TYPE`
- `INHERITANCE`
- `CONFIG`
- `BUILD`
- `EMBEDDED_LANGUAGE`
- `FRAMEWORK`
- `RUNTIME`
- `AI_SEMANTIC`

Capability support and execution coverage are separate axes.

Support states describe whether a provider can supply a capability for the scope:

```text
AVAILABLE
PARTIAL
NONE
```

Execution states describe what the current analysis actually accomplished:

```text
ANALYZED
PARTIAL
FAILED
UNEXPLORED
SKIPPED
```

`AVAILABLE` therefore never means "this repository was analyzed completely". A provider can support TypeScript calls while the current run still has `UNEXPLORED` files. Provider failure becomes a visible Coverage Gap instead of disappearing behind a repository-level "supported" flag.

## 3. Provider manifest

Every provider must declare at least:

```text
id
version
supported_languages
capabilities
capability_contracts
origin
authority_level
required_tools
toolchain_fingerprint
source_range_support
semantic_identity_support
timeout_ms
resource_limits
cacheability
provenance
```

Origins are separated so downstream logic can preserve what kind of evidence was produced:

```text
BUILTIN_DETERMINISTIC
EXTERNAL_DETERMINISTIC
IMPORTED_ARTIFACT
RUNTIME
STRUCTURAL_RULE
AI
```

Each declared capability also has a capability contract with its own `authority_level` and `support_status`. The provider-level authority is only a default. A provider that is resolved-semantic for `REFERENCE` but structural for `FRAMEWORK` must say so; one strong capability cannot silently upgrade the others.

Imported tools are not trusted merely because they are external OSS. Their version, provenance, mapping semantics, and source trace must remain explicit.

### 3.1 Provider registry

The registry is a catalog and execution/fallback policy surface, **not a truth ranking**.

Each registry entry records at least:

```text
provider_id
manifest_ref
enabled
execution_preference
fallback_policy
```

Multiple providers may cover the same capability. `execution_preference` may decide scheduling, cost-aware selection, or fallback order, but it may never decide which conflicting observation becomes true. Evidence from providers that actually ran is preserved, and a disabled/unavailable provider must leave a Coverage reason rather than disappearing.

### 3.2 Authority levels

Origins and authority levels are distinct. Origin says *where* an observation came from; authority level says *what kind of claim the provider is allowed to make*.

Frozen authority levels:

```text
SYNTAX_ONLY
STRUCTURAL_EVIDENCE
RESOLVED_SEMANTIC_EVIDENCE
RUNTIME_OBSERVED_EVIDENCE
IMPORTED_MAPPED_EVIDENCE
AI_INTERPRETATION_ONLY
```

Authority levels have no truth ordering and are not comparable as "winner" ranks.

No authority level directly canonicalizes a fact. Even `RESOLVED_SEMANTIC_EVIDENCE` must pass through the existing KNEEKURA CORE verification boundary.

## 4. Analyzer Observation IR boundary

Providers emit `kneekura.analyzer-observation/v1`-shaped observations before any fusion.

Required conceptual fields:

```text
provider_id
provider_version
snapshot
capability
observation_type
subject
strength
origin
provenance
```

Optional but important fields include source file/range, object, raw provider reference, and provider-specific payload.

Common normalization must **not throw away provider-specific detail**. The contract is Common Envelope + provider payload/ref.

Observation strengths are:

- `EXACT`
- `RESOLVED`
- `STRUCTURAL`
- `HEURISTIC`
- `RUNTIME_OBSERVED`

These labels describe how an observation was obtained; they are not a truth-priority ordering. An `EXACT` observation does not erase conflicting Evidence merely because of the label.

Unknown source coordinates are omitted. Zero is not used as an "unknown" sentinel.

## 5. Authority boundaries

### SCIP / compiler semantic index

SCIP or equivalent compiler-backed semantic indexes may provide resolved symbols, references, cross-file references, calls, types, and inheritance. They may emit `EXACT` or `RESOLVED` observations.

They do **not** directly canonicalize KNEEKURA facts.

### Tree-sitter

Tree-sitter is syntax authority only.

It may establish syntax/declaration structure and source ranges. It may say that a call expression with callee text `client.send` exists.

It must **not** claim that the target is `PowerService.send` across files without a semantic resolver.

### Structural / ast-grep-style rules

Structural rules are useful for framework/config evidence such as annotations, route declarations, registration patterns, or lifecycle hooks.

Their authority remains `STRUCTURAL` or `HEURISTIC`. A structural match does not become cross-file semantic identity.

### Runtime providers

Runtime evidence may record what was actually observed, but observed send does not imply receive, and unobserved runtime state is not absence.

Static and runtime semantics remain distinct.

### AI

AI is a first-class semantic author for human explanation, but not a canonical fact authority.

AI output remains `AI_INTERPRETATION` unless it is merely presenting a separately verified canonical fact. AI confidence or reviewer agreement cannot promote a fact.

## 6. Fusion rules

Fusion is evidence-preserving, not winner-selecting.

When two providers disagree:

```text
Observation A
Observation B
Counter/Correlated Evidence C
        |
        v
Fusion Resolver
        |
        v
Evidence set with conflict retained
```

The resolver preserves conflict/counterevidence and allows existing CORE verification to decide what can actually be promoted.

Absence of an observation is not negative evidence unless an analyzer has an explicit bounded negative-search contract and Coverage sufficient for that claim.

A bounded negative claim requires all of: a declared negative-search capability, an explicit scope, an `ANALYZED` execution state for the relevant capability, complete relevant-scope coverage, and provenance. Syntax/structural silence alone cannot prove a cross-file semantic absence.

## 7. Symbol identity: fail conservative

Names are not identities.

These must not be merged merely because the display name is `foo`:

```text
foo()
foo(int)
foo(String)
other.package.foo()
generated foo()
```

Merge only when semantic identity is exact, or repository snapshot + language + signature + range establish the same entity.

Identity candidates retain the strongest available inputs instead of collapsing to a display name: semantic symbol ID, language, repository ID, snapshot ID, file path/range, signature, and provider namespace.

If identity is ambiguous:

```text
KEEP_SEPARATE
  +
record correlation candidate
```

False-positive merging is considered more damaging than a temporary false-negative split.

## 8. SourceRange identity

A source reference is scoped by repository identity, snapshot identity, and repository-relative path. Provider-native line/column systems are **not** assumed compatible.

For exact cross-provider range identity, the preferred normalized form is:

```text
content_digest
start_byte   # 0-based UTF-8 byte offset, inclusive
end_byte     # 0-based UTF-8 byte offset, exclusive
```

Exact range fusion requires the same content digest and the same half-open byte interval. This avoids UTF-16/code-point/UTF-8 column disagreements and line-base differences across SCIP, Tree-sitter, compilers, and imported analyzers.

Line projection remains compatible with existing CORE v1:

- lines are projected as 1-based values when known;
- columns remain optional;
- a column is not exact identity unless its unit and base were declared;
- provider-native coordinates are retained when conversion is not lossless;
- ambiguous normalization cannot be used for exact symbol fusion.

Coordinates are optional because some imported/runtime observations do not know an exact source location. Unknown location is represented by absence, never fabricated line 0/column 0.

## 9. Provider execution sandbox

External analyzers run as untrusted processes.

Minimum contract:

- isolated workspace;
- no credentials exposed to provider processes;
- timeout;
- CPU budget;
- memory budget;
- stdout/stderr capture;
- process-tree termination on timeout;
- network denied by default unless explicitly declared and allowed;
- one provider failure does not abort evidence safely acquired by other providers.

A provider crash/hang becomes a typed failure plus Coverage Gap.

The fabric failure contract distinguishes unsupported/unavailable analyzers, parse failure, runtime identity mismatch, trust-boundary violation, internal invariant failure, timeout, resource-limit exhaustion, and toolchain mismatch. A failure never erases Evidence acquired by another provider. Fabric-only failure types must be explicitly mapped before ingestion into an existing CORE failure surface.

## 10. Cache and version pinning

Deterministic provider cache identity includes:

```text
repository snapshot
+ provider id
+ provider version
+ provider config digest
+ toolchain fingerprint
```

AI semantic cache identity includes:

```text
evidence digest
+ agent/prompt version
+ model/provider configuration
```

Stale cache is never silently treated as canonical evidence for a new snapshot.

Canonical runs record exact provider versions, configuration digests, and toolchain fingerprints. A version string alone is insufficient when a different executable could hide behind it. Floating `latest` is not an acceptable canonical run identity.

## 11. OSS reuse policy

Preferred order:

```text
1. REUSE_EXISTING_CLI_API_INDEXER
2. ADAPTER_STABLE_EXPORT
3. KNEEKURA_NATIVE_IMPLEMENTATION
4. PINNED_VENDOR_LAST_RESORT
```

Wholesale merging/forking of Understand Anything, Archify, SCIP implementations, Tree-sitter ecosystems, or other large OSS projects is not the default.

Vendoring is a last resort and requires a pinned version/commit, license provenance, local change record, and security review.

## 12. Non-regression boundary

This contract must not weaken existing KNEEKURA distinctions:

- UNKNOWN is not ABSENT;
- UNEXPLORED is not ABSENT;
- FAILED is not ABSENT;
- runtime observation is not static definition;
- packet send is not packet receive;
- structural syntax is not resolved semantics;
- AI interpretation is not canonical fact.

The next implementation step may build Repository Profiler + Observation/Fusion infrastructure **against this contract**, but must not reinterpret the frozen CORE v1 schema to make provider integration easier.
