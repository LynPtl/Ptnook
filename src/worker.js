import { DurableObject } from "cloudflare:workers";
import { sanitizeNick, parseInbound, chatMsg, systemMsg, presenceMsg, historyMsg } from "./messages.js";
import { makeDeck, deal, sortCards, resolveBids } from "./ddz.js";

export class ChatRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    // 从 hibernation 恢复：无需额外 sessions map，用 ctx.getWebSockets() 即可
  }

  async fetch(request) {
    const url = new URL(request.url);
    const nick = sanitizeNick(url.searchParams.get("nick"));

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ nick });

    // 有人进来：取消待定的空房清除闹钟
    await this.ctx.storage.deleteAlarm();

    // 先给新连接单独推送历史，再广播加入
    const history = (await this.ctx.storage.get("history")) || [];
    server.send(historyMsg(history));

    const ts = Date.now();
    this.broadcast(systemMsg(`${nick} 加入了房间`, ts));
    this.broadcast(presenceMsg(this.ctx.getWebSockets().length));

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    if (typeof message !== "string") return;
    let obj = null;
    try { obj = JSON.parse(message); } catch {}
    if (obj && typeof obj.type === "string" && obj.type.startsWith("ddz_")) {
      await this.handleDdz(ws, obj);
      return;
    }
    const parsed = parseInbound(message);
    if (!parsed) return;
    const att = ws.deserializeAttachment() || {};
    const nick = att.nick || "访客";
    const ts = Date.now();
    this.broadcast(chatMsg(nick, parsed.text, ts));
    await this.appendHistory({ nick, text: parsed.text, ts });
  }

  async webSocketClose(ws, code, reason, wasClean) {
    const att = ws.deserializeAttachment() || {};
    const nick = att.nick || "访客";
    try {
      ws.close(code, reason);
    } catch {}
    const ts = Date.now();
    const remaining = this.ctx.getWebSockets().filter((s) => s !== ws).length;
    this.broadcast(systemMsg(`${nick} 离开了房间`, ts));
    this.broadcast(presenceMsg(remaining));
    if (remaining === 0) {
      await this.ctx.storage.setAlarm(Date.now() + 30 * 60 * 1000);
    }
  }

  async webSocketError(ws, error) {
    await this.webSocketClose(ws, 1006, "error", false);
  }

  async alarm() {
    if (this.ctx.getWebSockets().length === 0) {
      await this.ctx.storage.delete("history");
    }
  }

  async appendHistory(item) {
    const history = (await this.ctx.storage.get("history")) || [];
    history.push(item);
    if (history.length > 50) history.splice(0, history.length - 50);
    await this.ctx.storage.put("history", history);
  }

  broadcast(data) {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(data);
      } catch {}
    }
  }

  async getGame() { return (await this.ctx.storage.get("ddz")) || null; }
  async putGame(g) { await this.ctx.storage.put("ddz", g); }
  async clearGame() { await this.ctx.storage.delete("ddz"); }

  wsByNick(nick) {
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() || {};
      if (att.nick === nick) return ws;
    }
    return null;
  }

  shuffledDeck() {
    const deck = makeDeck();
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32 * (i + 1));
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
  }

  publicState(g) {
    const seats = g.players.map((nick) => ({
      nick,
      cardCount: g.hands[nick] ? g.hands[nick].length : 0,
      role: g.landlord ? (nick === g.landlord ? "landlord" : "farmer") : null,
      bid: g.bids[nick] == null ? null : g.bids[nick],
    }));
    return {
      type: "ddz_state",
      phase: g.phase,
      seats,
      landlord: g.landlord,
      bottom: g.phase === "playing" || g.phase === "settled" ? g.bottom : null,
      current: g.phase === "bidding" ? g.bidTurn : g.current,
      lastPlay: g.lastPlay,
      scores: g.scores,
      winnerSeat: g.winner,
    };
  }

  async sendDdzState(g) {
    const payload = JSON.stringify(this.publicState(g));
    for (const nick of g.players) {
      const ws = this.wsByNick(nick);
      if (ws) { try { ws.send(payload); } catch {} }
    }
  }
  sendHand(g, nick) {
    const ws = this.wsByNick(nick);
    if (ws) {
      try { ws.send(JSON.stringify({ type: "ddz_hand", cards: sortCards(g.hands[nick] || []) })); } catch {}
    }
  }
  ddzErr(ws, text) { try { ws.send(JSON.stringify({ type: "ddz_error", text })); } catch {} }

  startBidding(g) {
    const deck = this.shuffledDeck();
    const { hands, bottom } = deal(deck);
    g.hands = {};
    g.players.forEach((nick, i) => { g.hands[nick] = hands[i]; });
    g.bottom = bottom;
    g.bids = {};
    g.bidOrder = g.players.slice();
    g.bidTurn = g.bidOrder[0];
    g.landlord = null;
    g.phase = "bidding";
  }

  async handleDdz(ws, msg) {
    const att = ws.deserializeAttachment() || {};
    const nick = att.nick || "访客";
    let g = await this.getGame();

    if (msg.type === "ddz_start") {
      if (g) { this.ddzErr(ws, "已有牌局进行中"); return; }
      g = {
        phase: "waiting", players: [nick], starter: nick,
        hands: {}, bottom: [], bids: {}, bidOrder: [], bidTurn: null,
        landlord: null, current: null, lastPlay: null, passCount: 0,
        bombCount: 0, hasRocket: false, scores: {}, winner: null,
      };
      await this.putGame(g);
      this.broadcast(systemMsg(`${nick} 发起了斗地主，点【加入牌桌】上桌（还差 2 人）`, Date.now()));
      await this.sendDdzState(g);
      return;
    }
    if (!g) { this.ddzErr(ws, "当前没有牌局，输入 /ddz 发起"); return; }

    if (msg.type === "ddz_join") {
      if (g.phase !== "waiting") { this.ddzErr(ws, "牌局已开始"); return; }
      if (g.players.includes(nick)) { this.ddzErr(ws, "你已在牌桌上"); return; }
      if (g.players.length >= 3) { this.ddzErr(ws, "牌桌已满"); return; }
      g.players.push(nick);
      this.broadcast(systemMsg(`${nick} 加入了牌桌（${g.players.length}/3）`, Date.now()));
      if (g.players.length === 3) {
        this.startBidding(g);
        await this.putGame(g);
        this.broadcast(systemMsg(`满 3 人，开始抢地主。${g.bidTurn} 先叫`, Date.now()));
        await this.sendDdzState(g);
        for (const p of g.players) this.sendHand(g, p);
      } else {
        await this.putGame(g);
        await this.sendDdzState(g);
      }
      return;
    }

    if (msg.type === "ddz_cancel") {
      if (g.phase !== "waiting") { this.ddzErr(ws, "牌局已开始，不能取消"); return; }
      await this.clearGame();
      this.broadcast(systemMsg(`${nick} 取消了牌局`, Date.now()));
      return;
    }

    if (msg.type === "ddz_bid") {
      if (g.phase !== "bidding") { this.ddzErr(ws, "现在不是叫分阶段"); return; }
      if (nick !== g.bidTurn) { this.ddzErr(ws, "还没轮到你叫分"); return; }
      const v = [0, 1, 2, 3].includes(msg.value) ? msg.value : 0;
      const prevMax = Math.max(0, ...Object.values(g.bids));
      if (v !== 0 && v <= prevMax) { this.ddzErr(ws, "只能叫更高的分或不叫"); return; }
      g.bids[nick] = v;
      this.broadcast(systemMsg(`${nick} ${v === 0 ? "不叫" : "叫了 " + v + " 分"}`, Date.now()));
      // 叫 3 立即结束，或所有人叫过一轮
      const bidValues = g.bidOrder.map((p) => g.bids[p]);
      const allBid = g.bidOrder.every((p) => g.bids[p] != null);
      if (v === 3 || allBid) {
        const resolved = resolveBids(g.bidOrder.map((p) => (g.bids[p] == null ? 0 : g.bids[p])));
        if (!resolved) {
          this.broadcast(systemMsg("无人叫地主，重新发牌", Date.now()));
          this.startBidding(g);
          await this.putGame(g);
          await this.sendDdzState(g);
          for (const p of g.players) this.sendHand(g, p);
          return;
        }
        const landlord = g.bidOrder[resolved.landlordIndex];
        g.landlord = landlord;
        g.base = resolved.base;
        g.hands[landlord] = g.hands[landlord].concat(g.bottom);
        g.phase = "playing";
        g.current = landlord;
        g.lastPlay = null;
        g.passCount = 0;
        await this.putGame(g);
        this.broadcast(systemMsg(`${landlord} 当地主（底分 ${resolved.base}），底牌 ${g.bottom.join(" ")}`, Date.now()));
        await this.sendDdzState(g);
        this.sendHand(g, landlord);
        return;
      }
      // 轮到下一个还没叫的人
      const i = g.bidOrder.indexOf(nick);
      g.bidTurn = g.bidOrder[(i + 1) % 3];
      await this.putGame(g);
      await this.sendDdzState(g);
      return;
    }

    // playing / settled 相关消息在 Task 6 处理
    await this.handleDdzPlay(ws, msg, g, nick);
  }

  async handleDdzPlay(ws, msg, g, nick) { /* Task 6 实现 */ }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/room\/([^/]+)$/);

    if (match) {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("expected websocket", { status: 426 });
      }
      const roomName = decodeURIComponent(match[1]).slice(0, 32);
      const stub = env.CHAT_ROOM.getByName(roomName);
      return stub.fetch(request);
    }

    return new Response(renderPage(), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  },
};

