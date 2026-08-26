const NETWORK_DIRECTIONS = new Set([
  'PLAY_TO_CLIENT', 'PLAY_TO_SERVER', 'LOGIN_TO_CLIENT', 'LOGIN_TO_SERVER'
]);

export function analyzeForgeNetworkJava(builder, java) {
  const source = java.source;
  const rel = java.rel;
  const owner = java.classes[0] || java.fileNode;
  if (!looksNetworkRelevant(source)) return;

  const constants = extractStringConstants(source);
  const profile = builder.graph.nodes.find(n => n.kind === 'platform_profile') || null;
  const profileCompatibility = builder.graph.meta.platform?.compatibility || 'UNKNOWN';
  const channels = new Map();

  for (const call of findMemberCalls(source, 'NetworkRegistry', 'newSimpleChannel')) {
    const before = source.slice(Math.max(0, call.start - 500), call.start);
    const field = before.match(/\bSimpleChannel\s+([A-Za-z_$][\w$]*)\s*=\s*$/)?.[1] || ('channel@' + call.start);
    const args = splitTopLevelArgs(call.argsText);
    const resource = parseResourceLocation(args[0] || '', constants);
    const protocol = resolveStringExpression(args[1] || '', constants);

    const channel = builder.node('network_channel', owner.key + '#' + field, {
      label: resource.id || resource.path || field,
      channelField: field,
      resourceId: resource.id,
      namespaceExpression: resource.namespaceExpression,
      resourcePath: resource.path,
      protocolVersion: protocol,
      api: 'SimpleChannel',
      loader: 'forge',
      forgeProfile: 'forge-1.20.1',
      profileCompatibility
    });
    channels.set(field, channel);
    builder.edge(owner, channel, 'DECLARES_NETWORK_CHANNEL', {
      source: rel,
      evidence: compact(call.text),
      confidence: 1,
      forgeProfile: 'forge-1.20.1'
    });
    if (profile) {
      builder.edge(profile, channel, 'USES_FORGE_NETWORK_API', {
        source: rel,
        confidence: 1,
        api: 'SimpleChannel'
      });
    }
  }

  for (const call of findReceiverCalls(source, 'registerMessage')) {
    const args = splitTopLevelArgs(call.argsText);
    if (args.length < 5) continue;
    const packetClass = classLiteral(args[1]);
    if (!packetClass) continue;
    const channel = getOrCreateChannel(builder, owner, channels, call.receiver, rel, profileCompatibility);
    const message = packetNode(builder, packetClass, profileCompatibility);
    const direction = extractDirection(call.text);

    builder.edge(channel, message, 'REGISTERS_PACKET', {
      source: rel,
      confidence: 1,
      registrationStyle: 'registerMessage',
      discriminator: compact(args[0]),
      direction,
      encoderRef: compact(args[2]),
      decoderRef: compact(args[3]),
      handlerRef: compact(args[4]),
      consumerMainThread: false,
      forgeProfile: 'forge-1.20.1'
    });
    addDirection(builder, message, direction, rel);
    addMethodRef(builder, message, args[2], 'ENCODED_BY', rel);
    addMethodRef(builder, message, args[3], 'DECODED_BY', rel);
    addMethodRef(builder, message, args[4], 'HANDLED_BY', rel);
  }

  for (const call of findReceiverCalls(source, 'messageBuilder')) {
    const args = splitTopLevelArgs(call.argsText);
    const packetClass = classLiteral(args[0]);
    if (!packetClass) continue;
    const chain = consumeBuilderChain(source, call.end);
    const channel = getOrCreateChannel(builder, owner, channels, call.receiver, rel, profileCompatibility);
    const message = packetNode(builder, packetClass, profileCompatibility);
    const direction = extractDirection(args[2] || '') || extractDirection(chain.text);
    const encoder = chainArg(chain.text, 'encoder');
    const decoder = chainArg(chain.text, 'decoder');
    const consumerMain = chainArg(chain.text, 'consumerMainThread');
    const consumer = consumerMain || chainArg(chain.text, 'consumer');

    builder.edge(channel, message, 'REGISTERS_PACKET', {
      source: rel,
      confidence: 1,
      registrationStyle: 'messageBuilder',
      discriminator: compact(args[1] || ''),
      direction,
      encoderRef: encoder ? compact(encoder) : null,
      decoderRef: decoder ? compact(decoder) : null,
      handlerRef: consumer ? compact(consumer) : null,
      consumerMainThread: Boolean(consumerMain),
      forgeProfile: 'forge-1.20.1'
    });
    addDirection(builder, message, direction, rel);
    if (encoder) addMethodRef(builder, message, encoder, 'ENCODED_BY', rel);
    if (decoder) addMethodRef(builder, message, decoder, 'DECODED_BY', rel);
    if (consumer) addMethodRef(builder, message, consumer, 'HANDLED_BY', rel);
  }

  analyzePacketImplementation(builder, java, owner, profileCompatibility);
  analyzeSendSites(builder, java, owner, channels, profileCompatibility);
  analyzeNetworkBootstrap(builder, java, owner);
}

