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
stage + packet + direction + channel + physicalSide + payloadFingerprint
~~~

各 runtime_network_observation は observationCount、first/lastGameTime、
first/lastTick、thread samples、sequence samples と、最大5件の shallow payload sample を持つ。

payload は KNEEKURA-LAB が public scalar field だけを採ったものなので、CODE-LAB は nested object を受け付けない。
String payload のうち field 名が `molang` / `expression` / `expr` 系で、かつ Molang token を実際に含むものだけを既存の alias 正規化へ通して共有 molang_variable に接続する。説明文や note に偶然 `v.foo` が含まれても Molang evidence にはしない。

~~~text
runtime_network_observation
   --OBSERVED_PACKET_PAYLOAD_MOLANG-->
molang_variable(variable.wuqi)
~~~

edge は stage=send/receive、field名、first/lastTick、observationCount、式sampleを保持する。
同じ packet class / direction / channel でも payload が違えば別 `runtime_network_observation` に分ける。たとえば `v.wuqi=0` と `v.wuqi=1` は同じ ReimuSpellCardMolangPacket でも混ぜない。同一payloadの反復だけ observationCount へ集約する。

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

packet payload に含まれていた Molang については、OBSERVED_PACKET_PAYLOAD_MOLANG により
「このsend/receive観測がこの変数を運んだ」ことを直接evidence化する。

KNEEKURA-LAB の net_semantic 行がある場合は、その後段も別事実として重ねる。

~~~text
OBSERVED_MOLANG_HANDLER_EXECUTION
  = ReimuSpellCardMolangHandler.execute へ実際に到達

OBSERVED_YSM_MOLANG_COMMAND_DISPATCH
  = ysmclient molang execute ... を sendCommand() へ渡し、例外なく戻った

OBSERVED_YSM_MOLANG_COMMAND_FAILURE
  = 同じ command dispatch 経路が例外で失敗

OBSERVED_YSM_CLIENT_COMMAND_HANDLED
  = Forge ClientCommandHandler.runCommand() が true を返し、client command path が consume

OBSERVED_YSM_CLIENT_COMMAND_FALLBACK
  = 同メソッドが false を返し、server command へフォールバックする経路

OBSERVED_YSM_MOLANG_COMMAND_PRE_DISPATCH
  = sendCommand() 直前の診断境界。成功を意味しない

OBSERVED_YSM_STATE_CORRELATED
  = post-state が命令値と相関した弱い証拠。M6 ではない

OBSERVED_YSM_MOLANG_STATE_APPLIED
  = controlled E2 認定済みの同一 runtime candidate が actual packet chain 上で
    pre-dispatch 値から命令値へ変化した直接 runtime evidence
~~~

### Molang transport matrix

各 molang_variable ごとに M0〜M6 を作る。

~~~text
M0 runtime Molang intent
M1 packet send carries Molang
M2 packet receive carries Molang
M3 client handler executed
M4 YSM command dispatched
M5 Forge client command consumed
M6 YSM Molang runtime state applied
~~~

status は observed / unobserved。途中が欠けていて後段だけ観測されても、欠けた段を補完しない。
たとえば M0 が無く M1〜M5 があれば observedThroughStage は none のまま、stageSummary だけが後段の観測を示す。

command failure は M4 success と別の evidence。failure が観測されても M4 を observed にしない。

M4 は「sendCommand() が例外なく戻った」までの証拠。
M5 は Forge の client command dispatcher がその command を consume した証拠で、false は server fallback evidence として別管理する。

ただし ClientCommandHandler.runCommand() は、一部のsyntax/runtime errorをclient側で処理した場合も true で戻る。
したがって M5 でも YSM内部のMolang evaluatorが最終的に値を適用したことまでは証明しない。

M6 は `ysm_molang_state_applied` semantic が実際に存在する場合だけ observed。
M5 から推測補完しない。既存の M5=true fixture でも M6 は unobserved のままになる。

正式M6のproducerが出す `packetTraceIds` もedge evidenceとして保持する。M3側の
`packetTraceId` とpre-dispatch/M6側のIDを辿れば、同じ式が繰り返された場合でも
「どのpacket handler由来か」を診断できる。ただしCODE-LAB側でIDを補完・推測はしない。

また `ysm_state_correlated` は、post-state が一致したが controlled E2 資格や
pre→post の因果証明が不足した弱い証拠なので、`OBSERVED_YSM_STATE_CORRELATED` として保持するだけで
M6 に昇格させない。

したがって、

~~~text
M5 observed
M6 unobserved
~~~

は正常な診断結果であり、「YSM state apply failure」と自動断定しない。


## Payload fingerprint

payload は key 名をソートした canonical JSON を SHA-1 で短縮し、16桁 fingerprint にする。
fingerprint は grouping / runtime observation identity にのみ使い、元payload sample自体も別途保持する。

目的は「同じpacket classだから同じ意味」と誤って潰さないこと。cryptographic security のための識別子ではない。
