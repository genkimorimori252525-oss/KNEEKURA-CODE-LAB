# Roadmap

## v0.1 — foundation
- [x] Common Graph IR
- [x] Forge-aware lexical scanner
- [x] mods.toml dependency graph
- [x] Mixin / EventBus / Registry semantics
- [x] dependency-free interactive viewer
- [x] CodeGraph adapter boundary
- [x] KNEEKURA-LAB runtime trace boundary

## v0.2 — precise Java graph
- [ ] CodeGraph MCP/export importer
- [ ] symbol range + caller/callee merge
- [ ] duplicate symbol resolution
- [ ] source jump links
- [ ] incremental cache

## v0.3 — Minecraft deep semantics
- [x] Primary platform profile: Minecraft 1.20.1 + Forge 47.x + Java 17
- [x] Mixin `@Inject/@Redirect/@Modify*` target extraction (multiline annotation / nested `@At` / ordinal / shift aware)
- [ ] Forge registry object names and IDs
- [x] Forge 1.20.1 networking messages/channels (SimpleChannel, registerMessage/messageBuilder, direction, send sites, enqueueWork/bootstrap)
- [x] runtime network evidence overlay (run-gated send/receive companions + N0-N2 delivery matrix)
- [x] packet-carried Molang payload evidence (safe scalar payload → payload fingerprint → shared Molang variable; semantic field guard)
- [x] M0-M5 Molang transport evidence (intent → send → receive → handler → dispatch → Forge client command consumption/fallback)
- [ ] capability attachment/use
- [x] resource/model/animation dependency graph (`ysm.json` resources + animation definitions + geometry models/bones)
- [ ] access transformer / coremod edges

## v0.4 — YSM/TLM inspection
- [x] YSM model + animation resource graph (model definitions / bone hierarchy / locators / animation bone channels)
- [x] Molang variable producer/consumer graph
- [x] TLM ↔ YSM compatibility boundary graph + workspace Viewer filter
- [x] runtime trace overlay from KNEEKURA-LAB (meta/spawn/gone/anim/Molang/end + UUID-gated pose + per-bone palette TRS evidence)
- [x] fidelity/capability matrix (C0-C5 evidence stages; C5 backed by SimPaletteTrace TRS; observed != pass, unobserved != fail)

## v0.5 — Understand Anything style UX
- [x] Human Presentation v2 P0 contract / safety boundary
- [x] Human Presentation v2 P1 Explorer Projection (one-to-one canonical traceability)
- [x] Human Presentation v2 P2 Explorer Shell (opt-in React Flow + deterministic ELK layout)
- [x] Understand Anything graph importer (nodes/edges/layers/tour)
- [x] Human Presentation v2 P3 architecture layers / containers / drill-down
- [x] Human Presentation v2 P4 KNEEKURA semantic visualization
- [ ] guided tours
- [ ] change impact view
- [ ] ask-graph adapter for AI agents
- [ ] confidence/evidence inspector
