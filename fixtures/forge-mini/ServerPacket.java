package demo.net;

import net.minecraft.network.FriendlyByteBuf;
import net.minecraftforge.network.NetworkEvent;
import java.util.function.Supplier;

public final class ServerPacket {
  private final int value;
  public ServerPacket(int value) { this.value = value; }

  public static void encode(ServerPacket pkt, FriendlyByteBuf buf) {
    buf.writeInt(pkt.value);
  }

  public static ServerPacket decode(FriendlyByteBuf buf) {
    return new ServerPacket(buf.readInt());
  }

  public static void handle(ServerPacket pkt, Supplier<NetworkEvent.Context> ctx) {
    ctx.get().setPacketHandled(true);
  }
}
