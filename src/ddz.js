export const RANK_VALUE = {
  "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8, "9": 9, "10": 10,
  "J": 11, "Q": 12, "K": 13, "A": 14, "2": 15, "x": 16, "X": 17,
};

const NORMAL_RANKS = ["3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A", "2"];

export function makeDeck() {
  const deck = [];
  for (const r of NORMAL_RANKS) {
    for (let i = 0; i < 4; i++) deck.push(r);
  }
  deck.push("x");
  deck.push("X");
  return deck;
}

export function deal(deck) {
  const hands = [[], [], []];
  for (let i = 0; i < 51; i++) hands[i % 3].push(deck[i]);
  const bottom = deck.slice(51, 54);
  return { hands, bottom };
}

export function sortCards(cards) {
  return cards.slice().sort((a, b) => RANK_VALUE[a] - RANK_VALUE[b]);
}

function counts(cards) {
  const m = new Map();
  for (const c of cards) m.set(c, (m.get(c) || 0) + 1);
  return m;
}
function groupsByCount(m, n) {
  const arr = [];
  for (const [card, cnt] of m) if (cnt === n) arr.push(card);
  return arr.sort((a, b) => RANK_VALUE[a] - RANK_VALUE[b]);
}
// 判断一组点数值是否连续递增、且都 < 2（15）
function isConsecutive(values) {
  for (let i = 1; i < values.length; i++) {
    if (values[i] !== values[i - 1] + 1) return false;
  }
  return values[values.length - 1] < 15;
}

export function identifyPlay(cards) {
  if (!cards || cards.length === 0) return null;
  const n = cards.length;
  const m = counts(cards);
  const uniq = [...m.keys()];

  // rocket
  if (n === 2 && m.get("x") === 1 && m.get("X") === 1) {
    return { type: "rocket", rank: 100, len: 0 };
  }
  // bomb
  if (n === 4 && uniq.length === 1) {
    return { type: "bomb", rank: RANK_VALUE[uniq[0]], len: 0 };
  }
  if (n === 1) return { type: "single", rank: RANK_VALUE[cards[0]], len: 0 };
  if (n === 2 && uniq.length === 1) return { type: "pair", rank: RANK_VALUE[uniq[0]], len: 0 };
  if (n === 3 && uniq.length === 1) return { type: "triple", rank: RANK_VALUE[uniq[0]], len: 0 };
  if (n === 4) {
    const trip = groupsByCount(m, 3);
    if (trip.length === 1) return { type: "triple_single", rank: RANK_VALUE[trip[0]], len: 0 };
    return null;
  }
  if (n === 5) {
    const trip = groupsByCount(m, 3);
    const pair = groupsByCount(m, 2);
    if (trip.length === 1 && pair.length === 1) return { type: "triple_pair", rank: RANK_VALUE[trip[0]], len: 0 };
    // 顺子
    const vals = cards.map((c) => RANK_VALUE[c]).sort((a, b) => a - b);
    if (uniq.length === 5 && isConsecutive(vals)) return { type: "straight", rank: vals[0], len: 5 };
    return null;
  }
  // straight (>=5，全单，连续，<2)
  if (uniq.length === n && n >= 5) {
    const vals = cards.map((c) => RANK_VALUE[c]).sort((a, b) => a - b);
    if (isConsecutive(vals)) return { type: "straight", rank: vals[0], len: n };
  }
  // pair_straight (>=3 连对)
  {
    const pairs = groupsByCount(m, 2);
    if (pairs.length >= 3 && pairs.length * 2 === n) {
      const vals = pairs.map((c) => RANK_VALUE[c]);
      if (isConsecutive(vals)) return { type: "pair_straight", rank: vals[0], len: pairs.length };
    }
  }
  // four_two（四张 + 2 单）
  if (n === 6) {
    const four = groupsByCount(m, 4);
    if (four.length === 1) {
      const rest = cards.filter((c) => c !== four[0]);
      if (rest.length === 2 && rest[0] !== rest[1]) return { type: "four_two", rank: RANK_VALUE[four[0]], len: 0 };
    }
  }
  // plane 系列：找连续的三张组
  {
    const trips = groupsByCount(m, 3);
    if (trips.length >= 2) {
      const tv = trips.map((c) => RANK_VALUE[c]).sort((a, b) => a - b);
      // 取最长连续前缀段
      let best = [tv[0]];
      for (let i = 1; i < tv.length; i++) {
        if (tv[i] === best[best.length - 1] + 1 && tv[i] < 15) best.push(tv[i]);
        else break;
      }
      const g = best.length; // 连三组数
      if (g >= 2) {
        // plane 不带
        if (n === g * 3) return { type: "plane", rank: best[0], len: g };
        // plane_single: 额外 g 张单
        if (n === g * 4) {
          // 主体是这 g 个连续三张；其余任意（不再校验带牌形态更严格）
          return { type: "plane_single", rank: best[0], len: g };
        }
        // plane_pair: 额外 g 个对子
        if (n === g * 5) {
          const pairs = groupsByCount(m, 2);
          if (pairs.length === g) return { type: "plane_pair", rank: best[0], len: g };
        }
      }
    }
  }
  return null;
}
