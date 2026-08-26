# Adapter contracts

## CodeGraph

`--codegraph exported.json` で外部 graph をマージできます。現時点では汎用 `{nodes, edges}` 形を受ける薄いadapterです。

今後 CodeGraph の安定した export/MCP 仕様に合わせ、ID解決・call graph・inheritance・symbol range を正式mappingします。

## Understand Anything

Understand Anything 自体は vendoring しません。`.understand-anything/knowledge-graph.json` を読み込む importer を追加するのが次段階です。

## KNEEKURA-LAB runtime trace

`--trace xxx.jsonl` は現在 `meta.mods` と `spawn.type` を取り込む最小実装です。将来 static class/method node と runtime event を evidence 付きで結びます。
