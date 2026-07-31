import { env, SELF, runInDurableObject } from "cloudflare:test";
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

async function openWSCollect(room, nick) {
  const url = `https://example.com/room/${room}?nick=${encodeURIComponent(nick)}`;
  const res = await SELF.fetch(url, { headers: { Upgrade: "websocket" } });
  const ws = res.webSocket;
  const msgs = [];
  ws.addEventListener("message", (e) => { msgs.push(JSON.parse(e.data)); });
  ws.accept();
  return { ws, msgs };
}

describe("ChatRoom", () => {
  it("加入广播 system + presence", async () => {
    const a = await openWS("r1", "小明");
    const msgs = [];
    a.addEventListener("message", (e) => { msgs.push(JSON.parse(e.data)); });
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
    const chat = await new Promise((resolve) => {
      b.addEventListener("message", (e) => {
        const m = JSON.parse(e.data);
        if (m.type === "chat") resolve(m);
      });
      a.send(JSON.stringify({ type: "chat", text: "hello2" }));
    });
    expect(chat.nick).toBe("A");
    expect(chat.text).toBe("hello2");
    a.close();
    b.close();
  });

  it("非法消息被忽略不崩溃", async () => {
    const a = await openWS("r3", "A");
    a.send("garbage-not-json");
    a.send(JSON.stringify({ type: "chat", text: "   " }));
    const b = await openWS("r3", "B");
    await new Promise((r) => setTimeout(r, 100));
    const chat = await new Promise((resolve) => {
      b.addEventListener("message", (e) => {
        const m = JSON.parse(e.data);
        if (m.type === "chat") resolve(m);
      });
      a.send(JSON.stringify({ type: "chat", text: "ok" }));
    });
    expect(chat.text).toBe("ok");
    a.close();
    b.close();
  });
});

describe("ChatRoom 历史", () => {
  it("新连接先收到 history 再收到加入 system", async () => {
    const { ws, msgs } = await openWSCollect("hist-order", "A");
    await new Promise((r) => setTimeout(r, 150));
    const historyIdx = msgs.findIndex((m) => m.type === "history");
    const joinIdx = msgs.findIndex((m) => m.type === "system");
    expect(historyIdx).toBeGreaterThanOrEqual(0);
    expect(joinIdx).toBeGreaterThan(historyIdx);
    expect(Array.isArray(msgs[historyIdx].items)).toBe(true);
    ws.close();
  });

  it("后进者能在 history 中看到先前的消息", async () => {
    const a = await openWS("hist-see", "A");
    await new Promise((r) => setTimeout(r, 100));
    a.send(JSON.stringify({ type: "chat", text: "old-msg" }));
    await new Promise((r) => setTimeout(r, 150));
    const { ws: b, msgs } = await openWSCollect("hist-see", "B");
    await new Promise((r) => setTimeout(r, 150));
    const hist = msgs.find((m) => m.type === "history");
    expect(hist).toBeDefined();
    expect(hist.items.some((it) => it.text === "old-msg" && it.nick === "A")).toBe(true);
    a.close();
    b.close();
  });

  it("history 上限 50 条且保留最新", async () => {
    const a = await openWS("hist-cap", "A");
    await new Promise((r) => setTimeout(r, 100));
    for (let i = 0; i < 55; i++) {
      a.send(JSON.stringify({ type: "chat", text: "msg-" + i }));
      await new Promise((r) => setTimeout(r, 15));
    }
    await new Promise((r) => setTimeout(r, 150));
    const { ws: b, msgs } = await openWSCollect("hist-cap", "B");
    await new Promise((r) => setTimeout(r, 200));
    const hist = msgs.find((m) => m.type === "history");
    expect(hist.items.length).toBe(50);
    expect(hist.items[49].text).toBe("msg-54");
    expect(hist.items[0].text).toBe("msg-5");
    a.close();
    b.close();
  });
});

describe("ChatRoom 空房清除", () => {
  it("alarm 在空房时清除历史", async () => {
    const id = env.CHAT_ROOM.idFromName("alarm-empty");
    const stub = env.CHAT_ROOM.get(id);
    await runInDurableObject(stub, async (instance, state) => {
      await state.storage.put("history", [{ nick: "A", text: "x", ts: 1 }]);
      await instance.alarm();
      expect(await state.storage.get("history")).toBeUndefined();
    });
  });

  it("alarm 在有人在线时保留历史", async () => {
    const { ws } = await openWSCollect("alarm-busy", "A");
    await new Promise((r) => setTimeout(r, 120));
    const id = env.CHAT_ROOM.idFromName("alarm-busy");
    const stub = env.CHAT_ROOM.get(id);
    await runInDurableObject(stub, async (instance, state) => {
      await state.storage.put("history", [{ nick: "A", text: "keep", ts: 1 }]);
      await instance.alarm();
      const h = await state.storage.get("history");
      expect(h).toBeDefined();
      expect(h.length).toBe(1);
    });
    ws.close();
  });

  it("空房后设清除闹钟，重新进入则取消", async () => {
    const { ws } = await openWSCollect("alarm-set", "A");
    await new Promise((r) => setTimeout(r, 120));
    ws.close();
    await new Promise((r) => setTimeout(r, 200));
    const id = env.CHAT_ROOM.idFromName("alarm-set");
    const stub = env.CHAT_ROOM.get(id);
    let scheduled;
    await runInDurableObject(stub, async (instance, state) => {
      scheduled = await state.storage.getAlarm();
    });
    expect(scheduled).not.toBeNull();

    const { ws: ws2 } = await openWSCollect("alarm-set", "B");
    await new Promise((r) => setTimeout(r, 120));
    await runInDurableObject(stub, async (instance, state) => {
      expect(await state.storage.getAlarm()).toBeNull();
    });
    ws2.close();
  });
});
