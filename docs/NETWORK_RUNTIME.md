# KNEEKURA runtime network evidence

KNEEKURA-CODE-LAB は KNEEKURA-LAB の v1 .net.jsonl companion を、
Forge 1.20.1 の静的 SimpleChannel graph に runtime evidence として重ねる。

## Inputs

~~~powershell
node src/cli.mjs scan C:/path/to/mod \
  --trace C:/path/to/arena-0.jsonl \
  --net C:/path/to/dedicated_server-123.net.jsonl \
  --net C:/path/to/client-456.net.jsonl \
  --out dist/network-runtime.json
~~~

--net は複数回指定できる。server/client の process-local companion を同じ scan に載せるため。

## Identity gate

network evidence は「時刻が近い」だけでは採用しない。

1. scenario が違う → reject
2. main trace に meta.run がある:
   - companion が run=unbound / bound=false → reject
   - run が違う → reject
   - run が一致 → identityTrust=run
3. main trace が古く meta.run を持たない:
   - bound companion は legacy-scenario-time
   - unbound companion は reject
4. 明示的な調査だけ --allow-unbound-net で unbound を許可

run gateを通った後も、main traceの実測tick窓だけを採用する。

~~~text
trace window = [meta.gameTime, meta.gameTime + lastObservedTick + 1)
~~~

declared duration は使わない。

## Aggregation

大量packetを1 event = 1 nodeにはしない。

次のtupleで集約する。

~~~text
stage + packet + direction + channel + physicalSide
~~~

各 runtime_network_observation は observationCount、first/lastGameTime、
first/lastTick、thread samples、sequence samples を持つ。

## Static join

packet class:

~~~text
runtime_network_observation
   --OBSERVED_PACKET_SEND/RECEIVE-->
network_message
~~~

fully-qualified class名の末尾を static analyzer の packet class key と合わせる。

channelがruntime eventにある場合:

~~~text
runtime_network_observation
   --OBSERVED_ON_NETWORK_CHANNEL-->
network_channel(resourceId)
~~~

static channelが見つからない場合だけ runtime_network_channel unresolved nodeを作る。
存在しないstatic channelを捏造しない。directionも共有 network_direction nodeへ接続する。

## Send and receive are independent facts

最重要ルール:

~~~text
OBSERVED_PACKET_SEND != OBSERVED_PACKET_RECEIVE
~~~

sendを観測してもreceive edgeは作らない。

~~~text
N0 Static packet registration  observed
N1 Runtime packet send         observed
N2 Runtime packet receive      unobserved
~~~

なら、「static registration と実送信までは証拠があるが、受信境界の証拠はこのscanに無い」
とだけ言う。packet loss や client failure までは自動断定しない。

## Delivery matrix

Viewerに3段階を出す。

- N0 static packet registration
- N1 runtime packet send
- N2 runtime packet receive

statusは observed / unobserved。unobserved != failed。
client JVM にprobeが無い場合でもN2はunobservedになるため。

## Diagnostic chain

~~~text
Server state
  ↓
registered packet
  ↓
OBSERVED_PACKET_SEND
  ↓
OBSERVED_PACKET_RECEIVE
  ↓
client handler
  ↓
runtime Molang / animation
  ↓
bone TRS
  ↓
rendered vertices
~~~

まで同じCommon Graph IRで確認できる。

現時点ではnetwork eventと後続Molang eventの「同一packetが直接そのMolangを起こした」という因果edgeは、
専用correlation idが無いため捏造しない。
