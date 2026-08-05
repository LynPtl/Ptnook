import { DurableObject } from "cloudflare:workers";
import { sanitizeNick, parseInbound, chatMsg, systemMsg, presenceMsg, historyMsg } from "./messages.js";
import { makeDeck, deal, sortCards, resolveBids, identifyPlay, beats, computeScores, enumerateLegalPlays, pickHint, chooseHint } from "./ddz.js";
import { makeDeck as makePokerDeck, derivePositions, validateAction, evaluateHand, compareHands, buildPots } from "./holdem.js";

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

    // 若该昵称正处于进行中的牌局，补发牌局状态与手牌
    const g = await this.getGame();
    if (g && g.players.includes(nick)) {
      try { server.send(JSON.stringify({ ...this.publicState(g), resumed: true })); } catch {}
      if (g.hands && g.hands[nick]) {
        try { server.send(JSON.stringify({ type: "ddz_hand", cards: sortCards(g.hands[nick]) })); } catch {}
      }
    }

    const pk = await this.getPoker();
    if (pk && this.pokerSeatOf(pk, nick) >= 0) {
      try { server.send(JSON.stringify({ ...this.pokerPublicState(pk), resumed: true })); } catch {}
      const si = this.pokerSeatOf(pk, nick);
      if (pk.seats[si] && pk.seats[si].holeCards && pk.seats[si].holeCards.length) {
        try { server.send(JSON.stringify({ type: "poker_hole", cards: pk.seats[si].holeCards.slice() })); } catch {}
      }
    }

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
    if (obj && typeof obj.type === "string" && obj.type.startsWith("poker_")) {
      await this.handlePoker(ws, obj);
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
      await this.ctx.storage.delete("ddz");
      await this.ctx.storage.delete("holdem");
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

  cardText(c) { return c === "x" ? "小王" : c === "X" ? "大王" : c; }
  remainStr(g) {
    return "剩余 " + g.players.map((p) => {
      const tag = g.landlord ? (p === g.landlord ? "👑" : "🌾") : "";
      return `${tag}${p}(${(g.hands[p] || []).length})`;
    }).join(" ");
  }
  rankBoard(g) {
    const entries = g.players.map((p) => [p, g.scores[p] || 0]);
    if (!entries.some(([, v]) => v !== 0)) return null;
    entries.sort((x, y) => y[1] - x[1]);
    return entries.map(([p, v]) => `${p} ${v >= 0 ? "+" : ""}${v}`).join("，");
  }

  async getGame() { return (await this.ctx.storage.get("ddz")) || null; }
  async putGame(g) { await this.ctx.storage.put("ddz", g); }
  async clearGame() { await this.ctx.storage.delete("ddz"); }

  // ===== 德州扑克 =====
  async getPoker() { return (await this.ctx.storage.get("holdem")) || null; }
  async putPoker(g) { await this.ctx.storage.put("holdem", g); }
  async clearPoker() { await this.ctx.storage.delete("holdem"); }

  pokerErr(ws, text) { try { ws.send(JSON.stringify({ type: "poker_error", text })); } catch {} }

  pokerSeatOf(g, nick) {
    for (let i = 0; i < 3; i++) if (g.seats[i] && g.seats[i].nick === nick) return i;
    return -1;
  }

  shuffledPokerDeck() {
    const deck = makePokerDeck();
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32 * (i + 1));
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
  }

  fmtBB(n) { return Number.isInteger(n) ? String(n) : Number(n.toFixed(1)).toString(); }

  pokerPos(g, i) {
    if (!g.positions) return "";
    if (i === g.positions.button) return "D";
    if (i === g.positions.sb) return "SB";
    if (i === g.positions.bb) return "BB";
    return "";
  }

  pokerPublicState(g) {
    const reveal = !!(g.lastResult && g.lastResult.reveal);
    const seats = g.seats.map((s, i) => s ? {
      seat: i, nick: s.nick, stack: s.stack, streetBet: s.streetBet,
      inHand: s.inHand, hasFolded: s.hasFolded, isAllIn: s.isAllIn,
      pos: this.pokerPos(g, i),
      hole: (reveal && s.inHand) ? s.holeCards : null,
    } : null);
    const pot = g.seats.reduce((a, s) => a + (s ? s.totalBet : 0), 0);
    return {
      type: "poker_state", phase: g.phase, board: g.board || [], pot,
      seats, toAct: g.toAct, currentBet: g.currentBet, minRaise: g.minRaise,
      buttonSeat: g.buttonSeat, starter: g.starter, result: g.lastResult || null,
    };
  }

  async sendPokerState(g) {
    const payload = JSON.stringify(this.pokerPublicState(g));
    if (g.phase === "waiting") {
      this.broadcast(payload); // 招募阶段全房间可见【加入牌桌】
    } else {
      const seated = new Set(g.seats.filter(Boolean).map((s) => s.nick));
      for (const ws of this.ctx.getWebSockets()) {
        const att = ws.deserializeAttachment() || {};
        if (seated.has(att.nick)) { try { ws.send(payload); } catch {} }
      }
    }
  }

  clearNonPokerPlayers(g) {
    const seated = new Set(g.seats.filter(Boolean).map((s) => s.nick));
    const payload = JSON.stringify({ type: "poker_state", phase: "none" });
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() || {};
      if (!seated.has(att.nick)) { try { ws.send(payload); } catch {} }
    }
  }

  sendHole(g, seatIdx) {
    const s = g.seats[seatIdx];
    if (!s) return;
    const ws = this.wsByNick(s.nick);
    if (ws) { try { ws.send(JSON.stringify({ type: "poker_hole", cards: s.holeCards.slice() })); } catch {} }
  }

  nextActiveSeat(g, fromSeat, active) {
    for (let step = 1; step <= 3; step++) {
      const idx = ((fromSeat < 0 ? 0 : fromSeat) + step) % 3;
      if (active.includes(idx)) return idx;
    }
    return active[0];
  }

  postBlind(g, seatIdx, amt) {
    const s = g.seats[seatIdx];
    const put = Math.min(amt, s.stack);
    s.stack -= put;
    s.streetBet += put;
    s.totalBet += put;
    if (s.stack === 0) s.isAllIn = true;
  }

  startHand(g) {
    const SB = 0.5, BB = 1;
    const active = [0, 1, 2].filter((i) => g.seats[i] && g.seats[i].stack > 0);
    if (active.length < 2) return false;
    if (g.handCount > 0) g.buttonSeat = this.nextActiveSeat(g, g.buttonSeat, active);
    else if (!active.includes(g.buttonSeat)) g.buttonSeat = active[0];
    g.handCount = (g.handCount || 0) + 1;
    // 重置每手座位字段
    for (let i = 0; i < 3; i++) {
      const s = g.seats[i];
      if (!s) continue;
      s.inHand = active.includes(i);
      s.hasFolded = false;
      s.isAllIn = false;
      s.holeCards = [];
      s.streetBet = 0;
      s.totalBet = 0;
    }
    // 发底牌
    const deck = this.shuffledPokerDeck();
    let d = 0;
    for (let round = 0; round < 2; round++) {
      for (const i of active) g.seats[i].holeCards.push(deck[d++]);
    }
    g.deck = deck.slice(d);
    g.board = [];
    g.handSeats = active.slice();
    g.positions = derivePositions(active, g.buttonSeat);
    // 下盲
    this.postBlind(g, g.positions.sb, SB);
    this.postBlind(g, g.positions.bb, BB);
    g.currentBet = Math.max(...active.map((i) => g.seats[i].streetBet));
    g.minRaise = BB;
    g.phase = "preflop";
    g.needToAct = g.positions.preflopOrder.filter((i) => g.seats[i].inHand && !g.seats[i].isAllIn);
    g.toAct = g.needToAct.length ? g.needToAct[0] : null;
    g.lastResult = null;
    return true;
  }

  inHandSeats(g) { return [0, 1, 2].filter((i) => g.seats[i] && g.seats[i].inHand); }

  activeToActList(g, exceptSeat) {
    const out = [];
    for (let i = 0; i < 3; i++) {
      const s = g.seats[i];
      if (s && s.inHand && !s.isAllIn && i !== exceptSeat) out.push(i);
    }
    return out;
  }

  nextToAct(g, fromSeat) {
    for (let step = 1; step <= 3; step++) {
      const idx = (fromSeat + step) % 3;
      if (g.needToAct.includes(idx)) return idx;
    }
    return null;
  }

  async handlePokerAction(ws, msg, g, seatIdx) {
    const BB = 1;
    if (!["preflop", "flop", "turn", "river"].includes(g.phase)) { this.pokerErr(ws, "现在不能行动"); return; }
    if (seatIdx !== g.toAct) { this.pokerErr(ws, "还没轮到你"); return; }
    const s = g.seats[seatIdx];
    const ctx = { currentBet: g.currentBet, minRaise: g.minRaise, bigBlind: BB, streetBet: s.streetBet, stack: s.stack };
    const res = validateAction(ctx, msg.action, msg.amount);
    if (!res.ok) { this.pokerErr(ws, res.error); return; }

    let label;
    if (res.folded) {
      s.hasFolded = true;
      s.inHand = false;
      label = `${s.nick} 弃牌`;
    } else {
      s.stack -= res.added;
      s.streetBet = res.streetBetAfter;
      s.totalBet += res.added;
      if (res.allIn) s.isAllIn = true;
      if (msg.action === "check") label = `${s.nick} 过牌`;
      else if (msg.action === "call") label = `${s.nick} 跟注到 ${this.fmtBB(s.streetBet)}bb${res.allIn ? "（全下）" : ""}`;
      else if (msg.action === "bet") label = `${s.nick} 下注 ${this.fmtBB(s.streetBet)}bb${res.allIn ? "（全下）" : ""}`;
      else if (msg.action === "raise") label = `${s.nick} 加注到 ${this.fmtBB(s.streetBet)}bb${res.allIn ? "（全下）" : ""}`;
      else label = `${s.nick} 全下 ${this.fmtBB(s.streetBet)}bb`;
    }

    g.needToAct = g.needToAct.filter((x) => x !== seatIdx);
    if (res.raised) {
      const inc = res.streetBetAfter - g.currentBet;
      if (inc >= g.minRaise) g.minRaise = inc;
      g.currentBet = res.streetBetAfter;
      g.needToAct = this.activeToActList(g, seatIdx);
    }
    this.broadcast(systemMsg(label, Date.now()));

    const inHand = this.inHandSeats(g);
    if (inHand.length === 1) { await this.finishHandFold(g, inHand[0]); return; }
    if (g.needToAct.length === 0) { await this.advanceStreet(g); return; }
    g.toAct = this.nextToAct(g, seatIdx);
    await this.putPoker(g);
    await this.sendPokerState(g);
  }

  async finishHandFold(g, winnerSeat) {
    const pot = g.seats.reduce((a, s) => a + (s ? s.totalBet : 0), 0);
    g.seats[winnerSeat].stack += pot;
    g.phase = "settled";
    g.toAct = null;
    g.needToAct = [];
    g.lastResult = { type: "fold", winners: [g.seats[winnerSeat].nick], pot, reveal: false };
    await this.putPoker(g);
    this.broadcast(systemMsg(`${g.seats[winnerSeat].nick} 赢得底池 ${this.fmtBB(pot)}bb（其余弃牌，不亮牌）`, Date.now()));
    await this.sendPokerState(g);
  }

  async advanceStreet(g) {
    const BB = 1;
    // 清本街下注
    for (const s of g.seats) if (s) s.streetBet = 0;
    g.currentBet = 0;
    g.minRaise = BB;
    const nextPhase = { preflop: "flop", flop: "turn", turn: "river", river: "showdown" }[g.phase];
    const dealN = nextPhase === "flop" ? 3 : (nextPhase === "turn" || nextPhase === "river") ? 1 : 0;
    for (let k = 0; k < dealN; k++) g.board.push(g.deck.shift());
    g.phase = nextPhase;
    if (g.phase === "showdown") { await this.showdown(g); return; }
    const canAct = this.inHandSeats(g).filter((i) => !g.seats[i].isAllIn);
    if (canAct.length <= 1) {
      // all-in 摊直：继续发到河牌
      await this.putPoker(g);
      await this.sendPokerState(g);
      await this.advanceStreet(g);
      return;
    }
    const active = g.handSeats.filter((i) => g.seats[i] && g.seats[i].inHand);
    const pos = derivePositions(active, g.buttonSeat);
    g.needToAct = pos.postflopOrder.filter((i) => g.seats[i].inHand && !g.seats[i].isAllIn);
    g.toAct = g.needToAct.length ? g.needToAct[0] : null;
    await this.putPoker(g);
    await this.sendPokerState(g);
  }

  orderFromButton(g, seats) {
    const out = [];
    for (let step = 1; step <= 3; step++) {
      const idx = (g.buttonSeat + step) % 3;
      if (seats.includes(idx)) out.push(idx);
    }
    return out;
  }

  splitPot(g, amount, winners, winnings) {
    const units = Math.round(amount / 0.5); // 半 bb 为最小单位
    const base = Math.floor(units / winners.length);
    let rem = units - base * winners.length;
    const ordered = this.orderFromButton(g, winners); // 庄家左手第一个赢家优先拿零头
    for (const i of ordered) {
      let u = base;
      if (rem > 0) { u += 1; rem -= 1; }
      winnings[i] = (winnings[i] || 0) + u * 0.5;
    }
  }

  async showdown(g) {
    g.phase = "showdown";
    const contenders = this.inHandSeats(g);
    const evals = {};
    for (const i of contenders) evals[i] = evaluateHand(g.seats[i].holeCards.concat(g.board));
    const players = [0, 1, 2].filter((i) => g.seats[i]).map((i) => ({ seat: i, total: g.seats[i].totalBet, folded: !g.seats[i].inHand }));
    const pots = buildPots(players);
    const winnings = {};
    const potInfos = [];
    for (const pot of pots) {
      const elig = pot.eligible.filter((i) => contenders.includes(i));
      let best = [];
      for (const i of elig) {
        if (best.length === 0) best = [i];
        else {
          const c = compareHands(evals[i], evals[best[0]]);
          if (c > 0) best = [i];
          else if (c === 0) best.push(i);
        }
      }
      this.splitPot(g, pot.amount, best, winnings);
      potInfos.push({ amount: pot.amount, winners: best.map((i) => g.seats[i].nick) });
    }
    for (const key of Object.keys(winnings)) g.seats[key].stack += winnings[key];
    g.phase = "settled";
    g.toAct = null;
    g.needToAct = [];
    g.lastResult = {
      type: "showdown", reveal: true, pots: potInfos,
      hands: contenders.map((i) => ({ nick: g.seats[i].nick, hole: g.seats[i].holeCards.slice() })),
      board: g.board.slice(),
    };
    await this.putPoker(g);
    const summary = potInfos.map((p, k) => `${pots.length > 1 ? (k === 0 ? "主池" : "边池" + k) : "底池"} ${this.fmtBB(p.amount)}bb → ${p.winners.join("、")}`).join("；");
    const reveal = contenders.map((i) => `${g.seats[i].nick}: ${g.seats[i].holeCards.join(" ")}`).join("｜");
    this.broadcast(systemMsg(`摊牌 ｜ 公共牌 ${g.board.join(" ")} ｜ ${reveal} ｜ ${summary}`, Date.now()));
    await this.sendPokerState(g);
  }

  async handlePoker(ws, msg) {
    const BUYIN = 50;
    const att = ws.deserializeAttachment() || {};
    const nick = att.nick || "访客";
    let g = await this.getPoker();

    if (msg.type === "poker_start") {
      if (await this.getGame()) { this.pokerErr(ws, "本房间已有斗地主牌局，不能同时开德州"); return; }
      if (g) { this.pokerErr(ws, "已有德州牌局"); return; }
      g = {
        phase: "waiting", starter: nick, buttonSeat: 0, handCount: 0,
        seats: [
          { nick, stack: BUYIN, inHand: false, hasFolded: false, isAllIn: false, holeCards: [], streetBet: 0, totalBet: 0 },
          null, null,
        ],
        handSeats: [], positions: null, board: [], deck: [],
        currentBet: 0, minRaise: 1, toAct: null, needToAct: [], lastResult: null,
      };
      await this.putPoker(g);
      this.broadcast(systemMsg(`${nick} 发起了德州扑克，点【加入牌桌】上桌（2~3 人），到齐点【下一手】开局`, Date.now()));
      await this.sendPokerState(g);
      return;
    }
    if (!g) { this.pokerErr(ws, "当前没有德州牌局，输入 /poker 发起"); return; }

    if (msg.type === "poker_join") {
      if (g.phase !== "waiting" && g.phase !== "settled") { this.pokerErr(ws, "本手进行中，稍后再上桌"); return; }
      if (this.pokerSeatOf(g, nick) >= 0) { this.pokerErr(ws, "你已在牌桌上"); return; }
      const empty = [0, 1, 2].find((i) => !g.seats[i]);
      if (empty == null) { this.pokerErr(ws, "牌桌已满（3 人）"); return; }
      g.seats[empty] = { nick, stack: BUYIN, inHand: false, hasFolded: false, isAllIn: false, holeCards: [], streetBet: 0, totalBet: 0 };
      await this.putPoker(g);
      const cnt = g.seats.filter(Boolean).length;
      this.broadcast(systemMsg(`${nick} 加入了德州牌桌（${cnt}/3）`, Date.now()));
      await this.sendPokerState(g);
      return;
    }

    if (msg.type === "poker_cancel") {
      if (g.phase !== "waiting") { this.pokerErr(ws, "牌局已开始，不能取消"); return; }
      await this.clearPoker();
      this.broadcast(systemMsg(`${nick} 取消了德州牌局`, Date.now()));
      this.broadcast(JSON.stringify({ type: "poker_state", phase: "none" }));
      return;
    }

    if (msg.type === "poker_next") {
      if (g.phase !== "waiting" && g.phase !== "settled") { this.pokerErr(ws, "本手还在进行"); return; }
      const active = [0, 1, 2].filter((i) => g.seats[i] && g.seats[i].stack > 0);
      if (active.length < 2) { this.pokerErr(ws, "有筹码的玩家不足 2 人，等待 buy-in"); return; }
      this.startHand(g);
      await this.putPoker(g);
      this.clearNonPokerPlayers(g);
      this.broadcast(systemMsg(`新一手开始：按钮 ${g.seats[g.positions.button].nick}，大盲 ${g.seats[g.positions.bb].nick}。轮到 ${g.seats[g.toAct].nick} 行动`, Date.now()));
      await this.sendPokerState(g);
      for (const i of g.handSeats) this.sendHole(g, i);
      return;
    }

    if (msg.type === "poker_action") {
      const i = this.pokerSeatOf(g, nick);
      if (i < 0) { this.pokerErr(ws, "你不在牌桌上"); return; }
      await this.handlePokerAction(ws, msg, g, i);
      return;
    }

    // Task 4/5：poker_buyin / poker_disband
    await this.handlePokerMisc(ws, msg, g, nick);
  }

  async handlePokerMisc(ws, msg, g, nick) {
    const BUYIN = 50;
    if (msg.type === "poker_buyin") {
      const i = this.pokerSeatOf(g, nick);
      if (i < 0) { this.pokerErr(ws, "你不在牌桌上"); return; }
      if (g.phase !== "waiting" && g.phase !== "settled") { this.pokerErr(ws, "只能在手间补充筹码"); return; }
      if (g.seats[i].stack > 0) { this.pokerErr(ws, "你还有筹码，无需 buy-in"); return; }
      g.seats[i].stack = BUYIN;
      await this.putPoker(g);
      this.broadcast(systemMsg(`${nick} 补充了 ${BUYIN}bb 筹码`, Date.now()));
      await this.sendPokerState(g);
      return;
    }
    // Task 5：poker_disband
    await this.handlePokerEnd(ws, msg, g, nick);
  }

  async handlePokerEnd(ws, msg, g, nick) {
    if (msg.type === "poker_disband") {
      if (this.pokerSeatOf(g, nick) < 0) { this.pokerErr(ws, "你不在牌桌上"); return; }
      const seatedNicks = g.seats.filter(Boolean).map((s) => s.nick);
      await this.clearPoker();
      this.broadcast(systemMsg(`${nick} 解散了德州牌桌`, Date.now()));
      for (const p of seatedNicks) {
        const pw = this.wsByNick(p);
        if (pw) { try { pw.send(JSON.stringify({ type: "poker_state", phase: "none" })); } catch {} }
      }
      return;
    }
    this.pokerErr(ws, "未知操作");
  }


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
    if (g.phase === "waiting") {
      // 招募阶段：广播给房间所有人，未上桌的人才能看到并点【加入牌桌】
      this.broadcast(payload);
    } else {
      for (const nick of g.players) {
        const ws = this.wsByNick(nick);
        if (ws) { try { ws.send(payload); } catch {} }
      }
    }
  }
  // 开局后清掉房间里非玩家残留的招募 bar
  clearNonPlayers(g) {
    const payload = JSON.stringify({ type: "ddz_state", phase: "none" });
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() || {};
      if (!g.players.includes(att.nick)) { try { ws.send(payload); } catch {} }
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
    const start = Number.isInteger(g.firstBidIndex) ? g.firstBidIndex : 0;
    g.bidOrder = g.players.slice(start).concat(g.players.slice(0, start));
    g.bidTurn = g.bidOrder[0];
    g.landlord = null;
    g.phase = "bidding";
  }

  async handleDdz(ws, msg) {
    const att = ws.deserializeAttachment() || {};
    const nick = att.nick || "访客";
    let g = await this.getGame();

    if (msg.type === "ddz_start") {
      if (await this.getPoker()) { this.ddzErr(ws, "本房间已有德州牌局，不能同时开斗地主"); return; }
      if (g) { this.ddzErr(ws, "已有牌局进行中"); return; }
      g = {
        phase: "waiting", players: [nick], starter: nick,
        hands: {}, bottom: [], bids: {}, bidOrder: [], bidTurn: null,
        landlord: null, current: null, lastPlay: null, passCount: 0,
        bombCount: 0, hasRocket: false, scores: {}, winner: null, firstBidIndex: 0,
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
        this.clearNonPlayers(g);
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
      // 广播重置：房间所有人的招募 bar 收起
      this.broadcast(JSON.stringify({ type: "ddz_state", phase: "none" }));
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
        this.broadcast(systemMsg(`${landlord} 当地主（底分 ${resolved.base}），底牌 ${g.bottom.map((c) => this.cardText(c)).join(" ")} ｜ 轮到 ${landlord} 出牌`, Date.now()));
        await this.sendDdzState(g);
        this.sendHand(g, landlord);
        return;
      }
      // 轮到下一个还没叫的人
      const i = g.bidOrder.indexOf(nick);
      g.bidTurn = g.bidOrder[(i + 1) % 3];
      this.broadcast(systemMsg(`轮到 ${g.bidTurn} 叫分`, Date.now()));
      await this.putGame(g);
      await this.sendDdzState(g);
      return;
    }

    // playing / settled 相关消息在 Task 6 处理
    await this.handleDdzPlay(ws, msg, g, nick);
  }

  async handleDdzPlay(ws, msg, g, nick) {
    if (msg.type === "ddz_hint") {
      if (g.phase !== "playing") { this.ddzErr(ws, "现在不能提示"); return; }
      if (nick !== g.current) { this.ddzErr(ws, "还没轮到你"); return; }
      const hand = g.hands[nick] || [];
      const last = g.lastPlay ? g.lastPlay.cards : null;
      const hint = chooseHint(hand, last);
      if (!hint) { this.ddzErr(ws, "没有能压过的牌，只能过"); return; }
      try { ws.send(JSON.stringify({ type: "ddz_hint", cards: sortCards(hint) })); } catch {}
      return;
    }

    if (msg.type === "ddz_pass") {
      if (g.phase !== "playing") { this.ddzErr(ws, "现在不能过"); return; }
      if (nick !== g.current) { this.ddzErr(ws, "还没轮到你"); return; }
      if (!g.lastPlay) { this.ddzErr(ws, "本轮到你先出，不能过"); return; }
      g.passCount += 1;
      if (g.passCount >= 2) {
        // 回到最后出牌者，自由出
        g.current = g.lastPlay.nick;
        g.lastPlay = null;
        g.passCount = 0;
      } else {
        g.current = this.nextSeat(g, nick);
      }
      this.broadcast(systemMsg(`${nick} 过 ｜ ${this.remainStr(g)} ｜ 轮到 ${g.current} 出牌`, Date.now()));
      await this.putGame(g);
      await this.sendDdzState(g);
      return;
    }

    if (msg.type === "ddz_play") {
      if (g.phase !== "playing") { this.ddzErr(ws, "现在不能出牌"); return; }
      if (nick !== g.current) { this.ddzErr(ws, "还没轮到你"); return; }
      const cards = Array.isArray(msg.cards) ? msg.cards : [];
      if (!this.handHasCards(g.hands[nick], cards)) { this.ddzErr(ws, "你没有这些牌"); return; }
      const info = identifyPlay(cards);
      if (!info) { this.ddzErr(ws, "不是合法牌型"); return; }
      const need = g.lastPlay ? g.lastPlay.cards : null;
      if (!beats(cards, need)) { this.ddzErr(ws, "压不过上一手"); return; }
      // 扣牌
      g.hands[nick] = this.removeCards(g.hands[nick], cards);
      if (info.type === "bomb") g.bombCount += 1;
      if (info.type === "rocket") g.hasRocket = true;
      g.lastPlay = { nick, cards: sortCards(cards), type: info.type };
      g.passCount = 0;
      const played = `${nick} 出 ${sortCards(cards).map((c) => this.cardText(c)).join(" ")} ｜ ${this.remainStr(g)}`;
      if (g.hands[nick].length === 0) {
        this.broadcast(systemMsg(played, Date.now()));
        await this.settle(g, nick);
        return;
      }
      g.current = this.nextSeat(g, nick);
      this.broadcast(systemMsg(`${played} ｜ 轮到 ${g.current} 出牌`, Date.now()));
      await this.putGame(g);
      await this.sendDdzState(g);
      this.sendHand(g, nick);
      return;
    }

    // Task 7: again / disband
    await this.handleDdzEnd(ws, msg, g, nick);
  }

  nextSeat(g, nick) {
    const i = g.players.indexOf(nick);
    return g.players[(i + 1) % 3];
  }
  handHasCards(hand, cards) {
    const pool = hand.slice();
    for (const c of cards) {
      const i = pool.indexOf(c);
      if (i < 0) return false;
      pool.splice(i, 1);
    }
    return true;
  }
  removeCards(hand, cards) {
    const pool = hand.slice();
    for (const c of cards) { const i = pool.indexOf(c); if (i >= 0) pool.splice(i, 1); }
    return pool;
  }

  async settle(g, winnerNick) {
    g.phase = "settled";
    g.winner = winnerNick;
    const landlordWon = winnerNick === g.landlord;
    const li = g.players.indexOf(g.landlord);
    const delta = computeScores(li, landlordWon, g.base, g.bombCount, g.hasRocket);
    for (let i = 0; i < 3; i++) {
      const p = g.players[i];
      g.scores[p] = (g.scores[p] || 0) + delta[i];
    }
    await this.putGame(g);
    const hands = g.players.map((p) => {
      const h = sortCards(g.hands[p] || []).map((c) => this.cardText(c)).join(" ");
      return `${p}：${h || "无"}`;
    }).join("；");
    const summary = g.players.map((p, i) => `${p} ${delta[i] >= 0 ? "+" : ""}${delta[i]}（累计 ${g.scores[p]}）`).join("，");
    this.broadcast(systemMsg(`本局结束，${landlordWon ? "地主" : "农民"}胜。剩余手牌 — ${hands}。${summary}`, Date.now()));
    await this.sendDdzState(g);
  }

  async handleDdzEnd(ws, msg, g, nick) {
    if (msg.type === "ddz_disband") {
      if (!g.players.includes(nick)) { this.ddzErr(ws, "你不在牌桌上"); return; }
      const board = this.rankBoard(g);
      await this.clearGame();
      this.broadcast(systemMsg(`${nick} ${g.phase === "settled" ? "散桌" : "退出，本局作废并散桌"}，累计分已清零`, Date.now()));
      if (board) this.broadcast(systemMsg(`本桌战绩 — ${board}。牌桌已解散。`, Date.now()));
      // 通知三家回到无牌局
      for (const p of (g.players || [])) {
        const pw = this.wsByNick(p);
        if (pw) { try { pw.send(JSON.stringify({ type: "ddz_state", phase: "none" })); } catch {} }
      }
      return;
    }
    if (msg.type === "ddz_again") {
      if (g.phase !== "settled") { this.ddzErr(ws, "本局还没结束"); return; }
      if (g.players.length !== 3) { this.ddzErr(ws, "有人离席，无法直接再来"); return; }
      const scores = g.scores; // 保留累计
      g.firstBidIndex = ((Number.isInteger(g.firstBidIndex) ? g.firstBidIndex : 0) + 1) % 3;
      this.startBidding(g);
      g.winner = null; g.lastPlay = null; g.current = null;
      g.bombCount = 0; g.hasRocket = false; g.scores = scores;
      await this.putGame(g);
      this.broadcast(systemMsg(`再来一局，${g.bidTurn} 先叫`, Date.now()));
      await this.sendDdzState(g);
      for (const p of g.players) this.sendHand(g, p);
      return;
    }
    this.ddzErr(ws, "未知操作");
  }
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
  #ddzbar { border-top: 1px solid #eee; background: #fff; padding: 8px 12px; display: none; }
  #ddzbar .btns { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 6px; }
  #ddzbar .btns button { padding: 6px 10px; font-size: 14px; }
  #ddzhand { display: flex; flex-wrap: wrap; gap: 4px; }
  #ddzhand .card { border: 1px solid #ccc; border-radius: 6px; padding: 4px 8px; font-size: 15px; cursor: pointer; user-select: none; background: #fafafa; }
  #ddzhand .card.sel { background: #2f6feb; color: #fff; border-color: #2f6feb; transform: translateY(-4px); }
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
      <button id="leave">离开</button>
    </header>
    <div id="status"></div>
    <div id="messages"></div>
    <div id="ddzbar">
      <div class="btns" id="ddzbtns"></div>
      <div id="ddzhand"></div>
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

  $("ddzquit").onclick = function () { ddzSend("ddz_disband"); };

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
      else if (m.type === "ddz_state") { if (m.resumed) addSystem(ddzResumeSummary(m)); renderDdz(m); }
      else if (m.type === "ddz_hand") { ddz.hand = m.cards || []; ddz.selected = {}; renderHand(); }
      else if (m.type === "ddz_hint") applyHint(m.cards || []);
      else if (m.type === "ddz_error") addSystem("⚠️ " + m.text);
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
