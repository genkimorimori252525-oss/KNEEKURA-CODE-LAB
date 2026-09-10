# KNEEKURA Code LAB Skill v1 — Frozen Implementation Contract

Status: **FROZEN FOR IMPLEMENTATION**
Date: 2026-09-09 JST
Audit source: `genkimorimori252525-oss/KNEEKURA-Agent-Skills@b7ebe25c916d5132efde207f06a78eb09e1f0e93`
Production authority: **this repository, `genkimorimori252525-oss/KNEEKURA-CODE-LAB`**.

The v1 product exposes one discoverable Skill and exactly three engines: first-party `kneekura`, pinned upstream `understand-anything`, and pinned upstream `archify`. Explicit engine requests route directly; `all` runs all requested engines independently; an unqualified product request requires a choice. The router is not an analyzer and engine substitution is forbidden.

Every run binds to the existing CORE RepositoryIdentity/SnapshotIdentity authority. Exact commit analysis must prove complete commit/tree/blob identity, disable Git replacement objects and lazy fetch, verify object integrity, reject incomplete provider inventories, and materialize engine-private Analysis Views without executing target code. LFS pointers, gitlinks, secrets, unsafe/control paths, unsupported special files and policy-excluded binary/oversize content remain typed coverage rather than ordinary semantic input.

The privileged control plane is target-content blind. Target README/source/comments/config/filenames and engine free-text are untrusted data and cannot grant tool authority or drive privileged state transitions. Target-reading parser/semantic workers operate under filesystem/process/resource/capability boundaries. External UA/Archify execution fails closed as `BLOCKED_UNSAFE_HOST` when the required host isolation cannot be technically enforced.

Each engine receipt independently records implementation origin, exact implementation identity, orchestration mode, snapshot/scope/attempt identity, status, claim level, claim satisfaction, acceptance gates, coverage, warnings/errors and artifact digests. Native means the requested engine's own frozen acceptance profile actually ran; compatible/portable/fallback results cannot masquerade as native.

ALL mode uses the same canonical snapshot but fresh private engine views/attempts and, where the host supports it, fresh semantic contexts. Cross-engine agreement is descriptive only and never elevates an interpretation to KNEEKURA canonical fact. Comparison begins only after engine sealing and has no mutation/tool authority.

Accepted artifacts are copied into a fresh sealing root, hashed, manifested and then packaged from an allowlisted delivery staging directory. The ZIP never contains target source, raw prompts, dependency caches, secrets or unrestricted logs. Packaging is deterministic for identical staged bytes, bounded, path-safe and atomically published only after integrity verification.

Upstream updates are a separate quarantined workflow. Candidate upstream source is untrusted until tested; candidate inspection has no repin/release/GitHub-write authority. A maintainer control plane can repin only after fixed candidate identity, license/notices, regression receipts and explicit acceptance. Failed candidates leave the current lock unchanged and previous pins remain rollback targets.

Implementation proceeds in gates I0-I7: umbrella contract/pins; canonical snapshot hardening; host/worker sandbox; first-party KNEEKURA integration; Archify integration; Understand Anything integration; ALL/comparison/bundle; update/rollback/release acceptance. Any implementation change that weakens these hard boundaries requires a new design amendment and renewed two-pass adversarial convergence before release.

The design audit converged only after two consecutive fresh full-design passes (`R28`, `R29`) reported zero new Critical/High findings. Residual Medium/Low risks remain explicit: host sandbox capability variance, semantic LLM nondeterminism, trusted-computing-base vulnerabilities in Git/Node/browser/parsers, UA viewer acceptance being separate from graph acceptance, trigger wording precision, and cache-leasing details.