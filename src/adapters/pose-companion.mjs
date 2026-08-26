import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Import one KNEEKURA-LAB SimPoseCodec companion as client-side render evidence.
 *
 * Source contract:
 * - <stamp>.pose.json is the index/header.
 * - <stamp>.pose.bin is float32 little-endian rendered vertex data.
 * - v2 UUID is a hard run-identity gate.
 * - gt0 + slots[] must overlap the trace's measured gameTime/tick window.
 *
 * This adapter intentionally does not infer bone transforms from rendered vertices.
 * It only proves that a matching client run produced a structurally valid vertex capture.
 */
export async function importPoseCompanion(builder, poseFile, opts = {}) {
  builder.addAnalyzer('pose-companion-adapter', 'v1');

  if (!opts.trace) {
    reject(builder, poseFile, 'pose companion requires the matching KNEEKURA runtime trace');
    return;
  }

  let index;
  try {
    index = JSON.parse(await fs.readFile(poseFile, 'utf8'));
  } catch (e) {
    reject(builder, poseFile, 'pose index is unreadable JSON', { error: String(e?.message || e) });
    return;
  }

  const indexError = validateIndex(index);
  if (indexError) {
    reject(builder, poseFile, indexError);
    return;
  }

  // SimAnimSweep libraries deliberately reuse the same .pose.json shape, but are not run recordings.
  const animsFile = poseFile.replace(/\.pose\.json$/i, '.anims.json');
  if (animsFile !== poseFile && await fileExists(animsFile)) {
    reject(builder, poseFile, 'animation-library pose companion is not a runtime recording', { animsFile });
    return;
  }

  const identity = await readTraceIdentity(opts.trace);
  if (!identity || identity.gameTime === null) {
    reject(builder, poseFile, 'runtime trace has no usable meta.gameTime');
    return;
  }
  if (!identity.reimu) {
    reject(builder, poseFile, 'runtime trace has no role=reimu spawn identity');
    return;
  }

  const match = matchIdentity(identity, index, Boolean(opts.allowV1));
  if (!match.accepted) {
    reject(builder, poseFile, match.reason, {
      traceUuid: identity.reimu.uuid,
      poseUuid: index.uuid ?? null
    });
    return;
  }

  const binFile = resolveSiblingBinary(poseFile, index.bin);
  if (!binFile) {
    reject(builder, poseFile, 'pose bin must be a sibling file, not an absolute/traversal path', { bin: index.bin });
    return;
  }

  const expected = expectedBinarySize(index);
  if (!expected.ok) {
    reject(builder, poseFile, expected.reason);
    return;
  }

  const binary = await validateBinary(binFile, expected.bytes);
  if (!binary.ok) {
    reject(builder, poseFile, binary.reason, {
      binFile,
      expectedBytes: expected.bytes,
      actualBytes: binary.actualBytes ?? null
    });
    return;
  }

  const slots = index.slots;
  const recordedSlots = slots.filter(v => Number.isInteger(v) && v >= 0);
  const uniqueFrames = new Set(recordedSlots);
  const totalVertices = Array.isArray(index.lens)
    ? index.lens.reduce((a, b) => a + b, 0)
    : index.frames * index.verts;
  const groups = summarizeGroups(index);

  const pose = builder.node('runtime_pose_capture', path.resolve(poseFile), {
    label: path.basename(poseFile),
    runtimeObserved: true,
    renderEvidence: true,
    poseVersion: index.v,
    gt0: index.gt0,
    entityId: index.id,
    entityType: index.type,
    uuid: index.uuid ?? null,
    texture: index.texture ?? null,
    stride: index.stride,
    frameCount: index.frames,
    vertexCount: totalVertices,
    slotCount: slots.length,
    recordedTicks: recordedSlots.length,
    unrecordedTicks: slots.length - recordedSlots.length,
    recordingCoverage: slots.length ? recordedSlots.length / slots.length : 0,
    referencedFrameCount: uniqueFrames.size,
    quant: index.quant ?? null,
    idempotent: index.idempotent ?? null,
    lensMode: Array.isArray(index.lens) ? 'variable' : 'fixed',
    expectedBinaryBytes: expected.bytes,
    actualBinaryBytes: binary.actualBytes,
    binaryValidation: 'exact-size + sampled-finite-f32le',
    binarySampledFloatCount: binary.sampledFloatCount,
    identityTrust: match.trust,
    traceStartGameTime: match.traceStart,
    traceEndGameTime: match.traceEnd,
    poseStartGameTime: match.poseStart,
    poseEndGameTime: match.poseEnd,
    overlapTicks: match.overlap,
    traceTickBase: identity.gameTime - index.gt0,
    groupFrameCount: groups.frameCount,
    renderGroupCount: groups.groupCount,
    renderTextureCount: groups.textureCount
  });

  const runtime = builder.node('runtime', 'kneekura:trace', {
    label: 'KNEEKURA Runtime Trace',
    runtimeObserved: true
  });
  const entityId = identity.reimu.id ?? index.id;
  const entity = builder.node('runtime_entity', `kneekura:trace#entity:${entityId}`, {
    label: `runtime entity #${entityId}`,
    runtimeId: entityId,
    runtimeObserved: true,
    uuid: identity.reimu.uuid ?? index.uuid ?? null,
    type: identity.reimu.type ?? index.type ?? null
  });

  builder.edge(runtime, pose, 'OBSERVED_POSE_COMPANION', {
    source: poseFile,
    confidence: 1,
    runtimeObservation: true,
    identityTrust: match.trust,
    overlapTicks: match.overlap
  });
  builder.edge(entity, pose, 'OBSERVED_RENDERED_POSE', {
    source: poseFile,
    confidence: 1,
    runtimeObservation: true,
    renderEvidence: true,
    identityTrust: match.trust,
    overlapTicks: match.overlap,
    recordedTicks: recordedSlots.length,
    frameCount: index.frames,
    vertexCount: totalVertices
  });
}

