import fs from 'node:fs/promises';
import path from 'node:path';
import { extractMolangVariables } from '../analyzers/minecraft.mjs';

const EMPTY_SENTINELS = new Set(['', '-', 'none', 'null']);

/**
 * Import KNEEKURA-LAB / SimLab JSONL runtime facts without collapsing them into static facts.
 *
 * The source schema is owned by KNEEKURA-LAB SimCh/schema.json:
 * - every row has t + ch
 * - anim rows may contain anim / pend / molang / main / off / face
 * - delta=row means omitted anim fields keep their previous runtime value; omission is not failure
 *
 * CODE-LAB only materializes explicit observations here. It does not infer that an omitted delta field
 * changed, and it aggregates repeated explicit observations into firstTick/lastTick/count metadata.
 */
export async function importRuntimeTrace(builder, file) {
  const text = await fs.readFile(file, 'utf8');
  const runtime = builder.node('runtime', 'kneekura:trace', {
    label: 'KNEEKURA Runtime Trace',
    runtimeObserved: true,
    traceFile: file
  });
  const entities = new Map();
  const observations = new Map();
  const channelCounts = {};

  let lineNo = 0;
  for (const line of text.split(/\r?\n/)) {
    lineNo++;
    if (!line.trim()) continue;
    if (!line.trim().startsWith('{')) {
      builder.diagnostic('warn', 'invalid runtime JSONL row', { line: lineNo, source: file });
      continue;
    }

    let j;
    try {
      j = JSON.parse(line);
    } catch {
      builder.diagnostic('warn', 'invalid runtime JSONL', { line: lineNo, source: file });
      continue;
    }

    const ch = typeof j.ch === 'string' ? j.ch : 'unknown';
    channelCounts[ch] = (channelCounts[ch] ?? 0) + 1;

    if (ch === 'meta') {
      applyMeta(builder, runtime, j, file);
      continue;
    }

    if (ch === 'spawn' && j.id !== undefined) {
      const entity = runtimeEntity(builder, runtime, entities, j.id, file);
      entity.spawnTick = tickOrNull(j.t);
      if (j.type) entity.type = String(j.type);
      if (j.role) entity.role = String(j.role);
      if (j.name) entity.name = String(j.name);
      if (j.uuid) entity.uuid = String(j.uuid);
      if (typeof j.w === 'number') entity.width = j.w;
      if (typeof j.h === 'number') entity.height = j.h;
      if (typeof j.maxHp === 'number') entity.maxHp = j.maxHp;

      if (j.type) {
        const type = builder.node('runtime_entity_type', String(j.type), {
          label: String(j.type), runtimeObserved: true
        });
        builder.edge(runtime, type, 'OBSERVED_RUNTIME_ENTITY', {
          source: file, confidence: 1, runtimeObservation: true, tick: tickOrNull(j.t)
        });
        builder.edge(entity, type, 'RUNTIME_INSTANCE_OF', {
          source: file, confidence: 1, runtimeObservation: true, tick: tickOrNull(j.t)
        });
      }
      continue;
    }

    if (ch === 'gone' && j.id !== undefined) {
      const entity = runtimeEntity(builder, runtime, entities, j.id, file);
      entity.goneTick = tickOrNull(j.t);
      if (j.reason) entity.goneReason = String(j.reason);
      continue;
    }

    if (ch === 'anim' && j.id !== undefined) {
      const entity = runtimeEntity(builder, runtime, entities, j.id, file);
      observeAnimation(builder, observations, entity, j.anim, 'OBSERVED_RUNTIME_ANIMATION', j.t, lineNo, 'anim');
      observeAnimation(builder, observations, entity, j.pend, 'OBSERVED_RUNTIME_PENDING_ANIMATION', j.t, lineNo, 'pend');
      observeMolang(builder, observations, entity, j.molang, 'OBSERVED_RUNTIME_MOLANG_SEND', j.t, lineNo, 'molang');
      observeMolang(builder, observations, entity, j.face, 'OBSERVED_RUNTIME_FACE_STATE', j.t, lineNo, 'face');

      if (j.anim !== undefined) entity.lastObservedAnimation = String(j.anim);
      if (j.pend !== undefined) entity.lastObservedPendingAnimation = String(j.pend);
      if (j.main !== undefined) entity.lastObservedMainHand = String(j.main);
      if (j.off !== undefined) entity.lastObservedOffHand = String(j.off);
      continue;
    }

    if (ch === 'end') {
      runtime.endReason = j.reason ?? null;
      runtime.endTicks = numberOrNull(j.ticks);
      runtime.endTick = tickOrNull(j.t);
      if (typeof j.projSpawned === 'number') runtime.projectilesSpawned = j.projSpawned;
      if (typeof j.hitsByReimu === 'number') runtime.hitsByReimu = j.hitsByReimu;
      if (typeof j.dmgByReimu === 'number') runtime.damageByReimu = j.dmgByReimu;
      if (typeof j.dmgToReimu === 'number') runtime.damageToReimu = j.dmgToReimu;
      continue;
    }
  }

  for (const observation of observations.values()) {
    builder.edge(observation.from, observation.to, observation.type, {
      source: file,
      confidence: 1,
      runtimeObservation: true,
      observationCount: observation.count,
      firstTick: observation.firstTick,
      lastTick: observation.lastTick,
      fields: [...observation.fields],
      samples: observation.samples
    });
  }

  runtime.channelCounts = channelCounts;
  runtime.runtimeObservationCount = observations.size;
  builder.addAnalyzer('runtime-trace-adapter', 'v2');
}

