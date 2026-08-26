# KNEEKURA-CODE-LAB

Minecraft / Forge Mod のコードを「普通の Java」ではなく、**Mod として意味づけして可視化する**ための私用研究リポジトリです。

初版は依存ゼロの Node.js 20+ で動きます。CodeGraph や Understand Anything を fork して固定化せず、将来それらの出力を adapter で取り込める構造にしています。

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
- 複数 Mod repository を workspace graph に結合
  - repository-local node は名前空間を分離
  - Molang variable / animation name / bone name は共有 contract node として統合
  - `TLM → Molang/animation → YSM` の cross-repository boundary edge を生成
- 未知の解析器の結果を Common IR にマージ
- Understand Anything の `knowledge-graph.json` をそのまま取り込み
- ブラウザで検索・node kind・edge type・TLM↔YSM boundary・runtime observed をフィルタ
- Static Graph と Runtime Graph を同じ IR 上で区別したまま重ねる

## Quick start

```powershell
npm test
node src/cli.mjs scan C:\path\to\mod-repo --out dist/graph.json

# Understand Anything の解析結果も重ねる
node src/cli.mjs scan C:\path\to\mod-repo `
  --understand C:\path\to\mod-repo `
  --out dist/graph.json

# KNEEKURA-LAB / SimLab JSONL trace を静的解析に重ねる
node src/cli.mjs scan C:\path\to\mod-repo `
  --trace C:\path\to\simlab-trace.jsonl `
  --out dist/runtime-overlay.json

node src/cli.mjs serve --graph dist/runtime-overlay.json
```

runtime trace の `anim` チャンネルに現れた animation / Molang は、静的解析が作った同じ `animation_name` / `molang_variable` node に合流します。Viewer の `runtime observed` を有効にすると、実測された経路だけを絞り込めます。

KNEEKURA-LAB の新しい trace は `meta.delta="row"` を持つことがあります。この場合 `anim` 行でフィールドが省略されていても、前の runtime state を保持する契約です。CODE-LAB は省略を新しい観測として数えず、明示的に記録された値だけを evidence にします。

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
                                                  entity / observed anim / observed Molang
```

### 重要な原則

1. **事実と推論を分ける**: edge は `confidence` と `evidence` を持つ。
2. **未知を捏造しない**: 解決できない import / target は unresolved node として残す。
3. **Minecraft 固有意味は adapter / semantic 層に置く**: 汎用グラフ IR を個別 Mod 実装に密結合させない。
4. **cross-repository 接続は protocol 名で結ぶ**: Java call を捏造せず、Molang variable / animation / bone name の共有 contract として表現する。
5. **runtime は static と別事実として残す**: 「定義されている」と「実際に観測された」を同じ edge に潰さない。
6. **外部 OSS は vendoring しない**: CodeGraph / Understand Anything は出力互換 adapter を介して利用する。

## ディレクトリ

- `src/core/` — 共通 IR、単一repo走査、workspace merge
- `src/analyzers/` — Java / Forge / Minecraft / YSM の意味抽出
- `src/adapters/` — CodeGraph / Understand Anything / KNEEKURA-LAB Runtime trace
- `viewer/` — 依存ゼロの Web Viewer
- `fixtures/` — Minecraft を起動せず検証する小さな合成 Mod / workspace / runtime trace
- `docs/` — 設計・互換契約

## 現在の限界

Java 解析は安全側の lexical scanner（字句ベースの軽量解析）です。完全な構文木ではありません。複雑なネスト・生成コード・難読化コードの正確な call graph は CodeGraph/tree-sitter adapter の担当にします。

KNEEKURA-LAB の main JSONL trace (`anim` / Molang / entity lifecycle) は静的 graph に重ねられます。一方、client が別ファイルへ書く pose companion (`.pose.json` / `.pose.bin`) はまだ未統合です。実際の描画頂点まで証拠化するには pose companion adapter が次の段階です。network packet、capability の意味抽出も未実装です。

## AI / coding agent 向け出力との境界

KNEEKURA-CODE-LAB 本体のインターフェースは、引き続き**人間がコードを理解・探索・可視化するための表示**を優先します。Understanding / CodeGraph 風の説明や Viewer の見せ方を、AI間通信の都合で変更しません。

Coding agent から KNEEKURA の解析思想を利用する場合は、共有キュー **Jolly Research Mailbox** の `service: kneekura-code-lab` を使用します。

- Human-facing renderer: この repository の Viewer / 説明 / graph
- Agent-facing renderer: `genkimorimori252525-oss/jolly-research-mailbox` の KNEEKURA service

Agent-facing contract では Root Cause / Evidence / Recommended Changes / Do Not Change / Rejected Hypotheses / Verification Plan を圧縮して返し、依頼元 repository は read-only とします。

**Same analysis philosophy, different renderer.**