function renderPage() {
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>聊天室</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, system-ui, sans-serif; height: 100vh; display: flex; flex-direction: column; background: #f5f5f5; }
  #join { margin: auto; padding: 24px; background: #fff; border-radius: 12px; box-shadow: 0 2px 12px rgba(0,0,0,.1); display: flex; flex-direction: column; gap: 12px; width: 280px; }
  #join h1 { font-size: 18px; margin: 0 0 8px; }
  #join input, #composer textarea { padding: 10px; border: 1px solid #ccc; border-radius: 8px; font-size: 15px; }
  button { padding: 10px 16px; border: 0; border-radius: 8px; background: #2f6feb; color: #fff; font-size: 15px; cursor: pointer; }
  button:hover { background: #2559c9; }
  #chat { display: none; flex-direction: column; height: 100%; }
  header { padding: 12px 16px; background: #fff; border-bottom: 1px solid #eee; display: flex; justify-content: space-between; align-items: center; }
  header .room { font-weight: 600; }
  header .count { color: #888; font-size: 13px; }
  #messages { flex: 1; overflow-y: auto; padding: 12px 16px; }
  .msg { margin: 10px 0; word-break: break-word; }
  .msg .head { margin-bottom: 2px; }
  .msg .nick { font-weight: 600; margin-right: 6px; }
  .msg .time { color: #bbb; font-size: 12px; margin-right: 6px; }
  .msg .body { white-space: pre-wrap; }
  .sys { color: #999; font-size: 13px; text-align: center; margin: 8px 0; }
  .divider { color: #e0533d; font-size: 12px; text-align: center; margin: 12px 0; border-top: 1px solid #f0c9c2; padding-top: 6px; }
  #composer { display: flex; gap: 8px; padding: 12px 16px; background: #fff; border-top: 1px solid #eee; align-items: flex-end; }
  #composer textarea { flex: 1; resize: none; height: 40px; max-height: 120px; line-height: 20px; font-family: inherit; }
  #status { font-size: 12px; color: #c00; padding: 0 16px; }
</style>
</head>
<body>
  <div id="join">
    <h1>进入聊天室</h1>
    <input id="room" placeholder="房间名（即口令）" maxlength="32" autofocus>
    <input id="nick" placeholder="你的昵称" maxlength="32">
    <button id="enter">进入</button>
  </div>
  <div id="chat">
    <header>
      <span class="room" id="roomLabel"></span>
      <span class="count" id="countLabel"></span>
      <button id="leave">离开</button>
    </header>
    <div id="status"></div>
    <div id="messages"></div>
    <form id="composer">
      <textarea id="text" placeholder="说点什么…（Enter 发送，Shift+Enter 换行）" maxlength="2000" rows="1"></textarea>
      <button type="submit">发送</button>
    </form>
  </div>
<script>
(function () {
  var room, nick, ws, reconnectDelay = 500, manualClose = false, reconnectTimer = null, pendingDivider = false;
  var $ = function (id) { return document.getElementById(id); };

  // 与 src/messages.js 的 firstUnreadIndex 保持一致（浏览器内联脚本无法 import，故镜像一份）
  function firstUnreadIndex(items, lastReadTs) {
    if (!lastReadTs) return -1;
    for (var i = 0; i < items.length; i++) {
      if (items[i].ts > lastReadTs) return i;
    }
    return -1;
  }
  function lsKey() { return "ptnook:lastread:" + room; }
  function lsGet() {
    try { var v = localStorage.getItem(lsKey()); return v ? Number(v) : null; } catch (_) { return null; }
  }
  function lsSet(ts) {
    try { if (ts) localStorage.setItem(lsKey(), String(ts)); } catch (_) {}
  }
  function msgEls() {
    return Array.prototype.slice.call($("messages").querySelectorAll(".msg"));
  }
  function lastMsgTs() {
    var els = msgEls();
    if (!els.length) return null;
    return Number(els[els.length - 1].dataset.ts);
  }
  function markRead() {
    var ts = lastMsgTs();
    if (ts) lsSet(ts);
  }
  // 移除旧分隔线，按 lastReadTs 在第一条未读前插入新分隔线；返回是否插入
  function showDivider(lastReadTs) {
    var old = $("messages").querySelector(".divider");
    if (old) old.parentNode.removeChild(old);
    var els = msgEls();
    var items = els.map(function (el) { return { ts: Number(el.dataset.ts) }; });
    var idx = firstUnreadIndex(items, lastReadTs);
    if (idx < 0) return false;
    var div = document.createElement("div");
    div.className = "divider";
    div.textContent = "—— 以下是新消息 ——";
    els[idx].parentNode.insertBefore(div, els[idx]);
    div.scrollIntoView({ block: "center" });
    return true;
  }

  // 断开当前连接并清理，确保同一时刻只有一个活动连接
  function teardown() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try { ws.close(); } catch (_) {}
      ws = null;
    }
  }

  function atBottom() {
    var box = $("messages");
    return box.scrollTop + box.clientHeight >= box.scrollHeight - 40;
  }
  function scrollToBottom() {
    var box = $("messages");
    box.scrollTop = box.scrollHeight;
  }
  function fmtTime(ts) {
    if (!ts) return "";
    var d = new Date(ts);
    var h = ("0" + d.getHours()).slice(-2);
    var m = ("0" + d.getMinutes()).slice(-2);
    return h + ":" + m;
  }

  $("enter").onclick = function () {
    room = $("room").value.trim();
    nick = $("nick").value.trim();
    if (!room) { $("room").focus(); return; }
    teardown();
    manualClose = false;
    pendingDivider = true;
    reconnectDelay = 500;
    $("join").style.display = "none";
    $("chat").style.display = "flex";
    $("roomLabel").textContent = "房间：" + room;
    connect();
  };

  $("leave").onclick = function () {
    manualClose = true;
    markRead();
    teardown();
    $("chat").style.display = "none";
    $("join").style.display = "flex";
    $("messages").innerHTML = "";
  };

  function connect() {
    // 建立新连接前，先清掉任何遗留的连接/重连定时器
    teardown();
    if (manualClose) return;
    var proto = location.protocol === "https:" ? "wss:" : "ws:";
    var url = proto + "//" + location.host + "/room/" + encodeURIComponent(room) + "?nick=" + encodeURIComponent(nick);
    ws = new WebSocket(url);
    ws.onopen = function () { reconnectDelay = 500; $("status").textContent = ""; };
    ws.onmessage = function (e) {
      var m;
      try { m = JSON.parse(e.data); } catch (_) { return; }
      if (m.type === "chat") addChat(m.nick, m.text, m.ts);
      else if (m.type === "system") addSystem(m.text);
      else if (m.type === "presence") $("countLabel").textContent = "在线 " + m.count + " 人";
      else if (m.type === "history") {
        $("messages").innerHTML = "";
        (m.items || []).forEach(function (it) { addChat(it.nick, it.text, it.ts); });
        if (pendingDivider) {
          pendingDivider = false;
          if (!showDivider(lsGet())) scrollToBottom();
        } else {
          scrollToBottom();
        }
      }
    };
    ws.onclose = function () {
      ws = null;
      if (manualClose) return;
      $("status").textContent = "连接断开，重连中…";
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 8000);
    };
    ws.onerror = function () { try { ws.close(); } catch (_) {} };
  }

  function addChat(n, t, ts) {
    var wasBottom = atBottom();
    var div = document.createElement("div");
    div.className = "msg";
    div.dataset.ts = ts;
    var head = document.createElement("div");
    head.className = "head";
    var s = document.createElement("span");
    s.className = "nick";
    s.textContent = n;
    var tm = document.createElement("span");
    tm.className = "time";
    tm.textContent = fmtTime(ts);
    head.appendChild(s); head.appendChild(tm);
    var b = document.createElement("div");
    b.className = "body";
    b.textContent = t;
    div.appendChild(head); div.appendChild(b);
    $("messages").appendChild(div);
    if (wasBottom) scrollToBottom();
  }
  function addSystem(t) {
    var wasBottom = atBottom();
    var div = document.createElement("div");
    div.className = "sys";
    div.textContent = t;
    $("messages").appendChild(div);
    if (wasBottom) scrollToBottom();
  }

  function sendMessage() {
    var t = $("text").value.trim();
    if (!t || !ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify({ type: "chat", text: t }));
    $("text").value = "";
  }

  $("composer").onsubmit = function (e) {
    e.preventDefault();
    sendMessage();
  };
  $("text").addEventListener("keydown", function (e) {
    if (e.isComposing) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  window.addEventListener("blur", function () {
    if (room) markRead();
  });
  window.addEventListener("focus", function () {
    if (room) showDivider(lsGet());
  });
  window.addEventListener("beforeunload", function () {
    if (room) markRead();
  });
})();
</script>
</body>
</html>`;
}
