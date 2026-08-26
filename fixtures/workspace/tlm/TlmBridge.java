package demo.tlm;

public class TlmBridge {
  void syncVisuals() {
    host.sendSpellCardMolang("(v.wuqi = 1)");
    host.playReimuMaidAnimation("idle2", true);
  }

  private final Host host = new Host();
  static class Host {
    void sendSpellCardMolang(String expression) {}
    void playReimuMaidAnimation(String name, boolean force) {}
  }
}
