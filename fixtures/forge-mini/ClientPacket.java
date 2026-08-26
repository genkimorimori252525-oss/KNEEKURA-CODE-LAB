package demo.net;

import net.minecraft.network.FriendlyByteBuf;
import net.minecraftforge.network.NetworkEvent;
import java.util.function.Supplier;

public final class ClientPacket {
  private final String expr;
  public ClientPacket(String expr) { this.expr = expr; }

  public static void encode(ClientPacket pkt, FriendlyByteBuf buf) {
    buf.writeUtf(pkt.expr);
  }

  public static ClientPacket decode(FriendlyByteBuf buf) {
    return new ClientPacket(buf.readUtf());
  }

  public static void handle(ClientPacket pkt, Supplier<NetworkEvent.Context> ctx) {
    ctx.get().enqueueWork(() -> demo.net.client.ClientMolangHandler.execute(pkt.expr));
    ctx.get().setPacketHandled(true);
  }
}
