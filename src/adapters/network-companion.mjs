import fs from 'node:fs/promises';
import path from 'node:path';
import { readTraceIdentity } from './kneekura-run-identity.mjs';
import { extractMolangVariables } from '../analyzers/minecraft.mjs';

/**
 * Import KNEEKURA-LAB v1 .net.jsonl as runtime network evidence.
 *
 * Network evidence stays distinct:
 * - OBSERVED_PACKET_SEND means a packet reached the Forge send boundary.
 * - OBSERVED_PACKET_RECEIVE means a decoded packet reached the registered consumer boundary.
 * Send never implies receive.
 */
export async function importNetworkCompanion(builder, networkFile, opts = {}) {
  builder.addAnalyzer('network-companion-adapter', 'v1');

  if (!opts.trace) {
    reject(builder, networkFile, 'network companion requires the matching KNEEKURA runtime trace');
    return;
  }

  const trace = await readTraceIdentity(opts.trace);
  if (!trace || trace.gameTime === null || trace.gameTime === undefined) {
    reject(builder, networkFile, 'runtime trace has no usable meta.gameTime');
    return;
  }

  let parsed;
  try {
    parsed = parseNetworkText(await fs.readFile(networkFile, 'utf8'), networkFile);
  } catch (e) {
    reject(builder, networkFile, 'network companion is invalid', { error: String(e?.message || e) });
    return;
  }

  const identity = matchNetworkIdentity(trace, parsed.meta, {
    allowUnbound: Boolean(opts.allowUnbound)
  });
  if (!identity.accepted) {
    reject(builder, networkFile, identity.reason, {
      traceScenario: trace.scenario ?? null,
      networkScenario: parsed.meta.scenario ?? null,
      traceRun: trace.run ?? null,
      networkRun: parsed.meta.run ?? null,
      networkBound: parsed.meta.bound ?? null
    });
    return;
  }

  const traceStart = trace.gameTime;
  const traceEnd = traceStart + (trace.lastTick ?? 0) + 1;
  const inWindow = parsed.events.filter(e =>
    Number.isInteger(e.gameTime) && e.gameTime >= traceStart && e.gameTime < traceEnd
  );
  if (!inWindow.length) {
    reject(builder, networkFile,
      `network companion has no events in measured trace window [${traceStart},${traceEnd})`,
      { minGameTime: parsed.minGameTime, maxGameTime: parsed.maxGameTime });
    return;
  }

  const capture = builder.node('runtime_network_capture', path.resolve(networkFile), {
    label: path.basename(networkFile),
    runtimeObserved: true,
    networkRuntimeEvidence: true,
    formatVersion: parsed.meta.v,
    scenario: parsed.meta.scenario,
    run: parsed.meta.run,
    bound: parsed.meta.bound !== false,
    physicalSide: parsed.meta.physicalSide,
    pid: parsed.meta.pid ?? null,
    startedGameTime: parsed.meta.startedGameTime ?? null,
    identityTrust: identity.trust,
    traceStartGameTime: traceStart,
    traceEndGameTime: traceEnd,
    totalEventCount: parsed.events.length,
    inWindowEventCount: inWindow.length,
    ignoredOutsideWindowCount: parsed.events.length - inWindow.length
  });

  const runtime = builder.node('runtime', 'kneekura:trace', {
    label: 'KNEEKURA Runtime Trace',
    runtimeObserved: true
  });
  builder.edge(runtime, capture, 'OBSERVED_NETWORK_COMPANION', {
    source: networkFile,
    confidence: 1,
    runtimeObservation: true,
    identityTrust: identity.trust,
    inWindowEventCount: inWindow.length
  });

  const groups = aggregate(inWindow, traceStart);
  let sendGroups = 0;
  let receiveGroups = 0;
  let sendEvents = 0;
  let receiveEvents = 0;

  for (const g of groups) {
    if (g.stage === 'send') {
      sendGroups++;
      sendEvents += g.observationCount;
    } else {
      receiveGroups++;
      receiveEvents += g.observationCount;
    }

    const packetSimple = simpleClassName(g.packet);
    const message = builder.node('network_message', packetSimple, {
      label: packetSimple,
      packetClass: packetSimple,
      runtimeObserved: true,
      runtimePacketClass: g.packet,
      networkRuntimeObserved: true
    });

    const observation = builder.node(
      'runtime_network_observation',
      `${path.resolve(networkFile)}#${groupKey(g)}`,
      {
        label: `${g.stage} ${packetSimple}`,
        runtimeObserved: true,
        networkRuntimeEvidence: true,
        stage: g.stage,
        packet: g.packet,
        packetSimple,
        direction: g.direction,
        channel: g.channel,
        physicalSide: g.physicalSide,
        observationCount: g.observationCount,
        firstGameTime: g.firstGameTime,
        lastGameTime: g.lastGameTime,
        firstTick: g.firstTick,
        lastTick: g.lastTick,
        threads: g.threads,
        sampleSeq: g.sampleSeq,
        payloadSamples: g.payloadSamples
      }
    );

    builder.edge(capture, observation, 'HAS_RUNTIME_NETWORK_OBSERVATION', {
      source: networkFile,
      confidence: 1,
      runtimeObservation: true,
      observationCount: g.observationCount
    });

    const edgeType = g.stage === 'send' ? 'OBSERVED_PACKET_SEND' : 'OBSERVED_PACKET_RECEIVE';
    builder.edge(observation, message, edgeType, {
      source: networkFile,
      confidence: 1,
      runtimeObservation: true,
      networkRuntimeEvidence: true,
      observationCount: g.observationCount,
      firstTick: g.firstTick,
      lastTick: g.lastTick,
      direction: g.direction,
      channel: g.channel,
      physicalSide: g.physicalSide
    });

    if (g.direction) {
      const direction = builder.node('network_direction', g.direction, {
        label: g.direction,
        runtimeObserved: true
      });
      builder.edge(observation, direction, 'OBSERVED_PACKET_DIRECTION', {
        source: networkFile,
        confidence: 1,
        runtimeObservation: true
      });
    }

    if (g.channel) {
      const staticChannels = builder.graph.nodes.filter(
        n => n.kind === 'network_channel' && n.resourceId === g.channel
      );
      if (staticChannels.length) {
        for (const channel of staticChannels.slice(0, 4)) {
          channel.runtimeObserved = true;
          builder.edge(observation, channel, 'OBSERVED_ON_NETWORK_CHANNEL', {
            source: networkFile,
            confidence: 1,
            runtimeObservation: true,
            channel: g.channel
          });
        }
      } else {
        const channel = builder.node('runtime_network_channel', g.channel, {
          label: g.channel,
          resourceId: g.channel,
          runtimeObserved: true,
          unresolvedStaticChannel: true
        });
        builder.edge(observation, channel, 'OBSERVED_ON_NETWORK_CHANNEL', {
          source: networkFile,
          confidence: 1,
          runtimeObservation: true,
          channel: g.channel
        });
      }
    }

    for (const m of g.molangEvidence) {
      const variable = builder.node('molang_variable', m.variable, {
        label: m.variable,
        runtimeObserved: true,
        networkPayloadObserved: true
      });
      builder.edge(observation, variable, 'OBSERVED_PACKET_PAYLOAD_MOLANG', {
        source: networkFile,
        confidence: 1,
        runtimeObservation: true,
        networkRuntimeEvidence: true,
        payloadObservation: true,
        stage: g.stage,
        observationCount: m.observationCount,
        firstTick: m.firstTick,
        lastTick: m.lastTick,
        fields: m.fields,
        samples: m.samples
      });
    }
  }

  Object.assign(capture, {
    sendGroupCount: sendGroups,
    receiveGroupCount: receiveGroups,
    sendEventCount: sendEvents,
    receiveEventCount: receiveEvents
  });

}