function validateIndex(j) {
  if (!j || typeof j !== 'object' || Array.isArray(j)) return 'pose index must be a JSON object';
  if (!Number.isInteger(j.v) || j.v < 1) return 'pose index v must be a positive integer';
  if (!Number.isFinite(j.gt0)) return 'pose index gt0 must be a finite number';
  if (!Number.isInteger(j.stride) || j.stride <= 0) return 'pose index stride must be a positive integer';
  if (!Number.isInteger(j.frames) || j.frames < 0) return 'pose index frames must be a non-negative integer';
  if (!Number.isInteger(j.verts) || j.verts < 0) return 'pose index verts must be a non-negative integer';
  if (typeof j.bin !== 'string' || !j.bin.trim()) return 'pose index bin is required';
  if (!Array.isArray(j.slots)) return 'pose index slots must be an array';

  for (const slot of j.slots) {
    if (!Number.isInteger(slot) || slot < -1) return 'pose slots may only contain -1 or non-negative frame indexes';
    if (slot >= j.frames) return `pose slot references frame ${slot}, but frames=${j.frames}`;
  }

  if (j.lens !== undefined) {
    if (!Array.isArray(j.lens) || j.lens.length !== j.frames) {
      return 'pose lens length must equal frames';
    }
    if (j.lens.some(v => !Number.isInteger(v) || v < 0)) {
      return 'pose lens must contain non-negative integer vertex counts';
    }
  }

  const hasAnyGroup = ['textures', 'glens', 'gtex'].some(k => j[k] !== undefined);
  const hasAllGroups = ['textures', 'glens', 'gtex'].every(k => Array.isArray(j[k]));
  if (hasAnyGroup && !hasAllGroups) return 'pose render-group table is partial (textures/glens/gtex must appear together)';
  if (hasAllGroups) {
    if (!Array.isArray(j.lens)) return 'pose render-group table requires lens';
    if (j.glens.length !== j.frames || j.gtex.length !== j.frames) {
      return 'pose render-group frame count must equal frames';
    }
    for (let i = 0; i < j.frames; i++) {
      if (!Array.isArray(j.glens[i]) || !Array.isArray(j.gtex[i]) || j.glens[i].length !== j.gtex[i].length) {
        return `pose render-group row ${i} is inconsistent`;
      }
      if (j.glens[i].some(v => !Number.isInteger(v) || v < 0)) return `pose glens[${i}] is invalid`;
      if (j.glens[i].reduce((a, b) => a + b, 0) !== j.lens[i]) {
        return `pose render-group vertex sum differs from lens[${i}]`;
      }
      for (const textureIndex of j.gtex[i]) {
        if (!Number.isInteger(textureIndex) || textureIndex < 0 || textureIndex >= j.textures.length) {
          return `pose gtex[${i}] contains an out-of-range texture index`;
        }
      }
    }
  }
  return null;
}

async function readTraceIdentity(file) {
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
  let meta = null;
  let reimu = null;
  let lastTick = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim().startsWith('{')) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (typeof e.t === 'number' && Number.isFinite(e.t)) {
      lastTick = lastTick === null ? e.t : Math.max(lastTick, e.t);
    }
    if (!meta && e.ch === 'meta') {
      meta = {
        gameTime: finiteOrNull(e.gameTime),
        duration: finiteOrNull(e.duration),
        scenario: e.scenario ?? null
      };
    }
    if (!reimu && e.ch === 'spawn' && e.role === 'reimu') {
      reimu = {
        id: e.id ?? null,
        uuid: typeof e.uuid === 'string' && e.uuid ? e.uuid : null,
        type: typeof e.type === 'string' && e.type ? e.type : null
      };
    }
  }
  if (!meta) return null;
  return { ...meta, lastTick, reimu };
}

