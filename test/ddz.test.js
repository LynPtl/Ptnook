import { describe, it, expect } from "vitest";
import { RANK_VALUE, makeDeck, deal, sortCards, identifyPlay, beats, enumerateLegalPlays, resolveBids, computeScores, pickHint, decompose, chooseHint } from "../src/ddz.js";

describe("makeDeck", () => {
  it("54 张，含双王，每普通点数 4 张", () => {
    const d = makeDeck();
    expect(d.length).toBe(54);
    expect(d.filter((c) => c === "x").length).toBe(1);
    expect(d.filter((c) => c === "X").length).toBe(1);
    expect(d.filter((c) => c === "3").length).toBe(4);
    expect(d.filter((c) => c === "2").length).toBe(4);
  });
});

describe("deal", () => {
  it("三家各 17，底牌 3", () => {
    const { hands, bottom } = deal(makeDeck());
    expect(hands[0].length).toBe(17);
    expect(hands[1].length).toBe(17);
    expect(hands[2].length).toBe(17);
    expect(bottom.length).toBe(3);
  });
});

describe("sortCards", () => {
  it("按点数升序，王最大", () => {
    expect(sortCards(["X", "3", "2", "x", "K"])).toEqual(["3", "K", "2", "x", "X"]);
  });
});

describe("RANK_VALUE", () => {
  it("顺序正确", () => {
    expect(RANK_VALUE["3"]).toBeLessThan(RANK_VALUE["10"]);
    expect(RANK_VALUE["2"]).toBeLessThan(RANK_VALUE["x"]);
    expect(RANK_VALUE["x"]).toBeLessThan(RANK_VALUE["X"]);
  });
});

describe("identifyPlay", () => {
  const t = (cards) => identifyPlay(cards);
  it("单/对/三/炸/火", () => {
    expect(t(["5"])).toMatchObject({ type: "single", rank: 5 });
    expect(t(["5", "5"])).toMatchObject({ type: "pair", rank: 5 });
    expect(t(["5", "5", "5"])).toMatchObject({ type: "triple", rank: 5 });
    expect(t(["5", "5", "5", "5"])).toMatchObject({ type: "bomb", rank: 5 });
    expect(t(["x", "X"])).toMatchObject({ type: "rocket" });
  });
  it("三带一/三带对", () => {
    expect(t(["5", "5", "5", "3"])).toMatchObject({ type: "triple_single", rank: 5 });
    expect(t(["5", "5", "5", "3", "3"])).toMatchObject({ type: "triple_pair", rank: 5 });
  });
  it("顺子/连对", () => {
    expect(t(["3", "4", "5", "6", "7"])).toMatchObject({ type: "straight", rank: 3, len: 5 });
    expect(t(["3", "4", "5", "6"])).toBeNull(); // <5 不成顺
    expect(t(["3", "3", "4", "4", "5", "5"])).toMatchObject({ type: "pair_straight", rank: 3, len: 3 });
    expect(t(["2", "2", "3", "3", "4", "4"])).toBeNull(); // 含 2 不成连对
  });
  it("飞机及带牌", () => {
    expect(t(["3", "3", "3", "4", "4", "4"])).toMatchObject({ type: "plane", rank: 3, len: 2 });
    expect(t(["3", "3", "3", "4", "4", "4", "5", "6"])).toMatchObject({ type: "plane_single", rank: 3, len: 2 });
    expect(t(["3", "3", "3", "4", "4", "4", "5", "5", "6", "6"])).toMatchObject({ type: "plane_pair", rank: 3, len: 2 });
  });
  it("四带二（两单，非炸）", () => {
    expect(t(["8", "8", "8", "8", "3", "5"])).toMatchObject({ type: "four_two", rank: 8 });
  });
  it("非法返回 null", () => {
    expect(t([])).toBeNull();
    expect(t(["3", "4"])).toBeNull();
    expect(t(["3", "3", "3", "3", "4", "4"])).toBeNull(); // 四带二只允许两单
  });
});

describe("beats", () => {
  it("空上家：合法即可出", () => {
    expect(beats(["5"], null)).toBe(true);
    expect(beats(["3", "4"], null)).toBe(false); // 非法
  });
  it("同类型比大小", () => {
    expect(beats(["6"], ["5"])).toBe(true);
    expect(beats(["5"], ["6"])).toBe(false);
    expect(beats(["5", "5"], ["4", "4"])).toBe(true);
  });
  it("炸弹与火箭", () => {
    expect(beats(["5", "5", "5", "5"], ["A"])).toBe(true); // 炸压单
    expect(beats(["6", "6", "6", "6"], ["5", "5", "5", "5"])).toBe(true);
    expect(beats(["x", "X"], ["6", "6", "6", "6"])).toBe(true); // 火压炸
    expect(beats(["5"], ["6", "6", "6", "6"])).toBe(false);
  });
  it("类型不同不能压", () => {
    expect(beats(["5", "5"], ["6"])).toBe(false);
  });
  it("顺子需同长度", () => {
    expect(beats(["4","5","6","7","8"], ["3","4","5","6","7"])).toBe(true);
    expect(beats(["4","5","6","7","8","9"], ["3","4","5","6","7"])).toBe(false);
  });
});

