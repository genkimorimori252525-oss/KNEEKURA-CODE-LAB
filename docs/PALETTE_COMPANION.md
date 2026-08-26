# KNEEKURA-LAB bone palette companion

KNEEKURA-CODE-LAB は KNEEKURA-LAB の `SimPaletteTrace` / `SimPaletteCodec` が書く
`.pal.json + .pal.bin` を、**per-bone runtime transform の直接 evidence** として読む。

## Source semantics

採取点は YSM の `geoRender` 直後。

各 bone は `names[slot]` によって実名へ解決され、
wire 上では 1 bone につき 9 float を持つ。

```text
0..2  rotation (radians)
3..5  local position
6..8  local scale
```

元 palette の comps 9..11 (pal3) は wire へ載せない。

## Codec

`codec = palmask-deflate-v1`

1 record は zlib 圧縮された:

```text
mask || payload
```

- mask: `ceil(bones/8)` bytes, LSB-first
- payload: mask が立った bone ごとに 9 x float32 little-endian

### K record

keyframe。状態を全ゼロへ戻してから payload を適用する。

したがって K で mask が立っていない bone は、そのframeでは **明示的にzero state**。

### D record

直前stateから変化したboneだけ payloadに入る。
payload値はdelta量ではなく、そのboneの新しい絶対TRS値。

## Identity

pose companion と同じ共有 matcher を使う。

- trace UUID と palette UUID が両方ある → 不一致なら即reject
- UUID付きtrace + UUID無しpalette → 自動採用しない
- legacy trace → type/idを確認
- declared duration は使わず、traceの最大実測tickと `gt0 + slots.length` のoverlapを見る

## Integrity checks

- `names.length == bones`
- `comps == 9`
- `lens.length == frames`
- `kinds.length == frames`
- first record は `K`
- slot は `-1` または `[0, frames)`
- `bytes == sum(lens)` (bytes がindexにある場合)
- 実binサイズも `sum(lens)` と厳密一致
- maskのbone範囲外bitを拒否
- inflate後サイズが `maskBytes + popcount * 9 * 4` と厳密一致

## Graph model

採用されたpaletteは:

```text
KNEEKURA Runtime Trace
  --OBSERVED_PALETTE_COMPANION-->
runtime_palette_capture

runtime entity
  --OBSERVED_RUNTIME_BONE_PALETTE-->
runtime_palette_capture

runtime_palette_capture
  --HAS_RUNTIME_BONE_SERIES-->
runtime_bone_series
  --OBSERVED_RUNTIME_BONE_TRANSFORM-->
bone_name
```

`bone_name` は静的YSM model/animation graphと共有する。

そのため:

```text
animation_definition
  --ANIMATES_BONE-->
RightHandLocator
       ^
       |
OBSERVED_RUNTIME_BONE_TRANSFORM
       |
RightHandLocator runtime TRS
```

という同一graph上の接続になる。

## Series summary

巨大runをtickごとのnodeへ展開しない。
各bone seriesへ集約する。

- `payloadRecordCount`
- `keyframePayloadCount`
- `keyframeZeroCount`
- `firstRecordedTick / lastRecordedTick`
- `firstPayloadTick / lastPayloadTick`
- `firstTransform / lastTransform`
- `payloadMin / payloadMax`
- `nonFiniteValueCount`

Dで変わらないboneを毎tick複製しない。

## Fidelity C5

`OBSERVED_RUNTIME_BONE_TRANSFORM` が1本以上あれば、
YSM/TLM fidelity matrix の C5 (Per-bone runtime transform) は `observed` になる。

これは final vertices からboneを推測した結果ではない。
KNEEKURA-LABが実描画経路から採ったpaletteを、そのcodec規則で復号した直接 evidence。
