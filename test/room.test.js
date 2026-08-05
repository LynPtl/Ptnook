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

describe("斗地主 发起与加入", () => {
  it("三人加入后进入叫分并各收到手牌", async () => {
    const a = await openWSCollect("ddz1", "A");
    a.ws.send(JSON.stringify({ type: "ddz_start" }));
    await new Promise((r) => setTimeout(r, 80));
    const b = await openWSCollect("ddz1", "B");
    b.ws.send(JSON.stringify({ type: "ddz_join" }));
    await new Promise((r) => setTimeout(r, 60));
    const c = await openWSCollect("ddz1", "C");
    c.ws.send(JSON.stringify({ type: "ddz_join" }));
    await new Promise((r) => setTimeout(r, 120));

    const stateA = a.msgs.filter((m) => m.type === "ddz_state").pop();
    const handA = a.msgs.filter((m) => m.type === "ddz_hand").pop();
    expect(stateA.phase).toBe("bidding");
    expect(stateA.seats.length).toBe(3);
    expect(handA.cards.length).toBe(17);
    a.ws.close(); b.ws.close(); c.ws.close();
  });
});

describe("斗地主 出牌校验", () => {
  it("未轮到你出牌被拒", async () => {
    const a = await openWSCollect("ddz2", "A");
    a.ws.send(JSON.stringify({ type: "ddz_start" }));
    await new Promise((r) => setTimeout(r, 60));
    const b = await openWSCollect("ddz2", "B");
    b.ws.send(JSON.stringify({ type: "ddz_join" }));
    await new Promise((r) => setTimeout(r, 50));
    const c = await openWSCollect("ddz2", "C");
    c.ws.send(JSON.stringify({ type: "ddz_join" }));
    await new Promise((r) => setTimeout(r, 100));
    // 叫分：A 叫 3 直接当地主
    a.ws.send(JSON.stringify({ type: "ddz_bid", value: 3 }));
    await new Promise((r) => setTimeout(r, 100));
    // 现在地主是 A，轮到 A 出牌；B 试图出牌应被拒
    b.msgs.length = 0;
    b.ws.send(JSON.stringify({ type: "ddz_play", cards: ["3"] }));
    await new Promise((r) => setTimeout(r, 80));
    expect(b.msgs.some((m) => m.type === "ddz_error")).toBe(true);
    a.ws.close(); b.ws.close(); c.ws.close();
  });
});

describe("斗地主 散桌与再来一局", () => {
  async function toSettle(room) {
    const a = await openWSCollect(room, "A");
    a.ws.send(JSON.stringify({ type: "ddz_start" }));
    await new Promise((r) => setTimeout(r, 50));
    const b = await openWSCollect(room, "B");
    b.ws.send(JSON.stringify({ type: "ddz_join" }));
    await new Promise((r) => setTimeout(r, 40));
    const c = await openWSCollect(room, "C");
    c.ws.send(JSON.stringify({ type: "ddz_join" }));
    await new Promise((r) => setTimeout(r, 90));
    return { a, b, c };
  }
  it("散桌后再发起是全新牌局", async () => {
    const { a, b, c } = await toSettle("ddz3");
    a.ws.send(JSON.stringify({ type: "ddz_disband" }));
    await new Promise((r) => setTimeout(r, 80));
    a.msgs.length = 0;
    a.ws.send(JSON.stringify({ type: "ddz_start" }));
    await new Promise((r) => setTimeout(r, 80));
    const st = a.msgs.filter((m) => m.type === "ddz_state").pop();
    expect(st.phase).toBe("waiting");
    expect(st.seats.length).toBe(1);
    a.ws.close(); b.ws.close(); c.ws.close();
  });
});