function parseNetworkText(text, source) {
  const rows = [];
  let lineNo = 0;
  for (const raw of String(text).split(/\r?\n/)) {
    lineNo++;
    if (!raw.trim()) continue;
    let row;
    try { row = JSON.parse(raw); }
    catch (e) { throw new Error(`${source}:${lineNo}: invalid JSON: ${e.message}`); }
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error(`${source}:${lineNo}: row must be an object`);
    }
    rows.push({ row, lineNo });
  }
  if (!rows.length) throw new Error('empty network companion');

  const meta = rows[0].row;
  if (meta.ch !== 'net_meta') throw new Error('first row must be ch=net_meta');
  if (meta.v !== 1) throw new Error(`unsupported network companion v=${meta.v}`);
  if (typeof meta.scenario !== 'string' || !meta.scenario) throw new Error('net_meta.scenario is required');
  if (typeof meta.run !== 'string' || !meta.run) throw new Error('net_meta.run is required');
  if (typeof meta.physicalSide !== 'string' || !meta.physicalSide) throw new Error('net_meta.physicalSide is required');

  const events = [];
  let prevSeq = 0;
  for (const { row, lineNo } of rows.slice(1)) {
    if (row.ch !== 'net' || row.v !== 1) throw new Error(`line ${lineNo}: expected v1 ch=net`);
    if (!Number.isInteger(row.seq) || row.seq <= prevSeq) throw new Error(`line ${lineNo}: seq must strictly increase`);
    prevSeq = row.seq;
    if (row.stage !== 'send' && row.stage !== 'receive') throw new Error(`line ${lineNo}: invalid stage`);
    if (typeof row.packet !== 'string' || !row.packet) throw new Error(`line ${lineNo}: packet is required`);
    if (!Number.isInteger(row.gameTime)) throw new Error(`line ${lineNo}: gameTime must be integer`);
    if (row.direction !== undefined && typeof row.direction !== 'string') throw new Error(`line ${lineNo}: direction must be string`);
    if (row.channel !== undefined && typeof row.channel !== 'string') throw new Error(`line ${lineNo}: channel must be string`);
    if (row.payload !== undefined) {
      if (!row.payload || typeof row.payload !== 'object' || Array.isArray(row.payload)) {
        throw new Error(`line ${lineNo}: payload must be an object`);
      }
      for (const [key, value] of Object.entries(row.payload)) {
        const scalar = typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
        if (!scalar) throw new Error(`line ${lineNo}: payload.${key} must be scalar`);
      }
    }
    events.push(row);
  }

  return {
    meta,
    events,
    minGameTime: events.length ? Math.min(...events.map(e => e.gameTime)) : null,
    maxGameTime: events.length ? Math.max(...events.map(e => e.gameTime)) : null
  };
}

