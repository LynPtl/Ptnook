export function renderPage() {
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
  header .header-toggle { padding: 5px 9px; border: 1px solid #ddd; border-radius: 999px; background: #f7f7f7; color: #444; font-size: 12px; line-height: 1.2; }
  header .header-toggle:hover { background: #eee; }
  #messages { flex: 1; overflow-y: auto; padding: 12px 16px; }
  .msg { margin: 10px 0; word-break: break-word; }
  .msg .head { margin-bottom: 2px; }
  .msg .nick { font-weight: 600; margin-right: 6px; }
  .msg .time { color: #bbb; font-size: 12px; margin-right: 6px; }
  .msg .body { white-space: pre-wrap; }
  .sys { color: #999; font-size: 13px; text-align: center; margin: 8px 0; }
  .divider { color: #e0533d; font-size: 12px; text-align: center; margin: 12px 0; border-top: 1px solid #f0c9c2; padding-top: 6px; }
  #ddzbar { border-top: 1px solid #eee; background: #fff; padding: 8px 12px; display: none; }
  #ddzbar .btns { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 6px; }
  #ddzbar .btns button { padding: 6px 10px; font-size: 14px; }
  #ddzhand { display: flex; flex-wrap: wrap; gap: 4px; }
  #ddzhand .card { border: 1px solid #ccc; border-radius: 6px; padding: 4px 8px; font-size: 15px; cursor: pointer; user-select: none; background: #fafafa; }
  #ddzhand .card.sel { background: #2f6feb; color: #fff; border-color: #2f6feb; transform: translateY(-4px); }
  #pokertable { border-top: 1px solid #eee; background: #0f5132; color: #fff; padding: 8px 12px; display: none; }
  #pokertable .board { min-height: 26px; margin-bottom: 6px; font-size: 13px; }
  #pokertable .card { display: inline-block; background: #fff; color: #111; border-radius: 4px; padding: 2px 6px; margin-right: 4px; font-weight: 600; }
  #pokertable .card.red { color: #d11; }
  #pokertable .pot { font-size: 13px; margin-bottom: 6px; }
  #pokertable .seats { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 6px; }
  #pokertable .seat { background: rgba(255,255,255,.12); border-radius: 6px; padding: 4px 8px; font-size: 13px; }
  #pokertable .seat.act { outline: 2px solid #ffd43b; }
  #pokertable .seat.fold { opacity: .45; }
  #pokertable .seat .tag { font-weight: 700; margin-left: 4px; }
  #pokerbtns { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  #pokerbtns button { padding: 6px 10px; font-size: 14px; }
  #pokerbtns input { width: 64px; padding: 4px 6px; border-radius: 6px; border: 1px solid #ccc; }
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
      <button id="ddzquit" style="display:none">退出牌局</button>
      <button id="soundBtn" class="header-toggle" title="点击切换提示音">提示音 开</button>
      <button id="pokerquit" style="display:none">散桌</button>
      <button id="leave">离开</button>
    </header>
    <div id="status"></div>
    <div id="messages"></div>
    <div id="ddzbar">
      <div class="btns" id="ddzbtns"></div>
      <div id="ddzhand"></div>
    </div>
    <div id="pokertable">
      <div class="board" id="pokerboard"></div>
      <div class="pot" id="pokerpot"></div>
      <div class="seats" id="pokerseats"></div>
      <div id="pokerbtns"></div>
    </div>
    <form id="composer">
      <textarea id="text" placeholder="说点什么…（Enter 发送，Shift+Enter 换行）" maxlength="2000" rows="1"></textarea>
      <button type="submit">发送</button>
    </form>
  </div>
<script>
(function () {
  var room, nick, ws, reconnectDelay = 500, manualClose = false, reconnectTimer = null, pendingDivider = false, lastHintAt = 0;
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

  $("soundBtn").onclick = toggleSound;

  $("ddzquit").onclick = function () { ddzSend("ddz_disband"); };
  $("pokerquit").onclick = function () { pokerSend("poker_disband"); };

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
      if (m.type === "chat") {
        addChat(m.nick, m.text, m.ts);
        // 新消息响铃：非自己发的、且（不在前台或不在底部）
        if (m.nick !== nick && (document.hidden || !atBottom())) {
          playNotificationSound();
        }
      }
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
      else if (m.type === "ddz_state") { if (m.resumed) addSystem(ddzResumeSummary(m)); renderDdz(m); }
      else if (m.type === "ddz_hand") { ddz.hand = m.cards || []; ddz.selected = {}; renderHand(); }
      else if (m.type === "ddz_hint") applyHint(m.cards || []);
      else if (m.type === "ddz_error") addSystem("⚠️ " + m.text);
      else if (m.type === "poker_state") { if (m.resumed) addSystem("【牌局恢复】德州扑克，阶段 " + m.phase); renderPoker(m); }
      else if (m.type === "poker_hole") { poker.hole = m.cards || []; renderPoker(poker.last); }
      else if (m.type === "poker_error") addSystem("♠ " + m.text);
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

  var ddz = { phase: "none", hand: [], selected: {} };

  // 消息提示音
  var soundMuted = false, audioCtx = null;
  try { soundMuted = localStorage.getItem("ptnook:sound:muted") === "1"; } catch (_) {}
  function soundBtnLabel() { return soundMuted ? "提示音 关" : "提示音 开"; }
  $("soundBtn").textContent = soundBtnLabel();
  function ensureAudioCtx() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
  }
  function toggleSound() {
    soundMuted = !soundMuted;
    try { localStorage.setItem("ptnook:sound:muted", soundMuted ? "1" : ""); } catch (_) {}
    $("soundBtn").textContent = soundBtnLabel();
  }
  function playNotificationSound() {
    if (soundMuted) return;
    try {
      ensureAudioCtx();
      var osc = audioCtx.createOscillator();
      var gain = audioCtx.createGain();
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.frequency.value = 660;
      osc.type = "sine";
      gain.gain.setValueAtTime(0.25, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.2);
      osc.start();
      osc.stop(audioCtx.currentTime + 0.2);
    } catch (_) {}
  }

  function ddzSend(type, extra) {
    if (!ws || ws.readyState !== 1) return;
    var o = { type: type };
    if (extra) for (var k in extra) o[k] = extra[k];
    ws.send(JSON.stringify(o));
  }

  function ddzResumeSummary(state) {
    var seats = state.seats || [];
    var remain = seats.map(function (s) { return s.nick + "(" + s.cardCount + ")"; }).join(" ");
    if (state.phase === "bidding") {
      return "【牌局恢复】抢地主中，轮到 " + (state.current || "?") + " 叫分 ｜ 剩余 " + remain;
    }
    if (state.phase === "playing") {
      var last = "";
      if (state.lastPlay && state.lastPlay.cards && state.lastPlay.cards.length) {
        last = "，上一手 " + state.lastPlay.nick + " 出 " + state.lastPlay.cards.map(cardLabel).join(" ");
      } else {
        last = "，当前自由出";
      }
      return "【牌局恢复】地主 " + (state.landlord || "?") + "，轮到 " + (state.current || "?") + " 出牌" + last + " ｜ 剩余 " + remain;
    }
    if (state.phase === "settled") {
      return "【牌局恢复】本局已结束，可点【再来一局】或【散桌】";
    }
    if (state.phase === "waiting") {
      return "【牌局恢复】等待玩家加入牌桌";
    }
    return "【牌局恢复】";
  }

  function renderDdz(state) {
    ddz.phase = state.phase;
    var bar = $("ddzbar");
    var quit = $("ddzquit");
    if (state.phase === "none" || !state.phase) { bar.style.display = "none"; quit.style.display = "none"; $("ddzhand").innerHTML = ""; $("ddzbtns").innerHTML = ""; ddz.hand = []; ddz.selected = {}; return; }
    // 记录本次重渲染前是否贴底：ddzbar 面板高度变化（弹出/手牌增减/按钮增减）会改变消息区可视高度，
    // 若之前贴底则重渲染后重新滚到底，避免出牌等广播被面板顶上去；未贴底（在翻历史）则不打扰。
    var wasBottom = atBottom();
    bar.style.display = "block";
    // 招募阶段与结算阶段没有可出的手牌：清空手牌数据，避免残留旧牌
    if (state.phase === "waiting" || state.phase === "settled") { ddz.hand = []; ddz.selected = {}; }
    var me = nick;
    var mySeat = (state.seats || []).some(function (s) { return s.nick === me; });
    // 退出牌局按钮挪到右上角，仅牌局进行中（叫分/出牌）且自己在座时显示，避免与出牌按钮挤在一起误触
    quit.style.display = (mySeat && (state.phase === "bidding" || state.phase === "playing")) ? "" : "none";
    var btns = $("ddzbtns");
    btns.innerHTML = "";
    function addBtn(label, fn) {
      var b = document.createElement("button");
      b.textContent = label;
      b.onclick = fn;
      btns.appendChild(b);
    }
    if (state.phase === "waiting") {
      if (!mySeat) addBtn("加入牌桌", function () { ddzSend("ddz_join"); });
      addBtn("取消", function () { ddzSend("ddz_cancel"); });
    } else if (state.phase === "bidding") {
      if (state.current === me) {
        addBtn("叫1", function () { ddzSend("ddz_bid", { value: 1 }); });
        addBtn("叫2", function () { ddzSend("ddz_bid", { value: 2 }); });
        addBtn("叫3", function () { ddzSend("ddz_bid", { value: 3 }); });
        addBtn("不叫", function () { ddzSend("ddz_bid", { value: 0 }); });
      }
    } else if (state.phase === "playing") {
      if (state.current === me) {
        addBtn("出牌", playSelected);
        addBtn("提示", function () {
          var now = Date.now();
          if (now - lastHintAt < 800) return;
          lastHintAt = now;
          ddzSend("ddz_hint");
        });
        addBtn("取消选中", function () { ddz.selected = {}; renderHand(); });
        addBtn("过", function () { ddzSend("ddz_pass"); });
      }
    } else if (state.phase === "settled") {
      addBtn("再来一局", function () { ddzSend("ddz_again"); });
      addBtn("散桌", function () { ddzSend("ddz_disband"); });
    }
    renderHand();
    // 面板高度可能已变化，等布局回流后若原本贴底则重新贴底
    if (wasBottom) {
      if (window.requestAnimationFrame) requestAnimationFrame(scrollToBottom);
      else scrollToBottom();
    }
  }

  function renderHand() {
    var box = $("ddzhand");
    box.innerHTML = "";
    ddz.hand.forEach(function (c, i) {
      var el = document.createElement("div");
      el.className = "card" + (ddz.selected[i] ? " sel" : "");
      el.textContent = cardLabel(c);
      el.onclick = function () { ddz.selected[i] = !ddz.selected[i]; el.classList.toggle("sel"); };
      box.appendChild(el);
    });
  }
  function cardLabel(c) { return c === "x" ? "小王" : c === "X" ? "大王" : c; }

  function playSelected() {
    var cards = [];
    ddz.hand.forEach(function (c, i) { if (ddz.selected[i]) cards.push(c); });
    if (!cards.length) return;
    ddzSend("ddz_play", { cards: cards });
    ddz.selected = {};
  }

  function applyHint(cards) {
    ddz.selected = {};
    // 按令牌逐张匹配 ddz.hand 中尚未选中的同点数位置（处理重复点数）
    cards.forEach(function (c) {
      for (var i = 0; i < ddz.hand.length; i++) {
        if (ddz.hand[i] === c && !ddz.selected[i]) { ddz.selected[i] = true; break; }
      }
    });
    renderHand();
  }

  var poker = { phase: "none", hole: [], last: null };

  function pokerSend(type, extra) {
    if (!ws || ws.readyState !== 1) return;
    var o = { type: type };
    if (extra) for (var k in extra) o[k] = extra[k];
    ws.send(JSON.stringify(o));
  }

  function pokerCard(tok) {
    if (!tok) return "";
    var r = tok.slice(0, -1), s = tok.slice(-1);
    var sym = { s: "♠", h: "♥", d: "♦", c: "♣" }[s] || "";
    var rank = r === "T" ? "10" : r;
    return { text: rank + sym, red: (s === "h" || s === "d") };
  }

  function pokerCardEl(tok) {
    var info = pokerCard(tok);
    var el = document.createElement("span");
    el.className = "card" + (info.red ? " red" : "");
    el.textContent = info.text;
    return el;
  }

  function fmtBB(n) {
    if (n == null) return "0";
    return (Math.round(n * 10) / 10).toString();
  }

  function renderPoker(state) {
    if (!state) return;
    poker.last = state;
    poker.phase = state.phase;
    var table = $("pokertable");
    var pokerQuit = $("pokerquit");
    if (state.phase === "none" || !state.phase) {
      table.style.display = "none";
      pokerQuit.style.display = "none";
      $("pokerboard").innerHTML = ""; $("pokerseats").innerHTML = ""; $("pokerbtns").innerHTML = ""; $("pokerpot").textContent = "";
      poker.hole = [];
      return;
    }
    var wasBottom = atBottom();
    table.style.display = "block";
    var me = nick;
    var seats = state.seats || [];
    var mySeat = null;
    seats.forEach(function (s) { if (s && s.nick === me) mySeat = s; });
    var isSeated = !!mySeat;
    pokerQuit.style.display = (isSeated && state.phase !== "waiting" && state.phase !== "none") ? "" : "none";

    // 公共牌（+ 自己底牌）
    var boardBox = $("pokerboard");
    boardBox.innerHTML = "";
    var lbl = document.createElement("span"); lbl.textContent = "公共牌 "; boardBox.appendChild(lbl);
    (state.board || []).forEach(function (c) { boardBox.appendChild(pokerCardEl(c)); });
    if (poker.hole && poker.hole.length) {
      var ml = document.createElement("span"); ml.textContent = "  我的手牌 "; boardBox.appendChild(ml);
      poker.hole.forEach(function (c) { boardBox.appendChild(pokerCardEl(c)); });
    }

    // 底池
    $("pokerpot").textContent = "底池 " + fmtBB(state.pot) + "bb" + (state.currentBet ? "（当前下注 " + fmtBB(state.currentBet) + "bb）" : "");

    // 座位
    var seatsBox = $("pokerseats");
    seatsBox.innerHTML = "";
    seats.forEach(function (s) {
      if (!s) return;
      var el = document.createElement("div");
      el.className = "seat" + (state.toAct === s.seat ? " act" : "") + (s.hasFolded ? " fold" : "");
      var name = document.createElement("span");
      name.textContent = s.nick + " " + fmtBB(s.stack) + "bb";
      el.appendChild(name);
      if (s.pos) { var tg = document.createElement("span"); tg.className = "tag"; tg.textContent = s.pos; el.appendChild(tg); }
      var st = "";
      if (s.hasFolded) st = " 弃";
      else if (s.isAllIn) st = " 全下";
      else if (s.streetBet) st = " 下" + fmtBB(s.streetBet);
      if (st) { var stEl = document.createElement("span"); stEl.textContent = st; el.appendChild(stEl); }
      if (s.hole) { s.hole.forEach(function (c) { el.appendChild(pokerCardEl(c)); }); }
      seatsBox.appendChild(el);
    });

    // 按钮区
    var btns = $("pokerbtns");
    btns.innerHTML = "";
    function addBtn(label, fn) { var b = document.createElement("button"); b.textContent = label; b.onclick = fn; btns.appendChild(b); }
    if (state.phase === "waiting") {
      if (!isSeated) addBtn("加入牌桌", function () { pokerSend("poker_join"); });
      if (isSeated) addBtn("开始游戏", function () { pokerSend("poker_next"); });
      addBtn("取消", function () { pokerSend("poker_cancel"); });
    } else if (state.phase === "settled") {
      if (mySeat && mySeat.stack > 0) addBtn("下一手", function () { pokerSend("poker_next"); });
      if (mySeat && mySeat.stack === 0) addBtn("buy-in（+50bb）", function () { pokerSend("poker_buyin"); });
      if (!isSeated) addBtn("加入牌桌", function () { pokerSend("poker_join"); });
    } else if (state.toAct != null && mySeat && state.toAct === mySeat.seat) {
      var toCall = (state.currentBet || 0) - (mySeat.streetBet || 0);
      if (toCall <= 0) addBtn("过牌", function () { pokerSend("poker_action", { action: "check" }); });
      else addBtn("跟注 " + fmtBB(Math.min(toCall, mySeat.stack)) + "bb", function () { pokerSend("poker_action", { action: "call" }); });
      var input = document.createElement("input");
      input.type = "number"; input.step = "0.5";
      var minTo = (state.currentBet ? state.currentBet + (state.minRaise || 1) : (state.minRaise || 1));
      input.value = fmtBB(minTo); input.min = fmtBB(minTo);
      btns.appendChild(input);
      function inputAmount() { return Math.round(Number(input.value) * 2) / 2; }
      if (!state.currentBet) addBtn("下注", function () { pokerSend("poker_action", { action: "bet", amount: inputAmount() }); });
      else addBtn("加注到", function () { pokerSend("poker_action", { action: "raise", amount: inputAmount() }); });
      addBtn("½池", function () { var half = (state.currentBet || 0) + (state.pot || 0) / 2; input.value = fmtBB(half); });
      addBtn("全下", function () { input.value = fmtBB(mySeat.stack + (mySeat.streetBet || 0)); });
      addBtn("弃牌", function () { pokerSend("poker_action", { action: "fold" }); });
    }
    if (wasBottom) { if (window.requestAnimationFrame) requestAnimationFrame(scrollToBottom); else scrollToBottom(); }
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
    if (t === "/ddz") {
      ws.send(JSON.stringify({ type: "ddz_start" }));
      $("text").value = "";
      return;
    }
    if (t === "/poker") {
      ws.send(JSON.stringify({ type: "poker_start" }));
      $("text").value = "";
      return;
    }
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
