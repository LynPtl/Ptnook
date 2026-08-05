export const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"];
export const SUITS = ["s", "h", "d", "c"];
export const CARD_RANK = {
  "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8, "9": 9,
  "T": 10, "J": 11, "Q": 12, "K": 13, "A": 14,
};

export function makeDeck() {
  const deck = [];
  for (const r of RANKS) for (const s of SUITS) deck.push(r + s);
  return deck;
}

function cardRank(card) { return CARD_RANK[card.slice(0, -1)]; }
function cardSuit(card) { return card.slice(-1); }

// 生成 arr 中所有大小为 k 的组合
function combinations(arr, k) {
  const res = [];
  const idx = [];
  (function rec(start, depth) {
    if (depth === k) { res.push(idx.map((i) => arr[i])); return; }
    for (let i = start; i < arr.length; i++) { idx.push(i); rec(i + 1, depth + 1); idx.pop(); }
  })(0, 0);
  return res;
}

// 评估恰好 5 张牌，返回 { rank, tiebreak }
function rank5(cards) {
  const vals = cards.map(cardRank).sort((a, b) => b - a); // 降序
  const suits = cards.map(cardSuit);
  const isFlush = suits.every((s) => s === suits[0]);
  const cnt = new Map();
  for (const v of vals) cnt.set(v, (cnt.get(v) || 0) + 1);
  // 按 [数量降序, 点数降序] 排列分组
  const groups = [...cnt.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const counts = groups.map((g) => g[1]);
  const gv = groups.map((g) => g[0]);
  // 顺子判定
  const uniq = [...new Set(vals)].sort((a, b) => b - a);
  let straightHigh = 0;
  if (uniq.length === 5) {
    if (uniq[0] - uniq[4] === 4) straightHigh = uniq[0];
    else if (uniq[0] === 14 && uniq[1] === 5 && uniq[4] === 2) straightHigh = 5; // 轮子顺 A2345
  }
  if (isFlush && straightHigh) return { rank: 8, tiebreak: [straightHigh] };
  if (counts[0] === 4) return { rank: 7, tiebreak: [gv[0], gv[1]] };
  if (counts[0] === 3 && counts[1] === 2) return { rank: 6, tiebreak: [gv[0], gv[1]] };
  if (isFlush) return { rank: 5, tiebreak: vals };
  if (straightHigh) return { rank: 4, tiebreak: [straightHigh] };
  if (counts[0] === 3) return { rank: 3, tiebreak: gv };
  if (counts[0] === 2 && counts[1] === 2) return { rank: 2, tiebreak: [gv[0], gv[1], gv[2]] };
  if (counts[0] === 2) return { rank: 1, tiebreak: gv };
  return { rank: 0, tiebreak: vals };
}

function compareRank(a, b) {
  if (a.rank !== b.rank) return a.rank - b.rank;
  const n = Math.max(a.tiebreak.length, b.tiebreak.length);
  for (let i = 0; i < n; i++) {
    const x = a.tiebreak[i] || 0;
    const y = b.tiebreak[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

export function evaluateHand(cards) {
  const combos = cards.length === 5 ? [cards] : combinations(cards, 5);
  let best = null;
  for (const c of combos) {
    const r = rank5(c);
    if (!best || compareRank(r, best) > 0) best = r;
  }
  return best;
}

export function compareHands(a, b) {
  return compareRank(a, b);
}

export function buildPots(players) {
  const levels = [...new Set(players.filter((p) => p.total > 0).map((p) => p.total))].sort((a, b) => a - b);
  const raw = [];
  let prev = 0;
  for (const lvl of levels) {
    const layer = lvl - prev;
    const contributors = players.filter((p) => p.total >= lvl);
    const amount = layer * contributors.length;
    const eligible = contributors.filter((p) => !p.folded).map((p) => p.seat).sort((a, b) => a - b);
    if (amount > 0) raw.push({ amount, eligible });
    prev = lvl;
  }
  // 合并相邻 eligible 集合相同的层
  const merged = [];
  for (const pot of raw) {
    const last = merged[merged.length - 1];
    if (last && last.eligible.length === pot.eligible.length && last.eligible.every((s, i) => s === pot.eligible[i])) {
      last.amount += pot.amount;
    } else {
      merged.push({ amount: pot.amount, eligible: pot.eligible.slice() });
    }
  }
  return merged;
}

export function derivePositions(activeSeats, buttonSeat) {
  const n = activeSeats.length;
  const bi = activeSeats.indexOf(buttonSeat);
  const rot = activeSeats.slice(bi).concat(activeSeats.slice(0, bi)); // [button, ...顺时针]
  if (n === 2) {
    const [d, other] = rot;
    return { button: d, sb: d, bb: other, preflopOrder: [d, other], postflopOrder: [other, d] };
  }
  const [d, sb, bb] = rot; // n === 3
  return { button: d, sb, bb, preflopOrder: [d, sb, bb], postflopOrder: [sb, bb, d] };
}

export function minRaiseTo(currentBet, minRaise) {
  return currentBet + minRaise;
}

export function validateAction(ctx, action, amount) {
  const { currentBet, minRaise, streetBet, stack } = ctx;
  const bb = ctx.bigBlind;
  if (stack <= 0) return { ok: false, error: "无筹码可行动" };
  if (action === "fold") {
    return { ok: true, added: 0, streetBetAfter: streetBet, allIn: false, raised: false, folded: true };
  }
  if (action === "check") {
    if (streetBet !== currentBet) return { ok: false, error: "面对下注不能过牌" };
    return { ok: true, added: 0, streetBetAfter: streetBet, allIn: false, raised: false };
  }
  if (action === "call") {
    if (currentBet <= streetBet) return { ok: false, error: "无需跟注，可过牌" };
    const added = Math.min(currentBet - streetBet, stack);
    return { ok: true, added, streetBetAfter: streetBet + added, allIn: added === stack, raised: false };
  }
  if (action === "allin") {
    const added = stack;
    const after = streetBet + added;
    return { ok: true, added, streetBetAfter: after, allIn: true, raised: after > currentBet };
  }
  if (action === "bet") {
    if (currentBet !== 0) return { ok: false, error: "已有下注，请用加注" };
    if (typeof amount !== "number" || amount <= 0) return { ok: false, error: "下注额无效" };
    const added = amount - streetBet;
    if (added > stack) return { ok: false, error: "筹码不足" };
    const allIn = added === stack;
    if (amount < bb && !allIn) return { ok: false, error: `最小下注 ${bb}bb` };
    return { ok: true, added, streetBetAfter: amount, allIn, raised: true };
  }
  if (action === "raise") {
    if (currentBet === 0) return { ok: false, error: "无下注可加注，请用下注" };
    if (typeof amount !== "number") return { ok: false, error: "加注额无效" };
    const added = amount - streetBet;
    if (added <= 0) return { ok: false, error: "加注额无效" };
    if (added > stack) return { ok: false, error: "筹码不足" };
    const allIn = added === stack;
    if (amount < currentBet + minRaise && !allIn) {
      return { ok: false, error: `最小加注到 ${currentBet + minRaise}bb` };
    }
    return { ok: true, added, streetBetAfter: amount, allIn, raised: amount > currentBet };
  }
  return { ok: false, error: "未知动作" };
}