describe("斗地主 修复项", () => {
  async function fill(room) {
    const a = await openWSCollect(room, "A");
    a.ws.send(JSON.stringify({ type: "ddz_start" }));
    await new Promise((r) => setTimeout(r, 50));
    const b = await openWSCollect(room, "B");
    b.ws.send(JSON.stringify({ type: "ddz_join" }));
    await new Promise((r) => setTimeout(r, 40));
    const c = await openWSCollect(room, "C");
    c.ws.send(JSON.stringify({ type: "ddz_join" }));
    await new Promise((r) => setTimeout(r, 100));
    return { a, b, c };
  }

  it("再来一局首叫按座位轮换（注入状态直接验证）", async () => {
    const room = "fix-rotate2";
    const a = await openWSCollect(room, "A");
    a.ws.send(JSON.stringify({ type: "ddz_start" }));
    await new Promise((r) => setTimeout(r, 50));
    const b = await openWSCollect(room, "B");
    b.ws.send(JSON.stringify({ type: "ddz_join" }));
    await new Promise((r) => setTimeout(r, 40));
    const c = await openWSCollect(room, "C");
    c.ws.send(JSON.stringify({ type: "ddz_join" }));
    await new Promise((r) => setTimeout(r, 100));

    const id = env.CHAT_ROOM.idFromName(room);
    const stub = env.CHAT_ROOM.get(id);
    await runInDurableObject(stub, async (instance, state) => {
      const g = await state.storage.get("ddz");
      const players = g.players; // 座位顺序
      // 首局：firstBidIndex 应为 0 → 首叫为 players[0]
      g.firstBidIndex = 0;
      instance.startBidding(g);
      expect(g.bidTurn).toBe(players[0]);
      // 模拟一次“再来一局”的轮换：firstBidIndex 前进后再发牌
      g.firstBidIndex = (g.firstBidIndex + 1) % 3;
      instance.startBidding(g);
      expect(g.bidTurn).toBe(players[1]);
      // 再轮换一次 → players[2]
      g.firstBidIndex = (g.firstBidIndex + 1) % 3;
      instance.startBidding(g);
      expect(g.bidTurn).toBe(players[2]);
      // 再一次回到 players[0]
      g.firstBidIndex = (g.firstBidIndex + 1) % 3;
      instance.startBidding(g);
      expect(g.bidTurn).toBe(players[0]);
    });
    a.ws.close(); b.ws.close(); c.ws.close();
  });

  it("散桌无战绩不发榜、有战绩发榜（通过状态构造）", async () => {
    const { a, b, c } = await fill("fix-board");
    a.msgs.length = 0;
    // 尚未结算任何一局 → scores 全 0/空 → 散桌不应出现“本桌战绩”
    a.ws.send(JSON.stringify({ type: "ddz_disband" }));
    await new Promise((r) => setTimeout(r, 80));
    const chats = a.msgs.filter((m) => m.type === "system").map((m) => m.text).join("\n");
    expect(chats).not.toContain("本桌战绩");
    a.ws.close(); b.ws.close(); c.ws.close();
  });

  it("有非零战绩时散桌广播排行榜（注入 scores）", async () => {
    const room = "fix-board2";
    const a = await openWSCollect(room, "A");
    a.ws.send(JSON.stringify({ type: "ddz_start" }));
    await new Promise((r) => setTimeout(r, 50));
    const b = await openWSCollect(room, "B");
    b.ws.send(JSON.stringify({ type: "ddz_join" }));
    await new Promise((r) => setTimeout(r, 40));
    const c = await openWSCollect(room, "C");
    c.ws.send(JSON.stringify({ type: "ddz_join" }));
    await new Promise((r) => setTimeout(r, 100));

    const id = env.CHAT_ROOM.idFromName(room);
    const stub = env.CHAT_ROOM.get(id);
    await runInDurableObject(stub, async (instance, state) => {
      const g = await state.storage.get("ddz");
      g.scores = { A: 6, B: -6, C: 0 };
      await state.storage.put("ddz", g);
    });
    a.msgs.length = 0;
    a.ws.send(JSON.stringify({ type: "ddz_disband" }));
    await new Promise((r) => setTimeout(r, 80));
    const chats = a.msgs.filter((m) => m.type === "system").map((m) => m.text).join("\n");
    expect(chats).toContain("本桌战绩");
    expect(chats).toContain("A");
    a.ws.close(); b.ws.close(); c.ws.close();
  });
});