function analyzePacketImplementation(builder, java, owner, profileCompatibility) {
  const source = java.source;
  const rel = java.rel;
  const hasBuf = /\bFriendlyByteBuf\b/.test(source);
  const hasNetworkContext = /\bNetworkEvent(?:\.Context)?\b/.test(source);
  const encode = methodNode(builder, rel, 'encode');
  const decode = methodNode(builder, rel, 'decode');
  const handle = methodNode(builder, rel, 'handle');
  if (!hasBuf || (!hasNetworkContext && !handle) || (!encode && !decode && !handle)) return;
  if (owner.kind !== 'class') return;

  const message = packetNode(builder, owner.label, profileCompatibility);
  builder.edge(owner, message, 'IMPLEMENTS_PACKET', {
    source: rel,
    confidence: 0.95,
    evidence: 'FriendlyByteBuf / NetworkEvent packet shape'
  });
  if (encode) builder.edge(message, encode, 'ENCODED_BY', { source: rel, confidence: 1 });
  if (decode) builder.edge(message, decode, 'DECODED_BY', { source: rel, confidence: 1 });
  if (handle) builder.edge(message, handle, 'HANDLED_BY', { source: rel, confidence: 1 });

  const usesEnqueue = /\benqueueWork\s*\(/.test(source);
  const marksHandled = /\bsetPacketHandled\s*\(\s*true\s*\)/.test(source);
  const clientGuard = /getReceptionSide\s*\(\s*\)\s*\.\s*isClient\s*\(\s*\)/.test(source);
  const serverGuard = /getReceptionSide\s*\(\s*\)\s*\.\s*isServer\s*\(\s*\)/.test(source);

  message.usesEnqueueWork = usesEnqueue || Boolean(message.usesEnqueueWork);
  message.marksPacketHandled = marksHandled || Boolean(message.marksPacketHandled);
  if (clientGuard) message.handlerSideGuard = 'CLIENT';
  else if (serverGuard) message.handlerSideGuard = 'SERVER';

  if (handle && usesEnqueue) {
    const main = builder.node('runtime', 'forge:network_main_thread', {
      label: 'Forge network main thread handoff',
      loader: 'forge'
    });
    builder.edge(handle, main, 'ENQUEUES_NETWORK_WORK', {
      source: rel,
      confidence: 1,
      evidence: 'NetworkEvent.Context.enqueueWork'
    });
  }

  if (handle && (clientGuard || serverGuard)) {
    const side = clientGuard ? 'CLIENT' : 'SERVER';
    const sideNode = builder.node('network_side', side, { label: side });
    builder.edge(handle, sideNode, 'GUARDS_NETWORK_SIDE', {
      source: rel,
      confidence: 1,
      side
    });
  }

  if (handle) {
    for (const target of extractEnqueueTargets(source)) {
      const targetNode = builder.node('network_handler_target', target, {
        label: target,
        external: !target.startsWith(owner.label + '.')
      });
      builder.edge(handle, targetNode, 'DISPATCHES_NETWORK_HANDLER', {
        source: rel,
        confidence: 0.9,
        evidence: 'enqueueWork lambda target'
      });
    }
  }
}

function analyzeSendSites(builder, java, owner, channels, profileCompatibility) {
  const source = java.source;
  const rel = java.rel;

  for (const call of findReceiverCalls(source, 'send')) {
    const args = splitTopLevelArgs(call.argsText);
    if (args.length < 2) continue;
    const distribution = extractDistribution(args[0]);
    const messageClass = newExpressionClass(args[1]);
    const channel = getOrCreateChannel(builder, owner, channels, call.receiver, rel, profileCompatibility);
    const site = builder.node('network_send_site', rel + ':' + call.start, {
      label: messageClass ? ('send ' + messageClass) : 'channel.send',
      path: rel,
      messageExpression: compact(args[1]),
      distribution
    });
    builder.edge(owner, site, 'DECLARES_NETWORK_SEND', { source: rel, confidence: 1 });
    builder.edge(site, channel, 'USES_NETWORK_CHANNEL', { source: rel, confidence: 1 });
    if (distribution) {
      const dist = builder.node('network_distribution', distribution, { label: distribution });
      builder.edge(site, dist, 'DISTRIBUTES_TO', { source: rel, confidence: 1 });
    }
    if (messageClass) {
      const message = packetNode(builder, messageClass, profileCompatibility);
      builder.edge(site, message, 'SENDS_PACKET', { source: rel, confidence: 0.95 });
    }
  }

  for (const call of findReceiverCalls(source, 'sendToServer')) {
    const args = splitTopLevelArgs(call.argsText);
    if (!args[0]) continue;
    const messageClass = newExpressionClass(args[0]);
    const channel = getOrCreateChannel(builder, owner, channels, call.receiver, rel, profileCompatibility);
    const site = builder.node('network_send_site', rel + ':' + call.start, {
      label: messageClass ? ('sendToServer ' + messageClass) : 'sendToServer',
      path: rel,
      messageExpression: compact(args[0]),
      direction: 'PLAY_TO_SERVER'
    });
    builder.edge(owner, site, 'DECLARES_NETWORK_SEND', { source: rel, confidence: 1 });
    builder.edge(site, channel, 'USES_NETWORK_CHANNEL', { source: rel, confidence: 1 });
    addDirection(builder, site, 'PLAY_TO_SERVER', rel);
    if (messageClass) {
      const message = packetNode(builder, messageClass, profileCompatibility);
      builder.edge(site, message, 'SENDS_PACKET', {
        source: rel,
        confidence: 0.95,
        direction: 'PLAY_TO_SERVER'
      });
    }
  }
}

function analyzeNetworkBootstrap(builder, java, owner) {
  const source = java.source;
  const rel = java.rel;
  if (/\bFMLCommonSetupEvent\b/.test(source)) {
    const re = /\benqueueWork\s*\(\s*([A-Za-z_$][\w.$]*)\s*::\s*([A-Za-z_$][\w$]*)\s*\)/g;
    for (const m of source.matchAll(re)) {
      const refText = m[1] + '::' + m[2];
      const ref = builder.node('network_init_ref', refText, { label: refText });
      builder.edge(owner, ref, 'SCHEDULES_NETWORK_INIT', {
        source: rel,
        confidence: 1,
        evidence: compact(m[0])
      });
    }
  }

  if (owner.kind === 'class') {
    const initMethod = methodNode(builder, rel, 'init');
    if (initMethod && /\b(?:registerMessage|messageBuilder)\s*\(/.test(source)) {
      const refText = owner.label + '::init';
      const ref = builder.node('network_init_ref', refText, { label: refText });
      builder.edge(initMethod, ref, 'IMPLEMENTS_NETWORK_INIT', {
        source: rel,
        confidence: 1
      });
    }
  }
}

function packetNode(builder, packetClass, profileCompatibility) {
  return builder.node('network_message', packetClass, {
    label: packetClass,
    packetClass,
    loader: 'forge',
    forgeProfile: 'forge-1.20.1',
    profileCompatibility
  });
}

function getOrCreateChannel(builder, owner, channels, receiver, rel, profileCompatibility) {
  if (channels.has(receiver)) return channels.get(receiver);
  const channel = builder.node('network_channel', owner.key + '#' + receiver, {
    label: receiver,
    channelField: receiver,
    api: 'SimpleChannel',
    loader: 'forge',
    forgeProfile: 'forge-1.20.1',
    profileCompatibility,
    unresolvedDefinition: true
  });
  channels.set(receiver, channel);
  builder.edge(owner, channel, 'REFERENCES_NETWORK_CHANNEL', {
    source: rel,
    confidence: 0.65
  });
  return channel;
}

function addDirection(builder, from, direction, rel) {
  if (!direction || !NETWORK_DIRECTIONS.has(direction)) return;
  const d = builder.node('network_direction', direction, { label: direction });
  builder.edge(from, d, 'PACKET_DIRECTION', {
    source: rel,
    confidence: 1,
    direction
  });
}

function addMethodRef(builder, message, expression, edgeType, rel) {
  const value = compact(expression);
  if (!value) return;
  const ref = builder.node('method_ref', value, { label: value, external: true });
  builder.edge(message, ref, edgeType, {
    source: rel,
    confidence: 0.9,
    methodReference: true
  });
}

function looksNetworkRelevant(source) {
  return /net\.minecraftforge\.network|\bNetworkRegistry\b|\bSimpleChannel\b|\.registerMessage\s*\(|\.messageBuilder\s*\(|\bPacketDistributor\b|\bNetworkEvent\b|\bFriendlyByteBuf\b|\bFMLCommonSetupEvent\b/.test(source);
}

function extractStringConstants(source) {
  const out = new Map();
  const re = /\b(?:public\s+|private\s+|protected\s+)?(?:static\s+)?(?:final\s+)?String\s+([A-Za-z_$][\w$]*)\s*=\s*["']([^"']*)["']\s*;/g;
  for (const m of source.matchAll(re)) out.set(m[1], m[2]);
  return out;
}

function parseResourceLocation(expr, constants) {
  let m = expr.match(/(?:new\s+)?ResourceLocation\s*\((.*)\)\s*$/s);
  if (!m) m = expr.match(/ResourceLocation\s*\.\s*(?:fromNamespaceAndPath|tryBuild)\s*\((.*)\)\s*$/s);
  if (!m) return { id: null, namespaceExpression: compact(expr), path: null };
  const args = splitTopLevelArgs(m[1]);
  const ns = resolveStringExpression(args[0] || '', constants);
  const p = resolveStringExpression(args[1] || '', constants);
  return {
    id: ns && p ? (ns + ':' + p) : null,
    namespaceExpression: ns || compact(args[0] || ''),
    path: p
  };
}

function resolveStringExpression(expr, constants) {
  const s = compact(expr);
  const literal = s.match(/^["']([^"']*)["']$/)?.[1];
  if (literal !== undefined) return literal;
  if (constants.has(s)) return constants.get(s);

  // Forge 1.20.1 newSimpleChannel commonly uses a Supplier<String>: () -> VERSION.
  const lambdaConst = s.match(/^\(\s*\)\s*->\s*([A-Za-z_$][\w$]*)$/)?.[1];
  if (lambdaConst && constants.has(lambdaConst)) return constants.get(lambdaConst);

  const simple = s.split('.').at(-1);
  if (constants.has(simple)) return constants.get(simple);
  return null;
}

function classLiteral(expr) {
  return expr?.match(/\b([A-Za-z_$][\w.$]*)\s*\.class\b/)?.[1] || null;
}

function newExpressionClass(expr) {
  return expr?.match(/\bnew\s+([A-Za-z_$][\w.$]*)\s*\(/)?.[1] || null;
}

function extractDirection(text) {
  return text?.match(/\bNetworkDirection\.([A-Z_]+)/)?.[1] || null;
}

function extractDistribution(text) {
  return text?.match(/\bPacketDistributor\.([A-Z_]+)/)?.[1] || null;
}

function methodNode(builder, rel, label) {
  return builder.graph.nodes.find(n => n.kind === 'method' && n.path === rel && n.label === label) || null;
}

function findMemberCalls(source, receiverName, methodName) {
  const out = [];
  const re = new RegExp('\\b' + escapeRe(receiverName) + '\\s*\\.\\s*' + escapeRe(methodName) + '\\s*\\(', 'g');
  for (const m of source.matchAll(re)) {
    const open = source.indexOf('(', m.index);
    const end = consumeBalanced(source, open);
    out.push({
      receiver: receiverName,
      start: m.index,
      end,
      argsText: source.slice(open + 1, Math.max(open + 1, end - 1)),
      text: source.slice(m.index, end)
    });
  }
  return out;
}

function findReceiverCalls(source, methodName) {
  const out = [];
  const re = new RegExp('\\b([A-Za-z_$][\\w$]*)\\s*\\.\\s*' + escapeRe(methodName) + '\\s*\\(', 'g');
  for (const m of source.matchAll(re)) {
    const open = source.indexOf('(', m.index);
    const end = consumeBalanced(source, open);
    out.push({
      receiver: m[1],
      start: m.index,
      end,
      argsText: source.slice(open + 1, Math.max(open + 1, end - 1)),
      text: source.slice(m.index, end)
    });
  }
  return out;
}

function consumeBuilderChain(source, start) {
  const max = Math.min(source.length, start + 4000);
  const semi = source.indexOf(';', start);
  const end = semi >= 0 && semi < max ? semi + 1 : max;
  return { text: source.slice(start, end), end };
}

function chainArg(text, method) {
  const re = new RegExp('\\.' + escapeRe(method) + '\\s*\\(', 'g');
  const m = re.exec(text);
  if (!m) return null;
  const open = text.indexOf('(', m.index);
  const end = consumeBalanced(text, open);
  return text.slice(open + 1, Math.max(open + 1, end - 1)).trim();
}

function splitTopLevelArgs(text) {
  const out = [];
  let start = 0;
  let paren = 0;
  let brace = 0;
  let bracket = 0;
  let angle = 0;
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '(') paren++;
    else if (ch === ')') paren--;
    else if (ch === '{') brace++;
    else if (ch === '}') brace--;
    else if (ch === '[') bracket++;
    else if (ch === ']') bracket--;
    else if (ch === '<') angle++;
    else if (ch === '>') angle = Math.max(0, angle - 1);
    else if (ch === ',' && paren === 0 && brace === 0 && bracket === 0 && angle === 0) {
      out.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  const tail = text.slice(start).trim();
  if (tail || out.length) out.push(tail);
  return out;
}

function consumeBalanced(source, openIndex) {
  let depth = 0;
  let quote = null;
  for (let i = openIndex; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return source.length;
}

function extractEnqueueTargets(source) {
  const out = new Set();
  for (const m of source.matchAll(/\benqueueWork\s*\(/g)) {
    const open = source.indexOf('(', m.index);
    const end = consumeBalanced(source, open);
    const body = source.slice(open + 1, end - 1);

    const direct = body.match(/->\s*([A-Za-z_$][\w.$]*)\s*\(/)?.[1];
    if (direct && !isNoiseTarget(direct)) out.add(direct);

    const full = /\b((?:[A-Za-z_$][\w$]*\.)+[A-Za-z_$][\w$]*)\s*\(/g;
    for (const x of body.matchAll(full)) {
      if (!isNoiseTarget(x[1])) out.add(x[1]);
    }
  }
  return [...out].slice(0, 12);
}

function isNoiseTarget(target) {
  return /(?:ctx|context|Supplier|NetworkEvent\.Context|get|enqueueWork|setPacketHandled)$/.test(target);
}

function compact(s) {
  return String(s || '').replace(/\s+/g, ' ').trim().slice(0, 800);
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^$()|[\]\\{}]/g, '\\$&');
}
