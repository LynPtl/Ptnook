import { describe, it, expect } from "vitest";
import { RANK_VALUE, makeDeck, deal, sortCards, identifyPlay } from "../src/ddz.js";

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
