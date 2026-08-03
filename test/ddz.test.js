import { describe, it, expect } from "vitest";
import { RANK_VALUE, makeDeck, deal, sortCards, identifyPlay, beats, enumerateLegalPlays, resolveBids, computeScores } from "../src/ddz.js";

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
