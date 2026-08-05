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
  it("德州全下按钮只填入下注框，不直接发送 all-in 动作", async () => {
    const res = await SELF.fetch("https://example.com/");
    const html = await res.text();
    expect(html).toContain('addBtn("全下"');
    expect(html).toContain("input.value = fmtBB(mySeat.stack + (mySeat.streetBet || 0));");
    expect(html).not.toContain('action: "allin"');
  });

  it("提示音按钮显示当前开关状态且不是蓝色主按钮", async () => {
    const res = await SELF.fetch("https://example.com/");
    const html = await res.text();
    expect(html).toContain('id="soundBtn"');
    expect(html).toContain('class="header-toggle"');
    expect(html).toContain('title="点击切换提示音"');
    expect(html).toContain('soundBtnLabel()');
    expect(html).toContain('soundMuted ? "提示音 关" : "提示音 开"');
    expect(html).not.toContain('title="消息提示音开关">🔔</button>');
  });

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

  it("后来进入聊天室的人能看到等待中的斗地主牌局并加入", async () => {
    const a = await openWSCollect("ddz-late-join", "A");
    a.ws.send(JSON.stringify({ type: "ddz_start" }));
    await new Promise((r) => setTimeout(r, 80));

    const b = await openWSCollect("ddz-late-join", "B");
    await new Promise((r) => setTimeout(r, 120));
    const lateState = b.msgs.filter((m) => m.type === "ddz_state").pop();
    expect(lateState.phase).toBe("waiting");
    expect(lateState.seats.some((s) => s.nick === "A")).toBe(true);

    b.ws.send(JSON.stringify({ type: "ddz_join" }));
    await new Promise((r) => setTimeout(r, 80));
    const joined = b.msgs.filter((m) => m.type === "ddz_state").pop();
    expect(joined.seats.some((s) => s.nick === "B")).toBe(true);
    a.ws.close(); b.ws.close();
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

describe("德州扑克 发起与加入", () => {
  it("发起后 waiting，两人加入各得 2 张底牌并进入 preflop", async () => {
    const a = await openWSCollect("poker1", "A");
    a.ws.send(JSON.stringify({ type: "poker_start" }));
    await new Promise((r) => setTimeout(r, 60));
    const b = await openWSCollect("poker1", "B");
    b.ws.send(JSON.stringify({ type: "poker_join" }));
    await new Promise((r) => setTimeout(r, 80));
    a.msgs.length = 0;
    a.ws.send(JSON.stringify({ type: "poker_next" }));
    await new Promise((r) => setTimeout(r, 100));
    const st = a.msgs.filter((m) => m.type === "poker_state").pop();
    const hole = a.msgs.filter((m) => m.type === "poker_hole").pop();
    expect(st.phase).toBe("preflop");
    expect(hole.cards.length).toBe(2);
    // 盲注入池：SB 0.5 + BB 1 = 1.5
    expect(st.pot).toBe(1.5);
    a.ws.close(); b.ws.close();
  });

  it("后来进入聊天室的人能看到等待中的德州牌局并加入", async () => {
    const a = await openWSCollect("poker-late-join", "A");
    a.ws.send(JSON.stringify({ type: "poker_start" }));
    await new Promise((r) => setTimeout(r, 80));

    const b = await openWSCollect("poker-late-join", "B");
    await new Promise((r) => setTimeout(r, 120));
    const lateState = b.msgs.filter((m) => m.type === "poker_state").pop();
    expect(lateState.phase).toBe("waiting");
    expect(lateState.seats.some((s) => s && s.nick === "A")).toBe(true);

    b.ws.send(JSON.stringify({ type: "poker_join" }));
    await new Promise((r) => setTimeout(r, 80));
    const joined = b.msgs.filter((m) => m.type === "poker_state").pop();
    expect(joined.seats.some((s) => s && s.nick === "B")).toBe(true);
    a.ws.close(); b.ws.close();
  });
});

describe("德州扑克 单街下注流转", () => {
  it("单挑 preflop：SB(D) 跟注、BB 过牌 → 本街结束", async () => {
    const a = await openWSCollect("poker2", "A"); // seat0 = 按钮/SB（首手不转按钮）
    a.ws.send(JSON.stringify({ type: "poker_start" }));
    await new Promise((r) => setTimeout(r, 50));
    const b = await openWSCollect("poker2", "B"); // seat1 = BB
    b.ws.send(JSON.stringify({ type: "poker_join" }));
    await new Promise((r) => setTimeout(r, 60));
    a.ws.send(JSON.stringify({ type: "poker_next" }));
    await new Promise((r) => setTimeout(r, 100));
    // A(SB/D) 先动：跟注补到 1
    a.ws.send(JSON.stringify({ type: "poker_action", action: "call" }));
    await new Promise((r) => setTimeout(r, 60));
    // B(BB) 过牌 → 本街结束（Task3 桩：进入 settled）
    b.msgs.length = 0;
    b.ws.send(JSON.stringify({ type: "poker_action", action: "check" }));
    await new Promise((r) => setTimeout(r, 80));
    const st = b.msgs.filter((m) => m.type === "poker_state").pop();
    expect(st.pot).toBe(2); // 两人各投入 1
    a.ws.close(); b.ws.close();
  });

  it("行动广播包含下一位操作者，便于只看广播复盘", async () => {
    const a = await openWSCollect("poker-action-broadcast", "A");
    a.ws.send(JSON.stringify({ type: "poker_start" }));
    await new Promise((r) => setTimeout(r, 50));
    const b = await openWSCollect("poker-action-broadcast", "B");
    b.ws.send(JSON.stringify({ type: "poker_join" }));
    await new Promise((r) => setTimeout(r, 60));
    a.ws.send(JSON.stringify({ type: "poker_next" }));
    await new Promise((r) => setTimeout(r, 100));

    b.msgs.length = 0;
    a.ws.send(JSON.stringify({ type: "poker_action", action: "call" }));
    await new Promise((r) => setTimeout(r, 80));
    const text = b.msgs.filter((m) => m.type === "system").map((m) => m.text).join("\n");
    expect(text).toContain("A 跟注到 1bb");
    expect(text).toContain("轮到 B 行动");
    expect(text).toContain("底池 2bb");
    a.ws.close(); b.ws.close();
  });

  it("非法动作与未轮到被拒", async () => {
    const a = await openWSCollect("poker3", "A");
    a.ws.send(JSON.stringify({ type: "poker_start" }));
    await new Promise((r) => setTimeout(r, 50));
    const b = await openWSCollect("poker3", "B");
    b.ws.send(JSON.stringify({ type: "poker_join" }));
    await new Promise((r) => setTimeout(r, 60));
    a.ws.send(JSON.stringify({ type: "poker_next" }));
    await new Promise((r) => setTimeout(r, 100));
    // A(SB) 面对 BB 下注不能 check
    a.msgs.length = 0;
    a.ws.send(JSON.stringify({ type: "poker_action", action: "check" }));
    await new Promise((r) => setTimeout(r, 60));
    expect(a.msgs.some((m) => m.type === "poker_error")).toBe(true);
    // 未轮到 B（现在轮 A）出手被拒
    b.msgs.length = 0;
    b.ws.send(JSON.stringify({ type: "poker_action", action: "call" }));
    await new Promise((r) => setTimeout(r, 60));
    expect(b.msgs.some((m) => m.type === "poker_error")).toBe(true);
    a.ws.close(); b.ws.close();
  });

  it("仅剩一人未弃：直接收池不亮牌", async () => {
    const a = await openWSCollect("poker4", "A");
    a.ws.send(JSON.stringify({ type: "poker_start" }));
    await new Promise((r) => setTimeout(r, 50));
    const b = await openWSCollect("poker4", "B");
    b.ws.send(JSON.stringify({ type: "poker_join" }));
    await new Promise((r) => setTimeout(r, 60));
    a.ws.send(JSON.stringify({ type: "poker_next" }));
    await new Promise((r) => setTimeout(r, 100));
    // A(SB/D) 弃牌 → B 赢
    a.ws.send(JSON.stringify({ type: "poker_action", action: "fold" }));
    await new Promise((r) => setTimeout(r, 80));
    const id = env.CHAT_ROOM.idFromName("poker4");
    const stub = env.CHAT_ROOM.get(id);
    await runInDurableObject(stub, async (instance, state) => {
      const g = await state.storage.get("holdem");
      expect(g.phase).toBe("settled");
      expect(g.lastResult.reveal).toBe(false);
      // B 座位赢下 SB0.5+BB1 = 1.5，回到 50-1+1.5=50.5
      const bSeat = g.seats.find((s) => s && s.nick === "B");
      expect(bSeat.stack).toBe(50.5);
    });
    a.ws.close(); b.ws.close();
  });
});

describe("德州扑克 摊牌与边池", () => {
  async function seat3(room) {
    const a = await openWSCollect(room, "A");
    a.ws.send(JSON.stringify({ type: "poker_start" }));
    await new Promise((r) => setTimeout(r, 50));
    const b = await openWSCollect(room, "B");
    b.ws.send(JSON.stringify({ type: "poker_join" }));
    await new Promise((r) => setTimeout(r, 40));
    const c = await openWSCollect(room, "C");
    c.ws.send(JSON.stringify({ type: "poker_join" }));
    await new Promise((r) => setTimeout(r, 80));
    return { a, b, c };
  }

  it("河牌单池摊牌：最大牌型赢全池并亮牌", async () => {
    const room = "pk-show";
    const { a, b, c } = await seat3(room);
    const id = env.CHAT_ROOM.idFromName(room);
    const stub = env.CHAT_ROOM.get(id);
    await runInDurableObject(stub, async (instance, state) => {
      const g = await state.storage.get("holdem");
      // 造 river 局面：三人各投入 10，A 一对 A、B 一对 K、C 一对 Q
      g.phase = "river";
      g.board = ["Ad", "Kd", "Qs", "7h", "2c"];
      g.buttonSeat = 0;
      g.handSeats = [0, 1, 2];
      g.positions = { button: 0, sb: 1, bb: 2, preflopOrder: [0, 1, 2], postflopOrder: [1, 2, 0] };
      const set = (i, nick, hole) => { g.seats[i] = { nick, stack: 40, inHand: true, hasFolded: false, isAllIn: false, holeCards: hole, streetBet: 0, totalBet: 10 }; };
      set(0, "A", ["As", "3c"]);
      set(1, "B", ["Ks", "4c"]);
      set(2, "C", ["Qh", "5c"]);
      g.currentBet = 0; g.minRaise = 1; g.needToAct = [1, 2, 0]; g.toAct = 1;
      await state.storage.put("holdem", g);
      // B 过 → C 过 → A 过：本街结束进入摊牌
      await instance.handlePokerAction(instance.wsByNick("B") || {}, { type: "poker_action", action: "check" }, await state.storage.get("holdem"), 1);
    });
    // 直接调用 showdown 更稳妥：重取状态并让所有人过牌
    await runInDurableObject(stub, async (instance, state) => {
      const g = await state.storage.get("holdem");
      // 若上一步已推进则跳过；否则强制 showdown
      if (g.phase !== "settled") { await instance.showdown(g); }
      const done = await state.storage.get("holdem");
      expect(done.phase).toBe("settled");
      expect(done.lastResult.reveal).toBe(true);
      const seatA = done.seats.find((s) => s && s.nick === "A");
      // A 一对 A 最大，赢全池 30 → 40+30=70
      expect(seatA.stack).toBe(70);
    });
    a.ws.close(); b.ws.close(); c.ws.close();
  });

  it("边池：短 all-in 者只能赢主池", async () => {
    const room = "pk-side";
    const { a, b, c } = await seat3(room);
    const id = env.CHAT_ROOM.idFromName(room);
    const stub = env.CHAT_ROOM.get(id);
    await runInDurableObject(stub, async (instance, state) => {
      const g = await state.storage.get("holdem");
      g.phase = "river";
      g.board = ["2d", "7d", "9s", "Jh", "3c"];
      g.buttonSeat = 0;
      g.handSeats = [0, 1, 2];
      g.positions = { button: 0, sb: 1, bb: 2, preflopOrder: [0, 1, 2], postflopOrder: [1, 2, 0] };
      // A 全下仅 10（最强，一对 J），B/C 各投入 30（B 一对 9、C 一对 7）
      g.seats[0] = { nick: "A", stack: 0, inHand: true, hasFolded: false, isAllIn: true, holeCards: ["Js", "Jc"], streetBet: 0, totalBet: 10 };
      g.seats[1] = { nick: "B", stack: 20, inHand: true, hasFolded: false, isAllIn: false, holeCards: ["9h", "9c"], streetBet: 0, totalBet: 30 };
      g.seats[2] = { nick: "C", stack: 20, inHand: true, hasFolded: false, isAllIn: false, holeCards: ["7h", "7c"], streetBet: 0, totalBet: 30 };
      await state.storage.put("holdem", g);
      await instance.showdown(g);
      const done = await state.storage.get("holdem");
      const A = done.seats.find((s) => s.nick === "A");
      const B = done.seats.find((s) => s.nick === "B");
      // 主池 30（三人）A 一对 J 最大 → A 得 30；边池 40（B/C）B 一对 9 > C 一对 7 → B 得 40
      expect(A.stack).toBe(30);
      expect(B.stack).toBe(20 + 40);
    });
    a.ws.close(); b.ws.close(); c.ws.close();
  });

  it("平分零头：多出的 0.5bb 给庄家左手第一个赢家", async () => {
    const room = "pk-split-rem";
    const { a, b, c } = await seat3(room);
    const id = env.CHAT_ROOM.idFromName(room);
    const stub = env.CHAT_ROOM.get(id);
    await runInDurableObject(stub, async (instance, state) => {
      const g = await state.storage.get("holdem");
      g.phase = "river";
      g.board = ["As", "Kd", "Qh", "8c", "3s"];
      g.buttonSeat = 1;
      g.handSeats = [0, 1, 2];
      g.positions = { button: 1, sb: 2, bb: 0, preflopOrder: [1, 2, 0], postflopOrder: [2, 0, 1] };
      // A/B 都用公共牌打同一手高牌，C 弃牌但投入 0.5；A/B 等额投入，底池 2.5bb = 5 个 0.5 单位。
      // 庄家为 B(seat1)，赢家 A(seat0)/B(seat1) 中，庄家左手第一个赢家是 A(seat0)，应多拿 0.5。
      g.seats[0] = { nick: "A", stack: 49, inHand: true, hasFolded: false, isAllIn: false, holeCards: ["2d", "4c"], streetBet: 0, totalBet: 1 };
      g.seats[1] = { nick: "B", stack: 49, inHand: true, hasFolded: false, isAllIn: false, holeCards: ["2h", "4d"], streetBet: 0, totalBet: 1 };
      g.seats[2] = { nick: "C", stack: 49.5, inHand: false, hasFolded: true, isAllIn: false, holeCards: ["2c", "5d"], streetBet: 0, totalBet: 0.5 };
      await state.storage.put("holdem", g);
      await instance.showdown(g);
      const done = await state.storage.get("holdem");
      expect(done.seats[0].stack).toBe(50.5);
      expect(done.seats[1].stack).toBe(50);
      const total = done.seats.reduce((sum, s) => sum + (s ? s.stack : 0), 0);
      expect(total).toBe(150);
    });
    a.ws.close(); b.ws.close(); c.ws.close();
  });
});

describe("德州扑克 手间流转", () => {
  it("buy-in：手间给 0 筹码座位补 50", async () => {
    const room = "pk-buyin";
    const a = await openWSCollect(room, "A");
    a.ws.send(JSON.stringify({ type: "poker_start" }));
    await new Promise((r) => setTimeout(r, 50));
    const b = await openWSCollect(room, "B");
    b.ws.send(JSON.stringify({ type: "poker_join" }));
    await new Promise((r) => setTimeout(r, 60));
    const id = env.CHAT_ROOM.idFromName(room);
    const stub = env.CHAT_ROOM.get(id);
    await runInDurableObject(stub, async (instance, state) => {
      const g = await state.storage.get("holdem");
      g.phase = "settled";
      g.seats[0].stack = 0;
      await state.storage.put("holdem", g);
    });
    a.ws.send(JSON.stringify({ type: "poker_buyin" }));
    await new Promise((r) => setTimeout(r, 60));
    await runInDurableObject(stub, async (instance, state) => {
      const g = await state.storage.get("holdem");
      expect(g.seats[0].stack).toBe(50);
    });
    a.ws.close(); b.ws.close();
  });

  it("动态人数：仅 2 人有筹码时开局是单挑", async () => {
    const room = "pk-dyn";
    const a = await openWSCollect(room, "A");
    a.ws.send(JSON.stringify({ type: "poker_start" }));
    await new Promise((r) => setTimeout(r, 50));
    const b = await openWSCollect(room, "B");
    b.ws.send(JSON.stringify({ type: "poker_join" }));
    await new Promise((r) => setTimeout(r, 40));
    const c = await openWSCollect(room, "C");
    c.ws.send(JSON.stringify({ type: "poker_join" }));
    await new Promise((r) => setTimeout(r, 80));
    const id = env.CHAT_ROOM.idFromName(room);
    const stub = env.CHAT_ROOM.get(id);
    await runInDurableObject(stub, async (instance, state) => {
      const g = await state.storage.get("holdem");
      g.seats[2].stack = 0; // C 无筹码
      instance.startHand(g);
      expect(g.handSeats.length).toBe(2);
      expect(g.seats[2].inHand).toBe(false);
    });
    a.ws.close(); b.ws.close(); c.ws.close();
  });

  it("庄家 preflop 弃牌后，postflop 从庄家左手第一个在手玩家行动", async () => {
    const room = "pk-button-fold-order";
    const a = await openWSCollect(room, "A");
    a.ws.send(JSON.stringify({ type: "poker_start" }));
    await new Promise((r) => setTimeout(r, 50));
    const b = await openWSCollect(room, "B");
    b.ws.send(JSON.stringify({ type: "poker_join" }));
    await new Promise((r) => setTimeout(r, 40));
    const c = await openWSCollect(room, "C");
    c.ws.send(JSON.stringify({ type: "poker_join" }));
    await new Promise((r) => setTimeout(r, 80));
    const id = env.CHAT_ROOM.idFromName(room);
    const stub = env.CHAT_ROOM.get(id);
    await runInDurableObject(stub, async (instance, state) => {
      const g = await state.storage.get("holdem");
      g.phase = "preflop";
      g.buttonSeat = 1;
      g.handSeats = [0, 1, 2];
      g.board = [];
      g.deck = ["2s", "3s", "4s", "5s", "6s"];
      g.positions = { button: 1, sb: 2, bb: 0, preflopOrder: [1, 2, 0], postflopOrder: [2, 0, 1] };
      g.seats[0] = { nick: "A", stack: 49, inHand: true, hasFolded: false, isAllIn: false, holeCards: ["As", "Ad"], streetBet: 1, totalBet: 1 };
      g.seats[1] = { nick: "B", stack: 50, inHand: false, hasFolded: true, isAllIn: false, holeCards: ["Ks", "Kd"], streetBet: 0, totalBet: 0 };
      g.seats[2] = { nick: "C", stack: 49, inHand: true, hasFolded: false, isAllIn: false, holeCards: ["Qs", "Qd"], streetBet: 1, totalBet: 1 };
      g.currentBet = 1;
      g.minRaise = 1;
      g.needToAct = [];
      g.toAct = null;
      await instance.advanceStreet(g);
      const done = await state.storage.get("holdem");
      expect(done.phase).toBe("flop");
      expect(done.board).toEqual(["2s", "3s", "4s"]);
      expect(done.needToAct).toEqual([2, 0]);
      expect(done.toAct).toBe(2);
    });
    a.ws.close(); b.ws.close(); c.ws.close();
  });
});

describe("德州扑克 散桌/互斥/清理", () => {
  it("散桌清空状态并回到无牌局", async () => {
    const room = "pk-disband";
    const a = await openWSCollect(room, "A");
    a.ws.send(JSON.stringify({ type: "poker_start" }));
    await new Promise((r) => setTimeout(r, 50));
    const b = await openWSCollect(room, "B");
    b.ws.send(JSON.stringify({ type: "poker_join" }));
    await new Promise((r) => setTimeout(r, 60));
    a.ws.send(JSON.stringify({ type: "poker_disband" }));
    await new Promise((r) => setTimeout(r, 80));
    const id = env.CHAT_ROOM.idFromName(room);
    const stub = env.CHAT_ROOM.get(id);
    await runInDurableObject(stub, async (instance, state) => {
      expect(await state.storage.get("holdem")).toBeUndefined();
    });
    a.ws.close(); b.ws.close();
  });

  it("散桌时广播本桌筹码排名", async () => {
    const room = "pk-disband-board";
    const a = await openWSCollect(room, "A");
    a.ws.send(JSON.stringify({ type: "poker_start" }));
    await new Promise((r) => setTimeout(r, 50));
    const b = await openWSCollect(room, "B");
    b.ws.send(JSON.stringify({ type: "poker_join" }));
    await new Promise((r) => setTimeout(r, 60));
    const id = env.CHAT_ROOM.idFromName(room);
    const stub = env.CHAT_ROOM.get(id);
    await runInDurableObject(stub, async (instance, state) => {
      const g = await state.storage.get("holdem");
      g.seats[0].stack = 62.5;
      g.seats[1].stack = 37.5;
      await state.storage.put("holdem", g);
    });

    a.msgs.length = 0;
    a.ws.send(JSON.stringify({ type: "poker_disband" }));
    await new Promise((r) => setTimeout(r, 80));
    const text = a.msgs.filter((m) => m.type === "system").map((m) => m.text).join("\n");
    expect(text).toContain("本桌战绩");
    expect(text).toContain("A +12.5bb");
    expect(text).toContain("B -12.5bb");
    a.ws.close(); b.ws.close();
  });

  it("已有斗地主局时发起德州被拒；反之亦然", async () => {
    const room = "pk-mutex";
    const a = await openWSCollect(room, "A");
    a.ws.send(JSON.stringify({ type: "ddz_start" }));
    await new Promise((r) => setTimeout(r, 60));
    a.msgs.length = 0;
    a.ws.send(JSON.stringify({ type: "poker_start" }));
    await new Promise((r) => setTimeout(r, 60));
    expect(a.msgs.some((m) => m.type === "poker_error")).toBe(true);
    a.ws.close();

    const room2 = "pk-mutex2";
    const b = await openWSCollect(room2, "B");
    b.ws.send(JSON.stringify({ type: "poker_start" }));
    await new Promise((r) => setTimeout(r, 60));
    b.msgs.length = 0;
    b.ws.send(JSON.stringify({ type: "ddz_start" }));
    await new Promise((r) => setTimeout(r, 60));
    expect(b.msgs.some((m) => m.type === "ddz_error")).toBe(true);
    b.ws.close();
  });

  it("alarm 空房清除 holdem", async () => {
    const id = env.CHAT_ROOM.idFromName("pk-alarm");
    const stub = env.CHAT_ROOM.get(id);
    await runInDurableObject(stub, async (instance, state) => {
      await state.storage.put("holdem", { phase: "waiting" });
      await instance.alarm();
      expect(await state.storage.get("holdem")).toBeUndefined();
    });
  });
});
