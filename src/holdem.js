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
