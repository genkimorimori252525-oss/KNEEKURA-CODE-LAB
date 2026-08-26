import fs from 'node:fs/promises';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
import { readTraceIdentity, matchCompanionIdentity, resolveSiblingFile } from './kneekura-run-identity.mjs';

const CODEC = 'palmask-deflate-v1';
const COMPS = 9;
const COMPONENTS = ['rx','ry','rz','px','py','pz','sx','sy','sz'];

/**
 * Import KNEEKURA-LAB SimPaletteTrace as direct runtime per-bone TRS evidence.
 *
 * Wire values are YSM's post-geoRender local transform palette:
 *   rotation(rad) = comps 0..2
 *   position      = comps 3..5
 *   scale         = comps 6..8
 *
 * The codec is K/D stateful, but payload values are absolute float32 values. Keyframes reset all
 * omitted bones to zero before applying their payload. We preserve that exact contract.
 */
export async function importPaletteCompanion(builder, paletteFile, opts = {}) {
  builder.addAnalyzer('palette-companion-adapter', 'v1');

  if (!opts.trace) {
    reject(builder, paletteFile, 'palette companion requires the matching KNEEKURA runtime trace');
    return;
  }

  let index;
  try {
    index = JSON.parse(await fs.readFile(paletteFile, 'utf8'));
  } catch (e) {
    reject(builder, paletteFile, 'palette index is unreadable JSON', { error: String(e?.message || e) });
    return;
  }

  const indexError = validateIndex(index);
  if (indexError) {
    reject(builder, paletteFile, indexError);
    return;
  }

  const identity = await readTraceIdentity(opts.trace);
  const match = matchCompanionIdentity(identity, index, {
    allowV1: Boolean(opts.allowV1),
    label: 'palette companion'
  });
  if (!match.accepted) {
    reject(builder, paletteFile, match.reason, {
      traceUuid: identity?.reimu?.uuid ?? null,
      paletteUuid: index.uuid ?? null
    });
    return;
  }

  const binFile = resolveSiblingFile(paletteFile, index.bin);
  if (!binFile) {
    reject(builder, paletteFile, 'palette bin must be a sibling file, not an absolute/traversal path', { bin: index.bin });
    return;
  }

  const expectedBytes = index.lens.reduce((sum, n) => sum + n, 0);
  let stat;
  try {
    stat = await fs.stat(binFile);
  } catch {
    reject(builder, paletteFile, 'palette binary file is missing', { binFile, expectedBytes });
    return;
  }
  if (!stat.isFile() || stat.size !== expectedBytes) {
    reject(builder, paletteFile, 'palette binary byte size does not equal sum(lens)', {
      binFile,
      expectedBytes,
      actualBytes: stat.size
    });
    return;
  }

  let decoded;
  try {
    decoded = await decodePalette(binFile, index);
  } catch (e) {
    reject(builder, paletteFile, 'palette binary decode failed', {
      binFile,
      error: String(e?.message || e)
    });
    return;
  }

  const runtime = builder.node('runtime', 'kneekura:trace', {
    label: 'KNEEKURA Runtime Trace',
    runtimeObserved: true
  });
  const entityId = identity.reimu?.id ?? index.id;
  const entity = builder.node('runtime_entity', `kneekura:trace#entity:${entityId}`, {
    label: `runtime entity #${entityId}`,
    runtimeId: entityId,
    runtimeObserved: true,
    uuid: identity.reimu?.uuid ?? index.uuid ?? null,
    type: identity.reimu?.type ?? index.type ?? null
  });

  const capture = builder.node('runtime_palette_capture', path.resolve(paletteFile), {
    label: path.basename(paletteFile),
    runtimeObserved: true,
    boneTransformEvidence: true,
    paletteVersion: index.v,
    codec: index.codec,
    gt0: index.gt0,
    entityId: index.id,
    entityType: index.type,
    uuid: index.uuid ?? null,
    boneCount: index.bones,
    componentCount: index.comps,
    componentNames: COMPONENTS,
    keyframeTicks: index.keyframe,
    frameCount: index.frames,
    slotCount: index.slots.length,
    recordedTicks: decoded.recordedTicks,
    unrecordedTicks: index.slots.length - decoded.recordedTicks,
    recordingCoverage: index.slots.length ? decoded.recordedTicks / index.slots.length : 0,
    keyframeCount: decoded.keyframeCount,
    deltaCount: decoded.deltaCount,
    compressedBytes: expectedBytes,
    identityTrust: match.trust,
    traceStartGameTime: match.traceStart,
    traceEndGameTime: match.traceEnd,
    paletteStartGameTime: match.companionStart,
    paletteEndGameTime: match.companionEnd,
    overlapTicks: match.overlap,
    jars: Array.isArray(index.jars) ? index.jars : []
  });

  builder.edge(runtime, capture, 'OBSERVED_PALETTE_COMPANION', {
    source: paletteFile,
    confidence: 1,
    runtimeObservation: true,
    identityTrust: match.trust,
    overlapTicks: match.overlap
  });
  builder.edge(entity, capture, 'OBSERVED_RUNTIME_BONE_PALETTE', {
    source: paletteFile,
    confidence: 1,
    runtimeObservation: true,
    boneTransformEvidence: true,
    boneCount: index.bones,
    frameCount: index.frames
  });

  let activeBones = 0;
  let nonFiniteValues = 0;
  for (const s of decoded.series) {
    if (s.payloadRecordCount > 0) activeBones++;
    nonFiniteValues += s.nonFiniteValueCount;

    const boneName = builder.node('bone_name', s.name, {
      label: s.name,
      ecosystem: 'ysm',
      runtimeObserved: true
    });
    const series = builder.node('runtime_bone_series', `${path.resolve(paletteFile)}#bone:${s.slot}`, {
      label: `${s.name} runtime TRS`,
      runtimeObserved: true,
      boneTransformEvidence: true,
      bone: s.name,
      slot: s.slot,
      componentNames: COMPONENTS,
      rotationUnit: 'radians',
      payloadRecordCount: s.payloadRecordCount,
      keyframePayloadCount: s.keyframePayloadCount,
      keyframeZeroCount: s.keyframeZeroCount,
      firstRecordedTick: decoded.firstRecordedTick,
      lastRecordedTick: decoded.lastRecordedTick,
      firstPayloadTick: s.firstPayloadTick,
      lastPayloadTick: s.lastPayloadTick,
      firstTransform: s.firstTransform,
      lastTransform: s.lastTransform,
      payloadMin: s.payloadMin,
      payloadMax: s.payloadMax,
      nonFiniteValueCount: s.nonFiniteValueCount
    });

    builder.edge(capture, series, 'HAS_RUNTIME_BONE_SERIES', {
      source: paletteFile,
      confidence: 1,
      runtimeObservation: true,
      slot: s.slot
    });
    builder.edge(series, boneName, 'OBSERVED_RUNTIME_BONE_TRANSFORM', {
      source: paletteFile,
      confidence: 1,
      runtimeObservation: true,
      boneTransformEvidence: true,
      slot: s.slot,
      payloadRecordCount: s.payloadRecordCount,
      keyframeZeroCount: s.keyframeZeroCount,
      firstRecordedTick: decoded.firstRecordedTick,
      lastRecordedTick: decoded.lastRecordedTick
    });
  }

  capture.activeBoneCount = activeBones;
  capture.nonFiniteValueCount = nonFiniteValues;
}

