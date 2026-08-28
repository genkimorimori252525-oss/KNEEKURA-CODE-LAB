# KNEEKURA-CODE-LAB

Minecraft / Forge Mod のコードを「普通の Java」ではなく、**Mod として意味づけして可視化する**ための私用研究リポジトリです。

初版は依存ゼロの Node.js 20+ で動きます。**第一級解析対象は Minecraft 1.20.1 + Forge 47.x + Java 17**。解析器/Coreでは CodeGraph や Understand Anything を fork して固定化せず、出力 adapter を優先します。Human Presentation v2 の UI/表示層だけは、固定commit・ライセンス・変更履歴を管理する限定的な vendoring 例外を利用できます。

## できること

- Java / JSON / `mods.toml` を再帰走査
- package / import / class / extends / implements をグラフ化
- Forge / Minecraft 固有の意味を追加
  - `@Mod`
  - `@Mixin`
  - `@Inject` / `@Redirect` / `@Modify*` とネストした `@At`
  - `@SubscribeEvent`
  - `DeferredRegister`
  - `ResourceLocation`
  - Registry 参照
  - optional / required mod dependency
  - `gradle.properties / build.gradle / mods.toml` から platform profile を検出
  - Forge 1.20.1 / 47.x を `PRIMARY_EXACT` として明示
  - `SimpleChannel` / `NetworkRegistry.newSimpleChannel`
  - `registerMessage(...)` と `messageBuilder(...).consumerMainThread(...)`
  - packet encoder / decoder / handler / direction
  - `PacketDistributor` / `sendToServer` の送信site
  - `NetworkEvent.Context.enqueueWork` のmain-thread handoff
  - `FMLCommonSetupEvent.enqueueWork(Network::init)` のnetwork bootstrap
  - KNEEKURA-LAB `.net.jsonl` のruntime send / receiveを静的packet graphへ重ねる
  - `N0 static registration → N1 actual send → N2 actual receive` のdelivery matrix
  - network `payload` のMolang式を `OBSERVED_PACKET_PAYLOAD_MOLANG` として共有 `molang_variable` へ接続
  - `net_semantic` のhandler / YSM command dispatch / failureをruntime evidence化
  - Molang変数ごとに `M0 intent → M1 send → M2 receive → M3 handler → M4 command dispatch → M5 client consumed` を表示
  - payload fingerprintで同じpacket classの異なる式を別runtime observationとして保持
- YSM / TouhouLittleMaid 系の意味を追加
  - `sendSpellCardMolang("...")` の Molang producer
  - YSM animation/controller JSON の Molang consumer
  - `v.`/`variable.`、`q.`/`query.` などの alias 正規化
  - Java 側 animation dispatch と YSM animation definition の対応
  - `ysm.json` の model / animation / texture / sound resource 参照
  - `minecraft:geometry[].bones[]` の model/bone 階層、pivot、cube、locator
  - animation の `bones` と model bone を共有 `bone_name` contract で接続
- KNEEKURA-LAB / SimLab runtime trace を静的 graph に重ねる
  - `meta` / `spawn` / `gone` / `end`
  - `anim.anim` / `anim.pend` を共有 `animation_name` へ接続
  - `anim.molang` / `anim.face` を共有 `molang_variable` へ接続
  - runtime observation に `observationCount` / `firstTick` / `lastTick` / sample evidence を保持
  - `delta="row"` の省略値を「失敗」や「クリア」と捏造しない
  - SimPoseCodec の `.pose.json + .pose.bin` を client render evidence として統合
  - pose v2 UUID を run identity の hard gate とし、別runの頂点を吸着させない
  - `frames / slots / lens / stride` と bin byte size を照合し、float32 LE をサンプル検証
  - SimPaletteTrace の `.pal.json + .pal.bin` を復号し、post-geoRender の bone local TRS を実測 evidence 化
  - `names[slot]` を共有 `bone_name` へ結び、`RightHandLocator` 等の静的boneとruntime transformを同一graphで接続
  - YSM/TLM fidelity matrix を自動生成し、どこまで evidence が到達したかを `observed / unobserved` で表示
- 複数 Mod repository を workspace graph に結合
  - repository-local node は名前空間を分離
  - Molang variable / animation name / bone name は共有 contract node として統合
  - `TLM → Molang/animation → YSM` の cross-repository boundary edge を生成
- 未知の解析器の結果を Common IR にマージ
- Understand Anything の `knowledge-graph.json` をそのまま取り込み
- ブラウザで検索・node kind・edge type・TLM↔YSM boundary・runtime observed をフィルタ
- Static Graph と Runtime Graph を同じ IR 上で区別したまま重ねる

