package demo.net;

import net.minecraft.network.FriendlyByteBuf;
import net.minecraftforge.network.NetworkEvent;
import java.util.function.Supplier;

public final class ReimuPacket {
  private final String expr;
  public ReimuPacket(String expr) { this.expr = expr; }

  public static void encode(ReimuPacket pkt, FriendlyByteBuf buf) {
    buf.writeUtf(pkt.expr);
  }

  public static ReimuPacket decode(FriendlyByteBuf buf) {
    return new ReimuPacket(buf.readUtf());
  }

  public static void handle(ReimuPacket pkt, Supplier<NetworkEvent.Context> ctx) {
    ctx.get().enqueueWork(() -> demo.net.client.ClientMolangHandler.execute(pkt.expr));
    ctx.get().setPacketHandled(true);
  }
}
