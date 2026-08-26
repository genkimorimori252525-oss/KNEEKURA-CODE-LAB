# Architecture

## Common Graph IR

`kneekura.graph/v1` は Viewer と解析器の唯一の共有契約です。

Node:
- `id`: 安定ID
- `kind`: `file`, `class`, `method`, `mod`, `registry`, `resource` など
- `key`: 一意な意味キー
- `label`: 表示名
- その他は拡張可能

Edge:
- `from`, `to`
- `type`
- `confidence`: 0..1
- `evidence`: 根拠となるソース断片
- `source`: ファイル/adapter

## Static vs Runtime

静的解析で「存在する経路」と、KNEEKURA-LAB trace で「実際に通った経路」を別 edge type として同じ graph に載せます。実測が無いことを失敗と推測しません。

## Minecraft semantic layer

普通の call/import graph では見落とす関係を抽出します。

- `MOD_ENTRYPOINT`
- `MIXES_INTO`
- `SUBSCRIBES_EVENT`
- `CREATES_DEFERRED_REGISTER`
- `ACCESSES_REGISTRY`
- `REFERENCES_RESOURCE`
- `DEPENDS_MOD`
- `OPTIONAL_MOD`
- `INJECTS_AT`
- `DECLARES_NETWORK_CHANNEL`
- `REGISTERS_PACKET`
- `PACKET_DIRECTION`
- `ENCODED_BY / DECODED_BY / HANDLED_BY`
- `ENQUEUES_NETWORK_WORK`
- `DISTRIBUTES_TO / SENDS_PACKET`
- `SCHEDULES_NETWORK_INIT`

将来:
- `USES_CAPABILITY`
- `LOADS_MODEL`
- `LOADS_ANIMATION`
- `YSM_MOLANG_VAR`
- `TLM_AI_PHASE`
- `WARFARE_WINGS_CONTROL_SURFACE`

## Why adapters

CodeGraph は汎用静的解析エンジンとして強い一方、Minecraft/Forge の意味はこのrepoが担当します。Understand Anything のような理解支援UI/LLM説明も IR の consumer として扱い、解析器そのものと密結合させません。

## Primary platform profile

KNEEKURA-CODE-LAB の第一級対象は **Minecraft 1.20.1 + Forge 47.x + Java 17**。\
`gradle.properties` / `build.gradle` / `mods.toml` から実repoのplatformを検出し、`PRIMARY_EXACT` / best-effort を graph metadata と Viewer に明示する。\
他バージョンを1.20.1として捏造せず、profile compatibility を各 Forge-specific node に残す。