describe("斗地主 提示", () => {
  async function fill(room) {
    const a = await openWSCollect(room, "A");
    a.ws.send(JSON.stringify({ type: "ddz_start" }));
    await new Promise((r) => setTimeout(r, 50));
    const b = await openWSCollect(room, "B");
    b.ws.send(JSON.stringify({ type: "ddz_join" }));
    await new Promise((r) => setTimeout(r, 40));
    const c = await openWSCollect(room, "C");
    c.ws.send(JSON.stringify({ type: "ddz_join" }));
    await new Promise((r) => setTimeout(r, 100));
    return { a, b, c };
  }

  it("轮到自己时提示返回一手能压过的牌", async () => {
    const room = "hint-ok";
    const { a, b, c } = await fill(room);
    const id = env.CHAT_ROOM.idFromName(room);
    const stub = env.CHAT_ROOM.get(id);
    await runInDurableObject(stub, async (instance, state) => {
      const g = await state.storage.get("ddz");
      g.phase = "playing";
      g.current = "A";
      g.hands["A"] = ["3", "6", "6", "9"];
      g.lastPlay = { nick: "B", cards: ["5"], type: "single" };
      await state.storage.put("ddz", g);
    });
    a.msgs.length = 0;
    a.ws.send(JSON.stringify({ type: "ddz_hint" }));
    await new Promise((r) => setTimeout(r, 80));
    const hint = a.msgs.filter((m) => m.type === "ddz_hint").pop();
    expect(hint).toBeDefined();
    // 新度量：跟单5时优先不拆 66 对，出孤张 9（保留成型对） → ["9"]
    expect(hint.cards).toEqual(["9"]);
    a.ws.close(); b.ws.close(); c.ws.close();
  });

  it("要不起时提示只能过", async () => {
    const room = "hint-none";
    const { a, b, c } = await fill(room);
    const id = env.CHAT_ROOM.idFromName(room);
    const stub = env.CHAT_ROOM.get(id);
    await runInDurableObject(stub, async (instance, state) => {
      const g = await state.storage.get("ddz");
      g.phase = "playing";
      g.current = "A";
      g.hands["A"] = ["3", "4"];
      g.lastPlay = { nick: "B", cards: ["2"], type: "single" };
      await state.storage.put("ddz", g);
    });
    a.msgs.length = 0;
    a.ws.send(JSON.stringify({ type: "ddz_hint" }));
    await new Promise((r) => setTimeout(r, 80));
    const err = a.msgs.filter((m) => m.type === "ddz_error").pop();
    expect(err).toBeDefined();
    expect(err.text).toContain("没有能压过的牌");
    a.ws.close(); b.ws.close(); c.ws.close();
  });

  it("提示：自由出时建议最小孤张", async () => {
    const room = "hint-lead";
    const a = await openWSCollect(room, "A");
    a.ws.send(JSON.stringify({ type: "ddz_start" }));
    await new Promise((r) => setTimeout(r, 50));
    const b = await openWSCollect(room, "B");
    b.ws.send(JSON.stringify({ type: "ddz_join" }));
    await new Promise((r) => setTimeout(r, 40));
    const c = await openWSCollect(room, "C");
    c.ws.send(JSON.stringify({ type: "ddz_join" }));
    await new Promise((r) => setTimeout(r, 100));
    const id = env.CHAT_ROOM.idFromName(room);
    const stub = env.CHAT_ROOM.get(id);
    await runInDurableObject(stub, async (instance, state) => {
      const g = await state.storage.get("ddz");
      g.phase = "playing"; g.current = "A";
      g.hands["A"] = ["3", "8", "8", "9", "9", "9"];
      g.lastPlay = null; // 自由出
      await state.storage.put("ddz", g);
    });
    a.msgs.length = 0;
    a.ws.send(JSON.stringify({ type: "ddz_hint" }));
    await new Promise((r) => setTimeout(r, 80));
    const hint = a.msgs.filter((m) => m.type === "ddz_hint").pop();
    expect(hint.cards).toEqual(["3"]);
    a.ws.close(); b.ws.close(); c.ws.close();
  });
});
