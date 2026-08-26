package demo.mod;
import net.minecraftforge.eventbus.api.SubscribeEvent;
import net.minecraftforge.registries.DeferredRegister;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraftforge.fml.common.Mod;

@Mod("demo")
public class MainMod {
  static final Object ENTITIES = DeferredRegister.create(BuiltInRegistries.ENTITY_TYPE, "demo");
  @SubscribeEvent
  public void onTick(Object event) {}
}
