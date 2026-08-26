package demo.net;

import net.minecraftforge.fml.event.lifecycle.FMLCommonSetupEvent;

public final class NetworkBootstrap {
  public static void onCommonSetup(FMLCommonSetupEvent event) {
    event.enqueueWork(BuilderNetworkFixture::init);
  }
}