describe("enumerateLegalPlays", () => {
  it("自由出：至少含单张与对子", () => {
    const plays = enumerateLegalPlays(["5", "5", "6"], null);
    const has = (arr) => plays.some((p) => p.slice().sort().join() === arr.slice().sort().join());
    expect(has(["5"])).toBe(true);
    expect(has(["6"])).toBe(true);
    expect(has(["5", "5"])).toBe(true);
  });
  it("应对单张：只出得起更大的单或炸/火", () => {
    const plays = enumerateLegalPlays(["6", "7", "7", "7", "7"], ["5"]);
    // 6 可压 5；7 可压 5；四个 7 是炸弹
    expect(plays.some((p) => p.length === 1 && p[0] === "6")).toBe(true);
    expect(plays.some((p) => p.length === 4)).toBe(true);
  });
  it("要不起返回空", () => {
    expect(enumerateLegalPlays(["3", "4"], ["A", "A"])).toEqual([]);
  });
});

describe("resolveBids", () => {
  it("最高分当地主", () => {
    expect(resolveBids([1, 3, 2])).toEqual({ landlordIndex: 1, base: 3 });
    expect(resolveBids([2, 0, 2])).toEqual({ landlordIndex: 0, base: 2 });
  });
  it("全不叫返回 null", () => {
    expect(resolveBids([0, 0, 0])).toBeNull();
  });
});

describe("computeScores", () => {
  it("地主赢，无炸，底分2", () => {
    // mult = 2；地主 +4，农民各 -2
    expect(computeScores(0, true, 2, 0, false)).toEqual([4, -2, -2]);
  });
  it("地主输，1炸，底分1", () => {
    // mult = 1*2 = 2；地主 -4，农民 +2
    expect(computeScores(2, false, 1, 1, false)).toEqual([2, 2, -4]);
  });
  it("火箭翻倍", () => {
    // base1, 0炸, 火箭 → mult = 1*2 = 2；地主赢 +4，农民 -2
    expect(computeScores(1, true, 1, 0, true)).toEqual([-2, 4, -2]);
  });
});

describe("pickHint", () => {
  it("空候选返回 null", () => {
    expect(pickHint([])).toBeNull();
  });
  it("牌数最少优先", () => {
    // 一手单张(1张) vs 一手对子(2张) → 选单张
    const plays = [["5", "5"], ["6"]];
    expect(pickHint(plays)).toEqual(["6"]);
  });
  it("牌数相同按 rank 最小", () => {
    // 两手单张 6 与 9 → 选 6
    const plays = [["9"], ["6"]];
    expect(pickHint(plays)).toEqual(["6"]);
  });
  it("从多手里选最小的单张", () => {
    const plays = [["K"], ["7"], ["10"]];
    expect(pickHint(plays)).toEqual(["7"]);
  });
});

describe("decompose", () => {
  it("提取顺子后剩散单", () => {
    // 3 4 5 6 7 顺子 + 9 孤张
    const d = decompose(["3", "4", "5", "6", "7", "9"]);
    expect(d.groups.some((g) => g.type === "straight" && g.cards.length === 5)).toBe(true);
    expect(d.singles).toContain("9");
  });
  it("对子与孤张区分", () => {
    // 8 8 对 + 5 孤张（无顺子/连对）
    const d = decompose(["8", "8", "5"]);
    expect(d.pairs.some((p) => p[0] === "8" && p[1] === "8")).toBe(true);
    expect(d.singles).toEqual(["5"]);
  });
  it("炸弹进 groups", () => {
    const d = decompose(["9", "9", "9", "9", "3"]);
    expect(d.groups.some((g) => g.type === "bomb")).toBe(true);
    expect(d.singles).toContain("3");
  });
  it("三条进 groups", () => {
    const d = decompose(["7", "7", "7", "4"]);
    expect(d.groups.some((g) => g.type === "triple")).toBe(true);
    expect(d.singles).toContain("4");
  });
  it("连对进 groups", () => {
    // 3 3 4 4 5 5 连对
    const d = decompose(["3", "3", "4", "4", "5", "5"]);
    expect(d.groups.some((g) => g.type === "pair_straight")).toBe(true);
    expect(d.pairs.length).toBe(0);
    expect(d.singles.length).toBe(0);
  });
});