function matchIdentity(identity, index, allowV1) {
  const traceUuid = identity.reimu?.uuid ?? null;
  let trust;

  if (traceUuid && index.uuid) {
    if (index.uuid !== traceUuid) {
      return { accepted: false, reason: `pose companion UUID mismatch (${index.uuid} != ${traceUuid})` };
    }
    trust = 'uuid';
  } else if (traceUuid && !index.uuid) {
    if (!allowV1) {
      return { accepted: false, reason: 'v1 pose companion has no UUID and is not auto-adopted for a UUID trace' };
    }
    trust = 'manual-v1';
  } else {
    const wantType = identity.reimu?.type ?? null;
    const wantId = identity.reimu?.id ?? null;
    if (wantType && index.type && index.type !== wantType) {
      return { accepted: false, reason: `legacy pose type mismatch (${index.type} != ${wantType})` };
    }
    if (wantId !== null && index.id !== undefined && index.id !== wantId) {
      return { accepted: false, reason: `legacy pose entity id mismatch (${index.id} != ${wantId})` };
    }
    trust = 'legacy';
  }

  const traceStart = identity.gameTime;
  const traceEnd = traceStart + (identity.lastTick ?? 0) + 1;
  const poseStart = index.gt0;
  const poseEnd = poseStart + index.slots.length;
  const overlap = Math.max(0, Math.min(traceEnd, poseEnd) - Math.max(traceStart, poseStart));
  if (overlap <= 0) {
    return {
      accepted: false,
      reason: `pose companion does not overlap measured trace ticks (trace [${traceStart},${traceEnd}) / pose [${poseStart},${poseEnd}))`
    };
  }
  return { accepted: true, trust, traceStart, traceEnd, poseStart, poseEnd, overlap };
}

function expectedBinarySize(index) {
  const vertexCount = Array.isArray(index.lens)
    ? index.lens.reduce((a, b) => a + b, 0)
    : index.frames * index.verts;
  const floats = vertexCount * index.stride;
  const bytes = floats * 4;
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    return { ok: false, reason: 'pose binary size exceeds safe integer range' };
  }
  return { ok: true, bytes };
}

async function validateBinary(file, expectedBytes) {
  let stat;
  try {
    stat = await fs.stat(file);
  } catch {
    return { ok: false, reason: 'pose binary file is missing' };
  }
  if (!stat.isFile()) return { ok: false, reason: 'pose binary path is not a file', actualBytes: stat.size };
  if (stat.size !== expectedBytes) {
    return { ok: false, reason: 'pose binary byte size does not match index geometry', actualBytes: stat.size };
  }
  if (stat.size === 0) return { ok: true, actualBytes: 0, sampledFloatCount: 0 };

  const handle = await fs.open(file, 'r');
  try {
    const sampleBytes = Math.min(stat.size, 4096) - (Math.min(stat.size, 4096) % 4);
    const positions = sampleBytes && stat.size > sampleBytes ? [0, stat.size - sampleBytes] : [0];
    let sampledFloatCount = 0;
    for (const position of positions) {
      const buffer = Buffer.alloc(sampleBytes);
      const { bytesRead } = await handle.read(buffer, 0, sampleBytes, position);
      if (bytesRead !== sampleBytes) {
        return { ok: false, reason: 'pose binary sample could not be read completely', actualBytes: stat.size };
      }
      for (let i = 0; i < bytesRead; i += 4) {
        if (!Number.isFinite(buffer.readFloatLE(i))) {
          return { ok: false, reason: 'pose binary sampled float32 contains NaN/Infinity', actualBytes: stat.size };
        }
        sampledFloatCount++;
      }
    }
    return { ok: true, actualBytes: stat.size, sampledFloatCount };
  } finally {
    await handle.close();
  }
}

function summarizeGroups(index) {
  if (!Array.isArray(index.glens) || !Array.isArray(index.textures)) {
    return { frameCount: 0, groupCount: 0, textureCount: 0 };
  }
  return {
    frameCount: index.glens.length,
    groupCount: index.glens.reduce((sum, row) => sum + row.length, 0),
    textureCount: index.textures.length
  };
}

function resolveSiblingBinary(poseFile, bin) {
  const base = path.resolve(path.dirname(poseFile));
  const target = path.resolve(base, bin);
  const rel = path.relative(base, target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return target;
}

async function fileExists(file) {
  try {
    await fs.stat(file);
    return true;
  } catch {
    return false;
  }
}

function reject(builder, poseFile, reason, data = {}) {
  builder.diagnostic('warn', 'pose companion rejected', {
    source: poseFile,
    reason,
    ...data
  });
}

function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
