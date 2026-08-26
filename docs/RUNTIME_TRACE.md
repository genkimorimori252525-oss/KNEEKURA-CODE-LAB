# KNEEKURA-LAB runtime trace overlay

KNEEKURA-CODE-LAB は KNEEKURA-LAB / SimLab の main JSONL trace を、静的解析とは別の runtime evidence として Common Graph IR に重ねる。

## Source contract

権威ある書式は KNEEKURA-LAB 側の `SimCh` と `simlab/schema.json`。CODE-LAB は別スキーマを発明しない。

各行は最低限 `t` と `ch` を持つ。現在 overlay する主な channel は次の通り。

- `meta`: scenario / seed / arena / duration / gameTime / mods / delta / keyframe
- `spawn`: runtime entity id / type / role / uuid / hitbox
- `gone`: entity lifecycle end
- `anim`: `anim` / `pend` / `molang` / `face` / main/off hand observation
- `end`: run summary

## Static facts and runtime facts stay separate

静的 edge を runtime edge に上書きしない。

例:

```text
Java --WRITES_MOLANG--> variable.wuqi <--READS_MOLANG-- YSM animation
runtime entity --OBSERVED_RUNTIME_MOLANG_SEND--> variable.wuqi
runtime entity --OBSERVED_RUNTIME_ANIMATION----> idle2
```

同じ contract node に合流することで比較可能にするが、edge type は必ず分離する。

## Row-delta rule

`meta.delta == "row"` の trace では、`pos` / `phys` / `anim` 等の省略フィールドは「前値を保持」の意味を持つ。

したがって CODE-LAB は、ある `anim` 行に `anim` フィールドが無いことを以下のどれにも解釈しない。

- animation が停止した
- observation が失敗した
- 値が空になった

runtime graph へ evidence として載せるのは、その行に明示された値だけ。明示的な `-` / `none` / `null` も「名前」として node 化しない。

## Repeated observations

同じ entity -> semantic contract の実測を tick ごとに edge 化すると graph が肥大するため、1 edge に集約する。

- `observationCount`
- `firstTick`
- `lastTick`
- `fields`
- 最大3件の `samples` (`tick`, `line`, `value`)

これにより graph size を抑えつつ、観測頻度と根拠を失わない。

## Pose companion

client が別 writer / 別ファイルで生成する pose companion (`.pose.json` + `.pose.bin`) は main JSONL と同一視しない。CODE-LAB は別 adapter で統合し、UUID / gameTime / gt0 / measured tick overlap を検証してから render evidence として採用する。

詳細は `docs/POSE_COMPANION.md`。

## Bone palette companion

YSMの post-geoRender per-bone TRS は main JSONL や pose vertices から推測せず、`SimPaletteTrace` の `.pal.json + .pal.bin` を別adapterで読む。

詳細は `docs/PALETTE_COMPANION.md`。
