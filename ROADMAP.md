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
- [x] Mixin `@Inject/@Redirect/@Modify*` target extraction (multiline annotation / nested `@At` / ordinal / shift aware)
- [ ] Forge registry object names and IDs
- [ ] networking messages/channels
- [ ] capability attachment/use
- [x] resource/model/animation dependency graph (`ysm.json` resources + animation definitions + geometry models/bones)
- [ ] access transformer / coremod edges

## v0.4 — YSM/TLM inspection
- [x] YSM model + animation resource graph (model definitions / bone hierarchy / locators / animation bone channels)
- [x] Molang variable producer/consumer graph
- [x] TLM ↔ YSM compatibility boundary graph + workspace Viewer filter
- [ ] runtime trace overlay from KNEEKURA-LAB
- [ ] fidelity/capability matrix

## v0.5 — Understand Anything style UX
- [x] Understand Anything graph importer (nodes/edges/layers/tour)
- [ ] architecture layers
- [ ] guided tours
- [ ] change impact view
- [ ] ask-graph adapter for AI agents
- [ ] confidence/evidence inspector