function validateIndex(j) {
  if (!j || typeof j !== 'object' || Array.isArray(j)) return 'palette index must be a JSON object';
  if (!Number.isInteger(j.v) || j.v < 1) return 'palette index v must be a positive integer';
  if (j.codec !== CODEC) return `unsupported palette codec: ${j.codec}`;
  if (!Number.isFinite(j.gt0)) return 'palette gt0 must be a finite number';
  if (!Number.isInteger(j.bones) || j.bones <= 0) return 'palette bones must be a positive integer';
  if (j.comps !== COMPS) return `palette comps must be ${COMPS}`;
  if (!Number.isInteger(j.keyframe) || j.keyframe <= 0) return 'palette keyframe must be a positive integer';
  if (!Array.isArray(j.names) || j.names.length !== j.bones) return 'palette names length must equal bones';
  if (j.names.some(n => typeof n !== 'string' || !n)) return 'palette bone names must be non-empty strings';
  if (!Number.isInteger(j.frames) || j.frames <= 0) return 'palette frames must be a positive integer';
  if (!Array.isArray(j.slots)) return 'palette slots must be an array';
  if (!Array.isArray(j.lens) || j.lens.length !== j.frames) return 'palette lens length must equal frames';
  if (!Array.isArray(j.kinds) || j.kinds.length !== j.frames) return 'palette kinds length must equal frames';
  if (j.lens.some(n => !Number.isInteger(n) || n <= 0)) return 'palette lens must contain positive record lengths';
  if (j.kinds.some(k => k !== 'K' && k !== 'D')) return 'palette kinds may only contain K or D';
  if (j.frames > 0 && j.kinds[0] !== 'K') return 'palette first record must be a K keyframe';
  if (typeof j.bin !== 'string' || !j.bin.trim()) return 'palette bin is required';

  for (const slot of j.slots) {
    if (!Number.isInteger(slot) || slot < -1) return 'palette slots may only contain -1 or non-negative frame indexes';
    if (slot >= j.frames) return `palette slot references frame ${slot}, but frames=${j.frames}`;
  }

  const sum = j.lens.reduce((a, b) => a + b, 0);
  if (j.bytes !== undefined && j.bytes !== sum) return `palette bytes(${j.bytes}) != sum(lens)(${sum})`;
  return null;
}

