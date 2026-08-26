package demo.mod;

import net.minecraft.world.entity.Entity;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin({ Entity.class })
public abstract class DeepMixin {
  @Inject(
      method = { "tick", "move" },
      at = @At(
          value = "INVOKE",
          target = "Lnet/minecraft/world/entity/Entity;setPos(DDD)V",
          ordinal = 1,
          shift = At.Shift.AFTER
      ),
      cancellable = true
  )
  private void kneekura$afterMove(CallbackInfo ci) {}
}
