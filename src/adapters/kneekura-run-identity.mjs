import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Shared KNEEKURA-LAB run identity rules for companion files.
 *
 * Mirrors SimLab's matcher:
 * - UUID is a hard gate when both trace and companion have one.
 * - v1 companion is not auto-adopted for a UUID trace unless allowV1=true.
 * - legacy trace falls back to type/id checks.
 * - time overlap uses measured last tick, never declared duration.
 */
export async function readTraceIdentity(file) {
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

export function matchCompanionIdentity(identity, index, opts = {}) {
  const label = opts.label ?? 'companion';
  const allowV1 = Boolean(opts.allowV1);
  if (!identity || identity.gameTime === null || identity.gameTime === undefined) {
    return { accepted: false, reason: 'runtime trace has no usable meta.gameTime' };
  }
  if (!identity.reimu) {
    return { accepted: false, reason: 'runtime trace has no role=reimu spawn identity' };
  }

  const traceUuid = identity.reimu.uuid ?? null;
  let trust;

  if (traceUuid && index.uuid) {
    if (index.uuid !== traceUuid) {
      return { accepted: false, reason: `${label} UUID mismatch (${index.uuid} != ${traceUuid})` };
    }
    trust = 'uuid';
  } else if (traceUuid && !index.uuid) {
    if (!allowV1) {
      return { accepted: false, reason: `v1 ${label} has no UUID and is not auto-adopted for a UUID trace` };
    }
    trust = 'manual-v1';
  } else {
    const wantType = identity.reimu.type ?? null;
    const wantId = identity.reimu.id ?? null;
    if (wantType && index.type && index.type !== wantType) {
      return { accepted: false, reason: `legacy ${label} type mismatch (${index.type} != ${wantType})` };
    }
    if (wantId !== null && index.id !== undefined && index.id !== wantId) {
      return { accepted: false, reason: `legacy ${label} entity id mismatch (${index.id} != ${wantId})` };
    }
    trust = 'legacy';
  }

  const traceStart = identity.gameTime;
  const traceEnd = traceStart + (identity.lastTick ?? 0) + 1;
  const companionStart = index.gt0;
  const companionEnd = companionStart + (Array.isArray(index.slots) ? index.slots.length : 0);
  const overlap = Math.max(0, Math.min(traceEnd, companionEnd) - Math.max(traceStart, companionStart));

  if (overlap <= 0) {
    return {
      accepted: false,
      reason: `${label} does not overlap measured trace ticks (trace [${traceStart},${traceEnd}) / companion [${companionStart},${companionEnd}))`
    };
  }

  return {
    accepted: true,
    trust,
    traceStart,
    traceEnd,
    companionStart,
    companionEnd,
    overlap
  };
}

export function resolveSiblingFile(indexFile, child) {
  if (typeof child !== 'string' || !child.trim()) return null;
  const base = path.resolve(path.dirname(indexFile));
  const target = path.resolve(base, child);
  const rel = path.relative(base, target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return target;
}

export async function fileExists(file) {
  try {
    await fs.stat(file);
    return true;
  } catch {
    return false;
  }
}

function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
