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

export function beats(play, last) {
  const a = identifyPlay(play);
  if (!a) return false;
  if (!last || last.length === 0) return true;
  const b = identifyPlay(last);
  if (!b) return true; // 上家非法，视作自由出
  if (a.type === "rocket") return true;
  if (b.type === "rocket") return false;
  if (a.type === "bomb" && b.type !== "bomb") return true;
  if (b.type === "bomb" && a.type !== "bomb") return false;
  if (a.type !== b.type) return false;
  if (a.len !== b.len) return false;
  return a.rank > b.rank;
}

// 生成 hand 中所有大小为 k 的组合（去重，基于排序后的索引）
function combinations(arr, k) {
  const res = [];
  const n = arr.length;
  const idx = [];
  (function rec(start, depth) {
    if (depth === k) { res.push(idx.map((i) => arr[i])); return; }
    for (let i = start; i < n; i++) {
      idx.push(i);
      rec(i + 1, depth + 1);
      idx.pop();
    }
  })(0, 0);
  return res;
}

export function enumerateLegalPlays(hand, last) {
  const sorted = sortCards(hand);
  const seen = new Set();
  const out = [];
  const maxLen = last && last.length ? Math.max(sorted.length, 0) : sorted.length;
  // 组合规模：为控制枚举量，最长枚举到手牌长度；斗地主单手 ≤20，可接受
  for (let k = 1; k <= sorted.length; k++) {
    for (const combo of combinations(sorted, k)) {
      const key = combo.slice().sort((a, b) => RANK_VALUE[a] - RANK_VALUE[b]).join(",");
      if (seen.has(key)) continue;
      if (identifyPlay(combo) && beats(combo, last)) {
        seen.add(key);
        out.push(combo);
      } else {
        seen.add(key);
      }
    }
  }
  return out;
}

export function resolveBids(bids) {
  let best = -1, idx = -1;
  for (let i = 0; i < bids.length; i++) {
    if (bids[i] > best) { best = bids[i]; idx = i; }
  }
  if (best <= 0) return null;
  return { landlordIndex: idx, base: best };
}

export function computeScores(landlordIndex, landlordWon, base, bombCount, hasRocket) {
  let mult = base * Math.pow(2, bombCount) * (hasRocket ? 2 : 1);
  const res = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    if (i === landlordIndex) res[i] = landlordWon ? mult * 2 : -mult * 2;
    else res[i] = landlordWon ? -mult : mult;
  }
  return res;
}

export function pickHint(plays) {
  if (!plays || plays.length === 0) return null;
  let best = null;
  let bestLen = Infinity;
  let bestRank = Infinity;
  for (const play of plays) {
    const info = identifyPlay(play);
    const rank = info ? info.rank : Infinity;
    if (play.length < bestLen || (play.length === bestLen && rank < bestRank)) {
      best = play;
      bestLen = play.length;
      bestRank = rank;
    }
  }
  return best;
}

// 贪心把手牌分解为成型牌组 / 孤对 / 孤张
export function decompose(hand) {
  let pool = sortCards(hand);
  const groups = [];

  const removeCards = (arr, cards) => {
    const p = arr.slice();
    for (const c of cards) { const i = p.indexOf(c); if (i >= 0) p.splice(i, 1); }
    return p;
  };
  const cnt = () => {
    const m = new Map();
    for (const c of pool) m.set(c, (m.get(c) || 0) + 1);
    return m;
  };

  // 1) 王炸
  if (pool.includes("x") && pool.includes("X")) {
    groups.push({ type: "rocket", cards: ["x", "X"] });
    pool = removeCards(pool, ["x", "X"]);
  }
  // 2) 炸弹
  for (;;) {
    const m = cnt();
    let bomb = null;
    for (const [c, k] of m) if (k === 4) { bomb = c; break; }
    if (!bomb) break;
    groups.push({ type: "bomb", cards: [bomb, bomb, bomb, bomb] });
    pool = removeCards(pool, [bomb, bomb, bomb, bomb]);
  }
  // 3) 飞机（≥2 连续三条），最长优先
  for (;;) {
    const m = cnt();
    const trips = [...m.entries()].filter(([, k]) => k >= 3).map(([c]) => RANK_VALUE[c]).sort((a, b) => a - b);
    let best = [];
    for (let i = 0; i < trips.length; i++) {
      let run = [trips[i]];
      for (let j = i + 1; j < trips.length; j++) {
        if (trips[j] === run[run.length - 1] + 1 && trips[j] < 15) run.push(trips[j]);
        else break;
      }
      if (run.length > best.length) best = run;
    }
    if (best.length < 2) break;
    const cards = [];
    for (const v of best) {
      const c = Object.keys(RANK_VALUE).find((k) => RANK_VALUE[k] === v);
      cards.push(c, c, c);
    }
    groups.push({ type: "plane", cards });
    pool = removeCards(pool, cards);
  }
  // 4) 顺子（≥5 连续单张，不含 2/王），最长优先
  for (;;) {
    const m = cnt();
    const avail = [...m.keys()].map((c) => RANK_VALUE[c]).filter((v) => v < 15).sort((a, b) => a - b);
    let best = [];
    for (let i = 0; i < avail.length; i++) {
      let run = [avail[i]];
      for (let j = i + 1; j < avail.length; j++) {
        if (avail[j] === run[run.length - 1] + 1) run.push(avail[j]);
        else break;
      }
      if (run.length > best.length) best = run;
    }
    if (best.length < 5) break;
    const cards = best.map((v) => Object.keys(RANK_VALUE).find((k) => RANK_VALUE[k] === v));
    groups.push({ type: "straight", cards });
    pool = removeCards(pool, cards);
  }
  // 5) 连对（≥3 连续对子，不含 2/王），最长优先
  for (;;) {
    const m = cnt();
    const pairRanks = [...m.entries()].filter(([, k]) => k >= 2).map(([c]) => RANK_VALUE[c]).filter((v) => v < 15).sort((a, b) => a - b);
    let best = [];
    for (let i = 0; i < pairRanks.length; i++) {
      let run = [pairRanks[i]];
      for (let j = i + 1; j < pairRanks.length; j++) {
        if (pairRanks[j] === run[run.length - 1] + 1) run.push(pairRanks[j]);
        else break;
      }
      if (run.length > best.length) best = run;
    }
    if (best.length < 3) break;
    const cards = [];
    for (const v of best) {
      const c = Object.keys(RANK_VALUE).find((k) => RANK_VALUE[k] === v);
      cards.push(c, c);
    }
    groups.push({ type: "pair_straight", cards });
    pool = removeCards(pool, cards);
  }
  // 6) 三条
  for (;;) {
    const m = cnt();
    let trip = null;
    for (const [c, k] of m) if (k === 3) { trip = c; break; }
    if (!trip) break;
    groups.push({ type: "triple", cards: [trip, trip, trip] });
    pool = removeCards(pool, [trip, trip, trip]);
  }
  // 7) 剩余对子（孤对）
  const pairs = [];
  for (;;) {
    const m = cnt();
    let pr = null;
    for (const [c, k] of m) if (k === 2) { pr = c; break; }
    if (!pr) break;
    pairs.push([pr, pr]);
    pool = removeCards(pool, [pr, pr]);
  }
  // 8) 剩余孤张
  const singles = sortCards(pool);
  return { groups, pairs, singles };
}
