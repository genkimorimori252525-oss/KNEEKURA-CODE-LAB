# Forge 1.20.1 networking graph

この analyzer は Forge 1.20.1 / 47.x の `SimpleChannel` / SimpleImpl を第一級対象にする。

実TLM系コードで確認した2種類の登録様式を両方読む。

## Channel

```java
public static final SimpleChannel CHANNEL =
    NetworkRegistry.newSimpleChannel(...);
```

Graph:

```text
class
  --DECLARES_NETWORK_CHANNEL-->
network_channel
```

保持する主な情報:

- channel field
- ResourceLocation id / path
- protocol version
- API = SimpleChannel
- Forge profile compatibility

## registerMessage style

```java
CHANNEL.registerMessage(
    44,
    SyncYsmMaidDataMessage.class,
    SyncYsmMaidDataMessage::encode,
    SyncYsmMaidDataMessage::decode,
    SyncYsmMaidDataMessage::handle,
    Optional.of(NetworkDirection.PLAY_TO_CLIENT)
);
```

抽出:

- discriminator
- message class
- encoder / decoder / handler method references
- PLAY_TO_CLIENT / PLAY_TO_SERVER

## messageBuilder style

```java
CHANNEL.messageBuilder(ReimuSpellCardMolangPacket.class, id++)
    .encoder(ReimuSpellCardMolangPacket::encode)
    .decoder(ReimuSpellCardMolangPacket::decode)
    .consumerMainThread(ReimuSpellCardMolangPacket::handle)
    .add();
```

`consumerMainThread` も registration evidence として保持する。
dynamic discriminator は勝手に数値へ解決せず `id++` のまま残す。

## Packet implementation

`FriendlyByteBuf` + `NetworkEvent.Context` 型のpacket classでは:

```text
class
  --IMPLEMENTS_PACKET-->
network_message
      |
      +-- ENCODED_BY --> encode()
      +-- DECODED_BY --> decode()
      +-- HANDLED_BY --> handle()
```

`enqueueWork` があれば:

```text
handle()
  --ENQUEUES_NETWORK_WORK-->
Forge network main thread handoff
```

lambda内で明示的なclient targetを呼ぶ場合は
`DISPATCHES_NETWORK_HANDLER` を張る。

## Send sites

次を読む。

- `CHANNEL.send(PacketDistributor...., new Packet(...))`
- `CHANNEL.sendToServer(new Packet(...))`

例:

```text
network_send_site
  --USES_NETWORK_CHANNEL--> channel
  --DISTRIBUTES_TO--------> TRACKING_ENTITY
  --SENDS_PACKET----------> ReimuSpellCardMolangPacket
```

## Common setup bootstrap

```java
event.enqueueWork(ReimuNet::init);
```

は:

```text
NetworkBootstrap
  --SCHEDULES_NETWORK_INIT-->
ReimuNet::init
  <--IMPLEMENTS_NETWORK_INIT--
ReimuNet.init()
```

として結ぶ。

## Diagnostic path for YSM/TLM

目標経路:

```text
server state
  -> packet registration
  -> packet send
  -> PLAY_TO_CLIENT
  -> handle()
  -> enqueueWork
  -> client handler
  -> Molang / animation
  -> bone TRS
  -> rendered vertices
```

現在のnetwork analyzerは静的evidence。
「実際にpacketがwireを通った」ことはまだruntime network traceでは証明しない。
将来は packet runtime evidence を別edgeとして重ねる。

## Conservative rules

- dynamic message ID は推測して固定値にしない
- ResourceLocation namespace が定数式で解決できなければ expression のまま残す
- direction 未指定を勝手に client/serverへ分類しない
- 1.20.1以外は profile compatibility を残して best-effort と明示する
