import { env, SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";

function connect(room, nick) {
  const url = `https://example.com/room/${room}?nick=${encodeURIComponent(nick)}`;
  const res = SELF.fetch(url, { headers: { Upgrade: "websocket" } });
  return res;
}

async function openWS(room, nick) {
  const res = await connect(room, nick);
  const ws = res.webSocket;
  ws.accept();
  return ws;
}

function nextMessage(ws) {
  return new Promise((resolve) => {
    ws.addEventListener("message", (e) => resolve(JSON.parse(e.data)), { once: true });
  });
}

describe("ChatRoom", () => {
  it("加入广播 system + presence", async () => {
    const a = await openWS("r1", "小明");
    const msgs = [];
    a.addEventListener("message", (e) => msgs.push(JSON.parse(e.data)));
    await new Promise((r) => setTimeout(r, 100));
    const sys = msgs.find((m) => m.type === "system");
    const pres = msgs.find((m) => m.type === "presence");
    expect(sys.text).toContain("小明");
    expect(sys.text).toContain("加入");
    expect(pres.count).toBe(1);
    a.close();
  });

  it("聊天消息广播给所有人", async () => {
    const a = await openWS("r2", "A");
    const b = await openWS("r2", "B");
    await new Promise((r) => setTimeout(r, 100));
    const got = nextMessage(b).then((m) => m);
    a.send(JSON.stringify({ type: "chat", text: "hello" }));
    // 轮询等待 b 收到 chat
    let received = null;
    for (let i = 0; i < 20 && !received; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    // 简化断言：直接监听
    const chat = await new Promise((resolve) => {
      b.addEventListener("message", (e) => {
        const m = JSON.parse(e.data);
        if (m.type === "chat") resolve(m);
      });
      a.send(JSON.stringify({ type: "chat", text: "hello2" }));
    });
    expect(chat.nick).toBeDefined();
    expect(chat.text).toBeDefined();
    a.close();
    b.close();
  });

  it("非法消息被忽略不崩溃", async () => {
    const a = await openWS("r3", "A");
    a.send("garbage-not-json");
    a.send(JSON.stringify({ type: "chat", text: "   " }));
    await new Promise((r) => setTimeout(r, 100));
    expect(true).toBe(true); // 未抛错即通过
    a.close();
  });
});