function matchNetworkIdentity(trace, meta, opts = {}) {
  if (trace.scenario && meta.scenario !== trace.scenario) {
    return { accepted: false, reason: `network scenario mismatch (${meta.scenario} != ${trace.scenario})` };
  }

  const traceRun = trace.run ?? null;
  const netRun = meta.run ?? null;
  const bound = meta.bound !== false && netRun !== 'unbound';

  if (traceRun) {
    if (!bound) {
      if (!opts.allowUnbound) {
        return { accepted: false, reason: 'network companion is unbound while trace has a run identity' };
      }
      return { accepted: true, trust: 'manual-unbound' };
    }
    if (netRun !== traceRun) {
      return { accepted: false, reason: `network run mismatch (${netRun} != ${traceRun})` };
    }
    return { accepted: true, trust: 'run' };
  }

  if (bound) return { accepted: true, trust: 'legacy-scenario-time' };
  if (opts.allowUnbound) return { accepted: true, trust: 'manual-unbound' };
  return { accepted: false, reason: 'network companion has no trustworthy run identity' };
}

function aggregate(events, traceStart) {
  const map = new Map();
  for (const e of events) {
    const key = [
      e.stage,
      e.packet,
      e.direction ?? '',
      e.channel ?? '',
      e.physicalSide ?? ''
    ].join('\u0000');

    let g = map.get(key);
    if (!g) {
      g = {
        stage: e.stage,
        packet: e.packet,
        direction: e.direction ?? null,
        channel: e.channel ?? null,
        physicalSide: e.physicalSide ?? null,
        observationCount: 0,
        firstGameTime: e.gameTime,
        lastGameTime: e.gameTime,
        firstTick: e.gameTime - traceStart,
        lastTick: e.gameTime - traceStart,
        threads: [],
        sampleSeq: [],
        payloadSamples: [],
        molangEvidence: new Map()
      };
      map.set(key, g);
    }
    g.observationCount++;
    g.firstGameTime = Math.min(g.firstGameTime, e.gameTime);
    g.lastGameTime = Math.max(g.lastGameTime, e.gameTime);
    g.firstTick = Math.min(g.firstTick, e.gameTime - traceStart);
    g.lastTick = Math.max(g.lastTick, e.gameTime - traceStart);
    if (typeof e.thread === 'string' && e.thread && !g.threads.includes(e.thread) && g.threads.length < 8) {
      g.threads.push(e.thread);
    }
    if (g.sampleSeq.length < 8) g.sampleSeq.push(e.seq);

    if (e.payload && typeof e.payload === 'object' && !Array.isArray(e.payload)) {
      if (g.payloadSamples.length < 5) {
        g.payloadSamples.push({ seq: e.seq, tick: e.gameTime - traceStart, payload: e.payload });
      }
      for (const [field, value] of Object.entries(e.payload)) {
        if (typeof value !== 'string') continue;
        for (const variable of extractMolangVariables(value)) {
          let m = g.molangEvidence.get(variable);
          if (!m) {
            m = {
              variable,
              observationCount: 0,
              firstTick: e.gameTime - traceStart,
              lastTick: e.gameTime - traceStart,
              fields: new Set(),
              samples: []
            };
            g.molangEvidence.set(variable, m);
          }
          m.observationCount++;
          m.firstTick = Math.min(m.firstTick, e.gameTime - traceStart);
          m.lastTick = Math.max(m.lastTick, e.gameTime - traceStart);
          m.fields.add(field);
          if (m.samples.length < 5) {
            m.samples.push({
              seq: e.seq,
              tick: e.gameTime - traceStart,
              field,
              value: value.slice(0, 500)
            });
          }
        }
      }
    }
  }
  return [...map.values()].map(g => ({
    ...g,
    molangEvidence: [...g.molangEvidence.values()].map(m => ({
      ...m,
      fields: [...m.fields]
    }))
  }));
}