async function decodePalette(binFile, index) {
  const handle = await fs.open(binFile, 'r');
  const maskBytes = Math.ceil(index.bones / 8);
  const current = new Float32Array(index.bones * COMPS);
  const generation = new Int32Array(index.bones);
  const stats = index.names.map((name, slot) => ({
    name,
    slot,
    payloadRecordCount: 0,
    keyframePayloadCount: 0,
    firstPayloadTick: null,
    lastPayloadTick: null,
    firstTransform: null,
    payloadMin: Array(COMPS).fill(Infinity),
    payloadMax: Array(COMPS).fill(-Infinity),
    nonFiniteValueCount: 0
  }));
  const tickByFrame = Array(index.frames).fill(null);
  for (let tick = 0; tick < index.slots.length; tick++) {
    const frame = index.slots[tick];
    if (frame >= 0 && tickByFrame[frame] === null) tickByFrame[frame] = tick;
  }

  let offset = 0;
  let epoch = 0;
  let keyframeCount = 0;
  let deltaCount = 0;

  try {
    for (let frame = 0; frame < index.frames; frame++) {
      const length = index.lens[frame];
      const record = Buffer.alloc(length);
      const { bytesRead } = await handle.read(record, 0, length, offset);
      if (bytesRead !== length) throw new Error(`short palette record read at frame ${frame}`);
      offset += length;

      let raw;
      try {
        raw = inflateSync(record);
      } catch (e) {
        throw new Error(`zlib inflate failed at frame ${frame}: ${e?.message || e}`);
      }
      if (raw.length < maskBytes) throw new Error(`inflated frame ${frame} is shorter than mask`);

      const extraBits = maskBytes * 8 - index.bones;
      if (extraBits > 0) {
        const highMask = ((1 << extraBits) - 1) << (8 - extraBits);
        if ((raw[maskBytes - 1] & highMask) !== 0) {
          throw new Error(`frame ${frame} sets mask bits beyond bone count`);
        }
      }

      let popcount = 0;
      for (let i = 0; i < maskBytes; i++) popcount += bitCount8(raw[i]);
      const expectedRaw = maskBytes + popcount * COMPS * 4;
      if (raw.length !== expectedRaw) {
        throw new Error(`inflated frame ${frame} size ${raw.length} != expected ${expectedRaw}`);
      }

      const kind = index.kinds[frame];
      if (kind === 'K') {
        epoch++;
        keyframeCount++;
      } else {
        if (epoch === 0) throw new Error(`delta frame ${frame} appears before first keyframe`);
        deltaCount++;
      }

      let pos = maskBytes;
      const tick = tickByFrame[frame];
      for (let bone = 0; bone < index.bones; bone++) {
        const set = ((raw[bone >> 3] >> (bone & 7)) & 1) !== 0;
        if (!set) continue;

        const s = stats[bone];
        const values = new Array(COMPS);
        for (let k = 0; k < COMPS; k++) {
          const value = raw.readFloatLE(pos);
          pos += 4;
          values[k] = jsonNumber(value);
          current[bone * COMPS + k] = value;
          if (Number.isFinite(value)) {
            s.payloadMin[k] = Math.min(s.payloadMin[k], value);
            s.payloadMax[k] = Math.max(s.payloadMax[k], value);
          } else {
            s.nonFiniteValueCount++;
          }
        }
        generation[bone] = epoch;
        s.payloadRecordCount++;
        if (kind === 'K') s.keyframePayloadCount++;
        if (s.firstTransform === null && frame === 0) s.firstTransform = values;
        if (tick !== null) {
          if (s.firstPayloadTick === null) s.firstPayloadTick = tick;
          s.lastPayloadTick = tick;
        }
      }

      // The first record is a self-contained K. Any bone omitted from it is explicitly zero.
      if (frame === 0) {
        for (const s of stats) {
          if (s.firstTransform === null) s.firstTransform = Array(COMPS).fill(0);
        }
      }
    }
  } finally {
    await handle.close();
  }

  const recordedTicks = index.slots.filter(x => x >= 0).length;
  const recordedTickValues = index.slots
    .map((frame, tick) => frame >= 0 ? tick : null)
    .filter(tick => tick !== null);
  const firstRecordedTick = recordedTickValues.length ? recordedTickValues[0] : null;
  const lastRecordedTick = recordedTickValues.length ? recordedTickValues[recordedTickValues.length - 1] : null;

  for (const s of stats) {
    s.keyframeZeroCount = keyframeCount - s.keyframePayloadCount;
    if (s.keyframeZeroCount > 0) {
      for (let k = 0; k < COMPS; k++) {
        s.payloadMin[k] = Math.min(s.payloadMin[k], 0);
        s.payloadMax[k] = Math.max(s.payloadMax[k], 0);
      }
    }
    s.payloadMin = s.payloadMin.map(v => Number.isFinite(v) ? v : null);
    s.payloadMax = s.payloadMax.map(v => Number.isFinite(v) ? v : null);

    const last = new Array(COMPS);
    if (generation[s.slot] === epoch) {
      for (let k = 0; k < COMPS; k++) last[k] = jsonNumber(current[s.slot * COMPS + k]);
    } else {
      last.fill(0);
    }
    s.lastTransform = last;
  }

  return {
    series: stats,
    recordedTicks,
    firstRecordedTick,
    lastRecordedTick,
    keyframeCount,
    deltaCount
  };
}

function bitCount8(v) {
  v &= 0xff;
  v = v - ((v >> 1) & 0x55);
  v = (v & 0x33) + ((v >> 2) & 0x33);
  return (((v + (v >> 4)) & 0x0f) * 0x01);
}

function jsonNumber(value) {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Infinity) return 'Infinity';
  if (value === -Infinity) return '-Infinity';
  if (Object.is(value, -0)) return '-0';
  return value;
}

function reject(builder, paletteFile, reason, data = {}) {
  builder.diagnostic('warn', 'palette companion rejected', {
    source: paletteFile,
    reason,
    ...data
  });
}
