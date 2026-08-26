package demo.net;

import net.minecraft.resources.ResourceLocation;
import net.minecraftforge.network.NetworkDirection;
import net.minecraftforge.network.NetworkRegistry;
import net.minecraftforge.network.PacketDistributor;
import net.minecraftforge.network.simple.SimpleChannel;
import java.util.Optional;

public final class NetworkFixture {
  private static final String VERSION = "1.0";
  public static final SimpleChannel CHANNEL = NetworkRegistry.newSimpleChannel(
      new ResourceLocation("demo", "network"),
      () -> VERSION,
      VERSION::equals,
      VERSION::equals
  );

  public static void init() {
    CHANNEL.registerMessage(7, ClientPacket.class, ClientPacket::encode, ClientPacket::decode, ClientPacket::handle,
        Optional.of(NetworkDirection.PLAY_TO_CLIENT));
    CHANNEL.registerMessage(8, ServerPacket.class, ServerPacket::encode, ServerPacket::decode, ServerPacket::handle,
        Optional.of(NetworkDirection.PLAY_TO_SERVER));
  }

  public static void sendTracking(Object entity) {
    CHANNEL.send(PacketDistributor.TRACKING_ENTITY.with(() -> entity), new ClientPacket("variable.wuqi"));
  }

  public static void sendServer() {
    CHANNEL.sendToServer(new ServerPacket(42));
  }
}
