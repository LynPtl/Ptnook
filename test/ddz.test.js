import { describe, it, expect } from "vitest";
import { RANK_VALUE, makeDeck, deal, sortCards } from "../src/ddz.js";

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
