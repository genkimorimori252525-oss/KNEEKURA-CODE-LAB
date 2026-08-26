# KNEEKURA-LAB pose companion evidence

KNEEKURA-CODE-LAB は KNEEKURA-LAB / SimLab の `SimPoseCodec` companion を、
main JSONL trace とは別の **client-side render evidence** として Common Graph IR に重ねる。

## Source contract

権威ある形式は KNEEKURA-LAB の `SimPoseCodec` / `simlab/pose.mjs`。

1 run の pose recording は通常 2 ファイル。

- `<stamp>.pose.json` — header/index
- `<stamp>.pose.bin` — float32 little-endian vertex data

index から読む主なフィールド:

- `v`
- `gt0`
- `id` / `type` / `uuid`
- `texture`
- `stride`
- `verts`
- `frames`
- `slots[]`
- optional `lens[]`
- optional `textures[] / glens[][] / gtex[][]`
- `bin`

## Run identity is a gate, not a score

KNEEKURA-LAB 本体と同じ規則を使う。

### v2: trace と pose の両方に UUID がある

UUID が一致しなければ **即 reject**。

type や entity id が似ていることを理由にフォールバックしない。

### trace に UUID があり pose に UUID がない

v1 companion は自動採用しない。

人間が明示的に使う場合だけ `--allow-v1-pose` を渡す。

### old trace: trace 側に UUID がない

legacy 経路として type / entity id の不一致を reject した上で、時間範囲を検証する。

## Measured tick overlap

宣言上の `duration` ではなく、trace に実際に現れた最大 `t` を使う。

```text
trace interval = [meta.gameTime, meta.gameTime + lastObservedTick + 1)
pose interval  = [pose.gt0, pose.gt0 + slots.length)
```

重なりが 0 tick なら採用しない。

長い scenario の宣言 duration を使って過去runの companion を誤吸着させないための規則。

## Binary integrity

pose index を採用したあと、`bin` は pose JSON と同じディレクトリの sibling file に限定する。
absolute path や `../` traversal は拒否する。

期待byte数は次で計算する。

### Variable-length frames

```text
expectedBytes = sum(lens) * stride * 4
```

### Legacy fixed-width frames

```text
expectedBytes = frames * verts * stride * 4
```

実ファイルサイズが 1 byte でも違えば render evidence として採用しない。

巨大な pose bin を全部メモリへ読み込まないため、内容は先頭・末尾を最大 4KiB ずつだけ読み、
float32 little-endian として NaN / Infinity が無いことをサンプル検証する。

## Render-group consistency

`textures / glens / gtex` がある場合は 3 つをセットとして扱う。

- `glens.length == frames`
- `gtex.length == frames`
- 各 frame で `glens[i].length == gtex[i].length`
- `sum(glens[i]) == lens[i]`
- `gtex` の texture index が `textures` の範囲内

不整合な companion を「描画できた証拠」として採用しない。

## Graph meaning

採用された companion は `runtime_pose_capture` node になる。

```text
KNEEKURA Runtime Trace
  --OBSERVED_POSE_COMPANION-->
runtime_pose_capture

runtime entity
  --OBSERVED_RENDERED_POSE-->
runtime_pose_capture
```

node には以下のような evidence を残す。

- `identityTrust`
- `overlapTicks`
- `frameCount`
- `vertexCount`
- `recordedTicks / unrecordedTicks`
- `recordingCoverage`
- `expectedBinaryBytes / actualBinaryBytes`
- `binaryValidation`
- render group / texture counts

## What this proves

この evidence が示すのは、

> 対応する runtime run の client-side render path が、index と整合する頂点データを生成した

という事実。

## What this does NOT prove

pose companion は最終描画頂点の記録なので、現段階では次を捏造しない。

- どの頂点が `RightHandLocator` 由来か
- 特定 bone の runtime rotation / pivot / matrix
- Molang 変数 1 個が特定頂点変化の直接原因だったこと
- 最終画面が人間の意図どおり見えていたこと

静的 graph の bone hierarchy と runtime pose evidence は同じ Viewer に存在するが、
per-bone attribution は専用の runtime instrumentation が得られるまで別事実のまま保つ。
