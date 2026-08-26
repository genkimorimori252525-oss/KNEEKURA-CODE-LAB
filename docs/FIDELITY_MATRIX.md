# YSM/TLM fidelity capability matrix

この matrix は KNEEKURA-CODE-LAB が持っている静的事実・runtime trace・pose evidence を、
**どこまで観測できたか**という順序で並べる。

## Semantics

status は 2 値。

- `observed` — この scan の Common Graph IR に根拠がある
- `unobserved` — この scan には根拠が無い

**`unobserved` は `failed` ではない。**

トレースを取っていない、instrumentation が無い、scenario がそこを通らなかった、などでも unobserved になる。
互換性エラーの断定器ではなく、調査開始点を絞る evidence map として使う。

## Stages

### C0 — Static YSM contracts

静的解析で YSM の model / animation / Molang / resource contract が見つかった。

主な evidence:

- `READS_MOLANG`
- `WRITES_MOLANG`
- `PROVIDES_ANIMATION_NAME`
- `DECLARES_MODEL`
- `ANIMATES_BONE`
- YSM model / bone / animation nodes

C0 が unobserved なら runtime より先に parser / resource discovery を疑う。

### C1 — Runtime YSM mod presence

KNEEKURA-LAB trace の `meta.mods` に Yes Steve Model が観測された。

これは「完全なFML lifecycleが正しい」ことまでは証明しない。
少なくとも trace run が YSM を runtime mod として認識している evidence。

### C2 — Runtime entity lifecycle

SimLab trace に runtime entity instance が現れた。

world / scenario / entity spawn まで到達した evidence。

### C3 — YSM command boundary

次のいずれかを runtime で観測した。

- `OBSERVED_RUNTIME_ANIMATION`
- `OBSERVED_RUNTIME_PENDING_ANIMATION`
- `OBSERVED_RUNTIME_MOLANG_SEND`
- `OBSERVED_RUNTIME_FACE_STATE`

TLM側から YSM semantic contract へ「命令した」層。

ここが unobserved なら client renderer より前の bridge / dispatch を優先して調べる。

### C4 — Client rendered vertices

UUID / measured tick window を通過した pose companion から、
整合した client-side vertex capture を得た。

`OBSERVED_RENDERED_POSE` が evidence。

C3 observed / C4 unobserved なら、

- pose identity rejection
- client capture
- YSM render entry
- native/backend
- pose binary integrity

など、**command後〜client render** に調査範囲を狭められる。

### C5 — Per-bone runtime transform

KNEEKURA-LAB の `SimPaletteTrace` が YSM の `geoRender` 直後から採った palette を復号し、
bone ごとの合成後ローカル `rotation(rad) / position / scale` を直接観測した層。

CODE-LAB は `names[slot]` を共有 `bone_name` へ結び、
`runtime_bone_series --OBSERVED_RUNTIME_BONE_TRANSFORM--> bone_name` を evidence にする。

pose companion は引き続き最終描画頂点の証拠であり、bone帰属には使わない。

## Matrix node

`fidelity_matrix: ysm-tlm-runtime` は以下を持つ。

- `observedStageCount`
- `observedThroughStage`
- `highestObservedStage`
- `firstUnobservedStage`
- `nextDiagnosticHint`
- `stageSummary[]`

各 `fidelity_capability` node は `SUPPORTED_BY` edge で最大16件の evidence node へ接続する。

## Viewer

runtime evidence を含む scan を開くと、右側 summary に例えば次のように出る。

```text
YSM fidelity
observed through C4 / next C5
C0 observed  C1 observed  C2 observed
C3 observed  C4 observed  C5 unobserved
```

この表示だけで、

> static はある / runtime command も飛んだ / client vertices も出た / per-bone TRS も直接観測できた

という切り分けができる。
