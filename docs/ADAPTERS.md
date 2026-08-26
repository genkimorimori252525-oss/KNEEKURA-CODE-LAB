# Adapter contracts

## CodeGraph

`--codegraph exported.json` で外部 graph をマージできます。現時点では汎用 `{nodes, edges}` 形を受ける薄いadapterです。

今後 CodeGraph の安定した export/MCP 仕様に合わせ、ID解決・call graph・inheritance・symbol range を正式mappingします。

## Understand Anything

`--understand <project-or-graph>` で現行の `knowledge-graph.json` を取り込めます。ファイルを直接指定するほか、プロジェクトルートを渡すと `.understand-anything/knowledge-graph.json` → `.ua/knowledge-graph.json` → `knowledge-graph.json` の順に自動検出します。

`nodes` は `ua:<type>`、`edges` は `UA_<TYPE>` として名前空間を分け、`layers` と `tour` もグラフへ保持します。KNEEKURA 固有解析と衝突させず、後から同一ノードへ解決する resolver を追加できる形です。

## KNEEKURA-LAB runtime trace

`--trace xxx.jsonl` は現在 `meta.mods` と `spawn.type` を取り込む最小実装です。将来 static class/method node と runtime event を evidence 付きで結びます。
