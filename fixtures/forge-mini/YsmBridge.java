package demo.mod;

public class YsmBridge {
  void syncVisuals() {
    host.sendSpellCardMolang("(v.wuqi = 1)");
    host.playReimuMaidAnimation("idle2", true);
    host.setPendingAnimationDispatch("use_offhand:bow");
  }

  private final Host host = new Host();
  static class Host {
    void sendSpellCardMolang(String expression) {}
    void playReimuMaidAnimation(String name, boolean force) {}
    void setPendingAnimationDispatch(String name) {}
  }
}
