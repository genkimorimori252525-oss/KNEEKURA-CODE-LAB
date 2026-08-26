package demo.net;

import net.minecraft.resources.ResourceLocation;
import net.minecraftforge.network.NetworkRegistry;
import net.minecraftforge.network.simple.SimpleChannel;

public final class BuilderNetworkFixture {
  private static final String PROTOCOL = "1";
  public static final SimpleChannel CHANNEL = NetworkRegistry.newSimpleChannel(
      new ResourceLocation("demo", "reimu_net"),
      () -> PROTOCOL,
      PROTOCOL::equals,
      PROTOCOL::equals
  );
  private static int id = 0;

  public static void init() {
    CHANNEL.messageBuilder(ReimuPacket.class, id++)
        .encoder(ReimuPacket::encode)
        .decoder(ReimuPacket::decode)
        .consumerMainThread(ReimuPacket::handle)
        .add();
  }
}