export function deriveNetworkDeliveryMatrix(builder) {
  const staticRegistered = builder.graph.edges.some(e => e.type === 'REGISTERS_PACKET');
  const sendEdges = builder.graph.edges.filter(e => e.type === 'OBSERVED_PACKET_SEND');
  const receiveEdges = builder.graph.edges.filter(e => e.type === 'OBSERVED_PACKET_RECEIVE');

  const stages = [
    { id: 'N0', label: 'Static packet registration', observed: staticRegistered },
    { id: 'N1', label: 'Runtime packet send', observed: sendEdges.length > 0 },
    { id: 'N2', label: 'Runtime packet receive', observed: receiveEdges.length > 0 }
  ];
  let contiguous = -1;
  for (let i = 0; i < stages.length; i++) {
    if (!stages[i].observed) break;
    contiguous = i;
  }

  const matrix = builder.node('network_delivery_matrix', 'forge-runtime-network', {
    label: 'Forge runtime network delivery',
    runtimeObserved: sendEdges.length > 0 || receiveEdges.length > 0,
    evidenceSemantics: 'observed-vs-unobserved',
    absenceIsFailure: false,
    observedThroughStage: contiguous >= 0 ? stages[contiguous].id : null,
    firstUnobservedStage: stages.find(s => !s.observed)?.id ?? null,
    stageSummary: stages.map(s => ({
      id: s.id,
      label: s.label,
      status: s.observed ? 'observed' : 'unobserved'
    })),
    interpretation: 'send and receive are separate observations; unobserved does not prove delivery failure'
  });

  for (const [order, stage] of stages.entries()) {
    const n = builder.node('network_delivery_stage', `forge-runtime-network:${stage.id}`, {
      label: `${stage.id} ${stage.label}`,
      stage: stage.id,
      order,
      status: stage.observed ? 'observed' : 'unobserved',
      observed: stage.observed,
      absenceIsFailure: false
    });
    builder.edge(matrix, n, 'HAS_NETWORK_DELIVERY_STAGE', {
      source: 'network-companion',
      confidence: 1,
      order,
      status: n.status
    });
  }
}

function simpleClassName(fqcn) {
  const raw = String(fqcn || '');
  const dot = raw.lastIndexOf('.');
  const dollar = raw.lastIndexOf('$');
  return raw.slice(Math.max(dot, dollar) + 1) || raw;
}

function groupKey(g) {
  return [g.stage, g.packet, g.direction ?? '', g.channel ?? '', g.physicalSide ?? ''].join('|');
}

function reject(builder, file, reason, data = {}) {
  builder.diagnostic('warn', 'network companion rejected', {
    source: file,
    reason,
    ...data
  });
}