describe("decompose 纯料约束（不拆对/三条凑顺子）", () => {
  it("三条不被顺子借走：QQQ 保留为三条", () => {
    // 8 9 10 J Q Q Q K A：Q 有三张，不应被顺子借走一张
    const d = decompose(["8", "9", "10", "J", "Q", "Q", "Q", "K", "A"]);
    expect(d.groups.some((g) => g.type === "triple" && g.cards.join() === "Q,Q,Q")).toBe(true);
    // Q 不应作为孤张出现在 singles
    expect(d.singles).not.toContain("Q");
  });

  it("bug 手牌：不产生假孤张 Q，QQQ 成三条", () => {
    const hand = ["6", "6", "6", "8", "9", "9", "10", "10", "J", "J", "Q", "Q", "Q", "K", "K", "A", "A", "2", "2", "x"];
    const d = decompose(hand);
    expect(d.singles).not.toContain("Q");
    expect(d.groups.some((g) => g.type === "triple" && g.cards.join() === "Q,Q,Q")).toBe(true);
    expect(d.groups.some((g) => g.type === "triple" && g.cards.join() === "6,6,6")).toBe(true);
  });

  it("对子不被顺子借走：只用单张料成顺", () => {
    // 3 4 5 6 7 7：7 有两张（对料），顺子只能用单张 3 4 5 6 + 一个7？
    // 纯料规则：7 出现2次 → 不进顺子 → 3-6 仅4连 <5 → 不成顺子 → 3 4 5 6 皆孤张，77 为孤对
    const d = decompose(["3", "4", "5", "6", "7", "7"]);
    expect(d.groups.some((g) => g.type === "straight")).toBe(false);
    expect(d.pairs.some((p) => p.join() === "7,7")).toBe(true);
    expect(d.singles).toEqual(["3", "4", "5", "6"]);
  });

  it("纯单张料仍能成顺子", () => {
    // 3 4 5 6 7 全单张 → 顺子
    const d = decompose(["3", "4", "5", "6", "7"]);
    expect(d.groups.some((g) => g.type === "straight" && g.cards.length === 5)).toBe(true);
  });
});

describe("chooseHint", () => {
  it("规则0：能一手走完就全出（自由出，整手是顺子）", () => {
    const hand = ["3", "4", "5", "6", "7"];
    expect(chooseHint(hand, null)).toEqual(["3", "4", "5", "6", "7"]);
  });
  it("规则0：跟牌能一手压过就全出", () => {
    // 手里就一对 KK，上家出一对 5 → 全出 KK
    expect(chooseHint(["K", "K"], ["5", "5"])).toEqual(["K", "K"]);
  });
  it("规则1：跟单张时用孤张而非拆顺子", () => {
    // 手: 6(孤张) + 8 9 10 J Q(顺子)；上家出 5 → 应出 6，不拆顺子
    const hand = ["6", "8", "9", "10", "J", "Q"];
    expect(chooseHint(hand, ["5"])).toEqual(["6"]);
  });
  it("规则1：跟牌优先不拆顺子，宁可出更大的孤张", () => {
    // 手: 4 5 6 7 8 顺子 + J 孤张；上家出 3
    // 最小的能压牌是 4，但出 4 会拆顺子；J 是孤张不拆 → 应出 J
    const hand = ["4", "5", "6", "7", "8", "J"];
    expect(chooseHint(hand, ["3"])).toEqual(["J"]);
  });
  it("规则1：不拆长顺子，宁可出孤张（6连）", () => {
    // 手: 4 5 6 7 8 9 六连顺 + J 孤张；上家出 3
    // 出 4 会把六连削成五连(仍是顺子但拆了)，出 J 不动顺子 → 应出 J
    const hand = ["4", "5", "6", "7", "8", "9", "J"];
    expect(chooseHint(hand, ["3"])).toEqual(["J"]);
  });
  it("规则2：只有炸弹能压才出炸", () => {
    // 手: 三个... 用四张 7 作炸；上家出对 A，手里没有更大的对 → 出炸弹 7777
    const hand = ["7", "7", "7", "7", "3"];
    expect(chooseHint(hand, ["A", "A"])).toEqual(["7", "7", "7", "7"]);
  });
  it("要不起返回 null", () => {
    // 手: 3 4，上家出 2 → 压不过，且非整手可压 → null
    expect(chooseHint(["3", "4"], ["2"])).toBeNull();
  });
  it("规则3：自由出先出最小孤张", () => {
    // 手: 3(孤张) + 8 8(对) + 9 9 9(三条)；自由出 → 出 3
    const hand = ["3", "8", "8", "9", "9", "9"];
    expect(chooseHint(hand, null)).toEqual(["3"]);
  });
});