## Primary platform

```text
Minecraft 1.20.1
Forge 47.x
Java 17
profile: forge-1.20.1-47.x
```

実repoのversionが異なる場合は、1.20.1として黙って解析せず Viewer と graph metadata に `PRIMARY_EXACT / PRIMARY_MC_MATCH / FORGE_1_20_BEST_EFFORT / FORGE_BEST_EFFORT` を出します。

## Quick start

```powershell
npm test
node src/cli.mjs scan C:\path\to\mod-repo --out dist/graph.json

# Understand Anything の解析結果も重ねる
node src/cli.mjs scan C:\path\to\mod-repo `
  --understand C:\path\to\mod-repo `
  --out dist/graph.json

# KNEEKURA-LAB / SimLab JSONL trace と client pose companion を静的解析に重ねる
node src/cli.mjs scan C:\path\to\mod-repo `
  --trace C:\path\to\simlab-trace.jsonl `
  --pose C:\path\to\20260827-052000.pose.json `
  --palette C:\path\to\20260827-052000.pal.json `
  --out dist/runtime-overlay.json

node src/cli.mjs serve --graph dist/runtime-overlay.json
```

runtime trace の `anim` チャンネルに現れた animation / Molang は、静的解析が作った同じ `animation_name` / `molang_variable` node に合流します。Viewer の `runtime observed` を有効にすると、実測された経路だけを絞り込めます。

KNEEKURA-LAB の新しい trace は `meta.delta="row"` を持つことがあります。この場合 `anim` 行でフィールドが省略されていても、前の runtime state を保持する契約です。CODE-LAB は省略を新しい観測として数えず、明示的に記録された値だけを evidence にします。

`--pose` を併用すると SimPoseCodec の最終描画頂点、`--palette` を併用すると SimPaletteTrace のボーンごとの合成後ローカル `rotation(rad) / position / scale` を runtime evidence として追加します。pose/palette は同じUUID identity matcherを使います。network companionは `meta.run` と `net_meta.run` をhard gateにし、scenario一致と実測gameTime windowも確認します。server/clientの `.net.jsonl` は `--net` を複数回指定して同時に重ねられ、sendからreceiveを推測して補完しません。packetのpublic scalar `payload` にMolang式がある場合は、意味を示すfield名（`molang` / `expression` / `expr` 系）だけを対象に `v.`/`variable.` aliasを正規化して同じ共有Molang nodeへ実測edgeを張ります。同じpacket classでもpayloadが違えばfingerprintで別観測に分けます。

### TLM + YSM を一枚の graph にする

両 repository をローカルに置いた状態で、名前付き `--repo` を複数指定します。

```powershell
node src/cli.mjs workspace `
  --repo tlm=C:\path\to\TouhouLittleMaid-or-reimu-mod `
  --repo ysm=C:\path\to\ysm-2.6.2-forge-mc1.20.1-releaseKaidoku `
  --out dist\tlm-ysm-workspace.json

node src/cli.mjs serve --graph dist\tlm-ysm-workspace.json
```

ブラウザで `http://127.0.0.1:8789` を開き、`TLM↔YSM boundary` を有効にすると cross-repository contract だけを表示できます。

workspace merge では `file` / `class` / `method` / `model_bone` など repository 固有の node key を `tlm:` / `ysm:` のように名前空間化します。一方、`molang_variable`、`animation_name`、`bone_name` は共有 node にするため、たとえば TLM の `v.wuqi` writer と YSM の `variable.wuqi` reader が同じ node 上で合流します。YSM 内部では、その animation から `RightHandLocator` のような bone contract を経由して実 model bone 定義まで辿れます。

## 設計

```text
repository A ─ scanner ─┐
                        ├─ workspace merge ─ Common Graph IR ─ Viewer
repository B ─ scanner ─┘                      │
                                               ├─ repository-local nodes
                                               │  file / class / model_bone
                                               ├─ shared protocol nodes
                                               │  Molang / animation / bone names
                                               └─ runtime evidence
                                                  entity / observed anim / observed Molang / rendered pose / bone TRS / network send+receive
```

### 重要な原則

