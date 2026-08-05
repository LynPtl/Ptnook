import { describe, it, expect } from "vitest";
import { CARD_RANK, makeDeck, evaluateHand, compareHands } from "../src/holdem.js";

const ev = (cards) => evaluateHand(cards);
const cmp = (a, b) => compareHands(evaluateHand(a), evaluateHand(b));

describe("makeDeck", () => {
  it("52 张，无重复，每花色 13 张", () => {
    const d = makeDeck();
    expect(d.length).toBe(52);
    expect(new Set(d).size).toBe(52);
    expect(d.filter((c) => c.endsWith("s")).length).toBe(13);
  });
});

describe("CARD_RANK", () => {
  it("顺序正确", () => {
    expect(CARD_RANK["2"]).toBeLessThan(CARD_RANK["T"]);
    expect(CARD_RANK["T"]).toBe(10);
    expect(CARD_RANK["A"]).toBe(14);
  });
});

describe("evaluateHand 牌型识别", () => {
  it("同花顺 / 皇家", () => {
    expect(ev(["Ts", "Js", "Qs", "Ks", "As"]).rank).toBe(8);
    expect(ev(["2h", "3h", "4h", "5h", "6h"]).rank).toBe(8);
  });
  it("四条", () => { expect(ev(["9s", "9h", "9d", "9c", "2s"]).rank).toBe(7); });
  it("葫芦", () => { expect(ev(["9s", "9h", "9d", "2c", "2s"]).rank).toBe(6); });
  it("同花", () => { expect(ev(["2h", "5h", "8h", "Jh", "Kh"]).rank).toBe(5); });
  it("顺子", () => { expect(ev(["4s", "5h", "6d", "7c", "8s"]).rank).toBe(4); });
  it("轮子顺 A2345 高牌为 5", () => {
    const r = ev(["As", "2h", "3d", "4c", "5s"]);
    expect(r.rank).toBe(4);
    expect(r.tiebreak[0]).toBe(5);
  });
  it("三条 / 两对 / 一对 / 高牌", () => {
    expect(ev(["9s", "9h", "9d", "2c", "5s"]).rank).toBe(3);
    expect(ev(["9s", "9h", "2d", "2c", "5s"]).rank).toBe(2);
    expect(ev(["9s", "9h", "3d", "2c", "5s"]).rank).toBe(1);
    expect(ev(["9s", "7h", "3d", "2c", "5s"]).rank).toBe(0);
  });
  it("7 选 5 取最优（含 5 张公共 + 2 张底）", () => {
    // 底 AsAh + 公共 Ad Kc Kd 2s 3h → 葫芦 AAA KK
    expect(ev(["As", "Ah", "Ad", "Kc", "Kd", "2s", "3h"]).rank).toBe(6);
  });
});

describe("compareHands", () => {
  it("不同档比档", () => {
    expect(cmp(["As", "Ah", "Ad", "Kc", "Kd"], ["As", "Ah", "2d", "2c", "5s"])).toBeGreaterThan(0);
  });
  it("同档比踢脚", () => {
    // 一对 A 带 K 踢 vs 一对 A 带 Q 踢
    expect(cmp(["As", "Ah", "Ks", "5d", "3c"], ["Ad", "Ac", "Qs", "5h", "3d"])).toBeGreaterThan(0);
  });
  it("完全同型平手", () => {
    expect(cmp(["As", "Ah", "Ks", "5d", "3c"], ["Ad", "Ac", "Kh", "5s", "3d"])).toBe(0);
  });
  it("同花顺压四条", () => {
    expect(cmp(["2h", "3h", "4h", "5h", "6h"], ["9s", "9h", "9d", "9c", "As"])).toBeGreaterThan(0);
  });
});