function applyMeta(builder, runtime, j, file) {
  runtime.scenario = j.scenario ?? runtime.scenario ?? null;
  runtime.seed = j.seed ?? runtime.seed ?? null;
  runtime.arena = j.arena ?? runtime.arena ?? null;
  runtime.duration = j.duration ?? runtime.duration ?? null;
  runtime.gameTime = j.gameTime ?? runtime.gameTime ?? null;
  runtime.deltaMode = j.delta ?? runtime.deltaMode ?? null;
  runtime.keyframeTicks = j.keyframe ?? runtime.keyframeTicks ?? null;

  if (Array.isArray(j.mods)) {
    runtime.mods = j.mods.map(String);
    for (const id of j.mods) {
      const mod = builder.node('mod', String(id), { runtimeObserved: true });
      builder.edge(runtime, mod, 'OBSERVED_RUNTIME_MOD', {
        source: file, confidence: 1, runtimeObservation: true, tick: tickOrNull(j.t)
      });
    }
  }
}

function runtimeEntity(builder, runtime, entities, id, file) {
  const key = String(id);
  let entity = entities.get(key);
  if (entity) return entity;
  entity = builder.node('runtime_entity', `kneekura:trace#entity:${key}`, {
    label: `runtime entity #${key}`,
    runtimeId: id,
    runtimeObserved: true
  });
  entities.set(key, entity);
  builder.edge(runtime, entity, 'OBSERVED_RUNTIME_INSTANCE', {
    source: file, confidence: 1, runtimeObservation: true
  });
  return entity;
}

function observeAnimation(builder, observations, entity, value, type, tick, lineNo, field) {
  const name = meaningfulString(value);
  if (!name) return;
  const animation = builder.node('animation_name', name, {
    label: name,
    ecosystem: 'ysm',
    runtimeObserved: true
  });
  recordObservation(observations, entity, animation, type, tick, lineNo, field, name);
}

function observeMolang(builder, observations, entity, value, type, tick, lineNo, field) {
  const expression = meaningfulString(value);
  if (!expression) return;
  for (const variable of extractMolangVariables(expression)) {
    const node = builder.node('molang_variable', variable, {
      label: variable,
      runtimeObserved: true
    });
    recordObservation(observations, entity, node, type, tick, lineNo, field, expression);
  }
}

function recordObservation(observations, from, to, type, tick, lineNo, field, sample) {
  const key = `${from.id}\0${to.id}\0${type}`;
  const t = tickOrNull(tick);
  let o = observations.get(key);
  if (!o) {
    o = {
      from,
      to,
      type,
      count: 0,
      firstTick: t,
      lastTick: t,
      fields: new Set(),
      samples: []
    };
    observations.set(key, o);
  }
  o.count++;
  if (t !== null) {
    if (o.firstTick === null || t < o.firstTick) o.firstTick = t;
    if (o.lastTick === null || t > o.lastTick) o.lastTick = t;
  }
  o.fields.add(field);
  if (o.samples.length < 3) o.samples.push({ tick: t, line: lineNo, value: sample });
}

function meaningfulString(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (EMPTY_SENTINELS.has(s.toLowerCase())) return null;
  return s;
}

function tickOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function runtimeTraceLabel(file) {
  return path.basename(file);
}