1. **事実と推論を分ける**: edge は `confidence` と `evidence` を持つ。
2. **未知を捏造しない**: 解決できない import / target は unresolved node として残す。
3. **Minecraft 固有意味は adapter / semantic 層に置く**: 汎用グラフ IR を個別 Mod 実装に密結合させない。
4. **cross-repository 接続は protocol 名で結ぶ**: Java call を捏造せず、Molang variable / animation / bone name の共有 contract として表現する。
5. **runtime は static と別事実として残す**: 「定義されている」と「実際に観測された」を同じ edge に潰さない。
6. **Analyzer/Core は外部 OSS を vendoring しない**: CodeGraph / Understand Anything などの解析能力は出力互換 adapter を優先する。Presentation/UI に限り、`docs/HUMAN_PRESENTATION_V2.md` の **Pinned Presentation Vendoring Exception**（固定SHA・LICENSE・UPSTREAM・PATCH記録必須）を適用できる。Presentation依存は CORE へ逆流させない。

## ディレクトリ

- `src/core/` — 共通 IR、単一repo走査、workspace merge
- `src/analyzers/` — Java / Forge / Minecraft / YSM の意味抽出
- `src/adapters/` — CodeGraph / Understand Anything / KNEEKURA-LAB Runtime trace / pose / bone palette / network companion
- `src/presentation/` — Human Presentation v2 の純粋Projection/表示adapter（COREへ逆依存しない）
- `viewer/` — 依存ゼロの Classic Web Viewer
- `fixtures/` — Minecraft を起動せず検証する小さな合成 Mod / workspace / runtime trace / pose / palette companion
- `docs/` — 設計・互換契約

## 現在の限界

Java 解析は安全側の lexical scanner（字句ベースの軽量解析）です。完全な構文木ではありません。複雑なネスト・生成コード・難読化コードの正確な call graph は CodeGraph/tree-sitter adapter の担当にします。

KNEEKURA-LAB の main JSONL trace (`anim` / Molang / entity lifecycle) と、対応する client pose companion (`.pose.json` / `.pose.bin`) は静的 graph に重ねられます。runtime evidence がある scan では fidelity matrix も生成され、`C0 static → C1 runtime mod → C2 entity → C3 YSM command → C4 rendered vertices → C5 per-bone runtime` のどこまで観測できたかを表示します。**unobserved は failure を意味しません。** pose は「対応runのクライアント描画が頂点を生成した」証拠です。bone帰属は pose から逆算せず、KNEEKURA-LAB が geoRender 直後に採った palette の `names[slot]` とTRSを直接使います。これにより C5 per-bone runtime transform まで直接 evidence 化できます。Forge 1.20.1 の静的network channel / packet / direction / send / handlerに加え、KNEEKURA-LABのruntime network companionから実送信・実受信も別々の証拠として重ねられます。packetがMolang式を運んだ事実に加えて、`net_semantic` があればReimu handler到達と `ysmclient molang execute` のcommand dispatch成功/失敗まで別々に証拠化できます。M4は `sendCommand()` が例外なく戻った境界、M5はForge client command pathが実際にconsumeした境界です。`handledByClient=false` はserver fallback evidenceとして別管理します。M5でもYSM内部のMolang evaluatorによる最終適用までは未証明です。capability の意味抽出は未実装です。

## Human Presentation v2

人間向け表示の次世代化は `docs/HUMAN_PRESENTATION_V2.md` に従います。KNEEKURA CORE を唯一の解析上の Authority（正しい情報を決める主体）のまま維持し、探索UIや説明図は Canonical Result を読むだけの Presentation 層として分離します。

P0 で境界契約・CORE→Presentation依存禁止・Canonical digest gate・Classic Viewer fallback・OSS provenance 方針を固定しました。P1 では `kneekura.explorer-projection/v1` を追加し、`kneekura.graph/v1` と `core.analysis-result/v1` を変更せず複製した Canonical snapshot の横に、node/edge/Claim/Coverage の一対一で追跡可能な Explorer metadata を生成します。KNEEKURA固有 kind、send/receive、M5/M6、static/runtime、UNKNOWN/FAILED/UNEXPLORED、Evidence/Counterevidence の意味は変換しません。React Flow 等の新UIは P2 以降です。

## AI / coding agent 向け出力との境界

KNEEKURA-CODE-LAB 本体のインターフェースは、引き続き**人間がコードを理解・探索・可視化するための表示**を優先します。Understanding / CodeGraph 風の説明や Viewer の見せ方を、AI間通信の都合で変更しません。

Coding agent から KNEEKURA の解析思想を利用する場合は、共有キュー **Jolly Research Mailbox** の `service: kneekura-code-lab` を使用します。

- Human-facing renderer: この repository の Viewer / 説明 / graph
- Agent-facing renderer: `genkimorimori252525-oss/jolly-research-mailbox` の KNEEKURA service

Agent-facing contract では Root Cause / Evidence / Recommended Changes / Do Not Change / Rejected Hypotheses / Verification Plan を圧縮して返し、依頼元 repository は read-only とします。

**Same analysis philosophy, different renderer.**
