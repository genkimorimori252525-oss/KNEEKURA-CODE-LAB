# Forge 1.20.1 primary profile

KNEEKURA-CODE-LAB の第一級解析対象は次。

- Minecraft: 1.20.1
- Loader: Forge
- Forge family: 47.x
- Java: 17
- profile key: `forge-1.20.1-47.x`

## Detection sources

profile は単一ファイルだけで決めない。

優先度の高い exact evidence:

- `gradle.properties`
  - `mc_version`
  - `minecraft_version`
  - `forge_version=1.20.1-47.2.0` のような座標
- `build.gradle(.kts)`
  - `net.minecraftforge:forge:...`
  - Java toolchain
  - mappings
- `mods.toml`
  - `modLoader="javafml"`
  - loader range
  - forge dependency range
  - minecraft dependency range

exact version と broad versionRange が両方ある場合、exact build metadata を採用し、
range は補助 evidence として保持する。

## Compatibility statuses

### PRIMARY_EXACT

```text
loader = forge
minecraft = 1.20.1
forge major = 47
```

Forge-specific semantic analyzer が最も強く意味付けする対象。

### PRIMARY_MC_MATCH

Minecraft は 1.20.1 だが exact Forge major が取得できない。

1.20.1向けparserを使うが、Forge build 固有の断定は弱める。

### FORGE_1_20_BEST_EFFORT

Forge + Minecraft 1.20.x だが 1.20.1 exact ではない。

### FORGE_BEST_EFFORT

Forge は検出したが、Minecraft version が primary target と一致しない。

### UNRECOGNIZED_BEST_EFFORT

loader/profileを十分に確定できない。

## Graph

`platform_profile` と `platform_target` を生成する。

```text
gradle.properties
build.gradle
mods.toml
      |
      v
platform_profile
      |
      +-- MATCHES_PRIMARY_PLATFORM --> forge-1.20.1-47.x
      |
      or
      +-- ANALYZED_AGAINST_PRIMARY_PLATFORM --> forge-1.20.1-47.x
```

各 Forge-specific network node は `profileCompatibility` を持つ。

## Non-goal

1.21.x を 1.20.1 として扱うことはしない。
parser が偶然読めたとしても、`PRIMARY_EXACT` とは表示しない。
