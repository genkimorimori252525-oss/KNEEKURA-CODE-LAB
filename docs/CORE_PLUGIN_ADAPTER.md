# CORE Plugin Adapter v1

Status: published after AT-01..AT-12 acceptance.

Entry point:

~~~js
import {
  createCoreEngine,
  createCorePluginAdapter
} from './src/plugin.mjs';
~~~

## Contract

The adapter schema is:

~~~text
core.plugin-adapter/v1
~~~

`describe()` returns:

~~~text
core.plugin-manifest/v1
~~~

The manifest pins:

- request schema: `core.analysis-request/v1`
- result schema: `core.analysis-result/v1`
- target repository access: read-only
- provider credential ownership: false
- capabilities:
  - `core.analyze`
  - `core.expand`
  - `core.get`
  - `core.session.resume`

## Deliberately small surface

The plugin adapter delegates only to an already configured CORE engine.

It does not expose:

- provider internals
- Evidence Ledger mutation
- verifier mutation
- cache filesystem internals
- repository-write operations
- shell execution
- provider/API credentials

The host owns any model/provider integration and injects a ReasoningBridge when
constructing the CORE engine.

## Method mapping

~~~text
plugin.analyze(request)
  -> engine.analyze(request)
  -> core.analysis-result/v1

plugin.expand(analysis_id, target, budget?)
  -> engine.expand(...)

plugin.get(ref)
  -> engine.get(ref)

plugin.session.resume(session_id, target_snapshot?)
  -> engine.session.resume(...)
~~~

Inputs are cloned before delegation where relevant and returned objects are
cloned before leaving the adapter.

## Trust boundary

The adapter does not weaken CORE authority.

In particular it cannot:

- make host proposals OBSERVED
- set Claim verification status
- manufacture negative-search authority
- reinterpret M5 as M6
- reinterpret send as receive
- bypass SnapshotIdentity
- bypass Coverage
- write into the target repository

## Context reuse

A ReasoningBridge may optionally implement `knownEvidenceIds()`.

If the host confirms that immutable stable Evidence IDs are already present in
its own context cache, CORE may transmit ref-only reuse markers instead of the
full EvidenceRecord again.

Evidence that the host does not explicitly acknowledge remains transmitted as
the canonical full record.

This optimization does not change Evidence IDs, Claims, verification, or
Coverage and is covered by AT-08.
