# KNEEKURA-CODE-LAB

Minecraft / Forge Mod のコードを「普通の Java」ではなく、**Mod として意味づけして可視化する**ための私用研究リポジトリです。

初版は依存ゼロの Node.js 20+ で動きます。CodeGraph や Understand Anything を fork して固定化せず、将来それらの出力を adapter で取り込める構造にしています。

## できること

- Java / JSON / `mods.toml` を再帰走査
- package / import / class / extends / implements をグラフ化
- Forge / Minecraft 固有の意味を追加
  - `@Mod`
  - `@Mixin`
  - `@SubscribeEvent`
  - `DeferredRegister`
  - `ResourceLocation`
  - Registry 参照
  - optional / required mod dependency
- 未知の解析器の結果を Common IR にマージ
- Understand Anything の `knowledge-graph.json` をそのまま取り込み
- ブラウザで検索・フィルタ・関係表示
- `Static Graph` と将来の `Runtime Graph` を同じ IR に重ねられる設計

## Quick start

```powershell
npm test
node src/cli.mjs scan C:\path\to\mod-repo --out dist/graph.json
# Understand Anything の解析結果も重ねる
node src/cli.mjs scan C:\path\to\mod-repo --understand C:\path\to\mod-repo --out dist/graph.json
node src/cli.mjs serve --graph dist/graph.json
```

ブラウザで `http://127.0.0.1:8789` を開きます。

## 設計

```text
repository
   │
   ├─ built-in scanner ──────────┐
   ├─ CodeGraph adapter (future) │
   └─ runtime trace (future)     │
                                ▼
                           Common Graph IR
                                │
                    ┌───────────┴───────────┐
                    ▼                       ▼
             Minecraft semantics          Viewer
             Forge / Mixin / Registry      search / inspect
```

### 重要な原則

1. **事実と推論を分ける**: edge は `confidence` と `evidence` を持つ。
2. **未知を捏造しない**: 解決できない import / target は unresolved node として残す。
3. **Minecraft 固有意味は adapter 層に置く**: 汎用グラフ IR を TLM/YSM/Warfare Wings 固有に汚染しない。
4. **外部 OSS は vendoring しない**: CodeGraph / Understand Anything は出力互換 adapter を介して利用する。

## ディレクトリ

- `src/core/` — 共通 IR、走査、グラフ操作
- `src/analyzers/` — Java / Forge / Minecraft の意味抽出
- `src/adapters/` — CodeGraph / Understand Anything / Runtime trace 入口（UAは実装済み）
- `viewer/` — 依存ゼロの Web Viewer
- `fixtures/` — Minecraft を起動せず検証する小さな合成 Mod
- `docs/` — 設計・互換契約

## 現在の限界

初版の Java 解析は安全側の lexical scanner（字句ベースの軽量解析）です。完全な構文木ではありません。複雑なネスト・生成コード・難読化コードの正確な call graph は CodeGraph/tree-sitter adapter の担当にします。

この割り切りにより、Minecraft 固有の意味付けと Viewer を先に安定させ、後から解析エンジンだけ交換できます。
