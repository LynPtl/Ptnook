import { describe, it, expect } from "vitest";
import { CARD_RANK, makeDeck, evaluateHand, compareHands, buildPots, derivePositions, minRaiseTo, validateAction } from "../src/holdem.js";

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

describe("buildPots", () => {
  it("无 all-in：单一主池", () => {
    const pots = buildPots([
      { seat: 0, total: 10, folded: false },
      { seat: 1, total: 10, folded: false },
    ]);
    expect(pots).toEqual([{ amount: 20, eligible: [0, 1] }]);
  });
  it("弃牌者投入进池但无资格", () => {
    const pots = buildPots([
      { seat: 0, total: 10, folded: false },
      { seat: 1, total: 10, folded: true },
      { seat: 2, total: 10, folded: false },
    ]);
    expect(pots).toEqual([{ amount: 30, eligible: [0, 2] }]);
  });
  it("一人 all-in 少：主池 + 边池", () => {
    // seat0 全下 10，seat1、seat2 各 30
    const pots = buildPots([
      { seat: 0, total: 10, folded: false },
      { seat: 1, total: 30, folded: false },
      { seat: 2, total: 30, folded: false },
    ]);
    // 主池：10*3=30，三人有资格；边池：20*2=40，仅 1、2
    expect(pots).toEqual([
      { amount: 30, eligible: [0, 1, 2] },
      { amount: 40, eligible: [1, 2] },
    ]);
  });
  it("多人不同额 all-in：多层", () => {
    const pots = buildPots([
      { seat: 0, total: 5, folded: false },
      { seat: 1, total: 15, folded: false },
      { seat: 2, total: 40, folded: false },
    ]);
    // 层 5：5*3=15 {0,1,2}；层 15：10*2=20 {1,2}；层 40：25*1=25 {2}
    expect(pots).toEqual([
      { amount: 15, eligible: [0, 1, 2] },
      { amount: 20, eligible: [1, 2] },
      { amount: 25, eligible: [2] },
    ]);
  });
});

describe("derivePositions", () => {
  it("3 人：D/SB/BB 与行动顺序", () => {
    const p = derivePositions([0, 1, 2], 0);
    expect(p.button).toBe(0);
    expect(p.sb).toBe(1);
    expect(p.bb).toBe(2);
    expect(p.preflopOrder).toEqual([0, 1, 2]);
    expect(p.postflopOrder).toEqual([1, 2, 0]);
  });
  it("3 人：按钮在中间座位", () => {
    const p = derivePositions([0, 1, 2], 1);
    expect(p.button).toBe(1);
    expect(p.sb).toBe(2);
    expect(p.bb).toBe(0);
    expect(p.preflopOrder).toEqual([1, 2, 0]);
    expect(p.postflopOrder).toEqual([2, 0, 1]);
  });
  it("2 人单挑：D 兼 SB，preflop D 先 / postflop BB 先", () => {
    const p = derivePositions([0, 2], 0);
    expect(p.button).toBe(0);
    expect(p.sb).toBe(0);
    expect(p.bb).toBe(2);
    expect(p.preflopOrder).toEqual([0, 2]);
    expect(p.postflopOrder).toEqual([2, 0]);
  });
});

describe("validateAction 下注合法性", () => {
  const bb = 1;
  it("面对下注不能过牌", () => {
    const r = validateAction({ currentBet: 1, minRaise: 1, bigBlind: bb, streetBet: 0.5, stack: 49.5 }, "check");
    expect(r.ok).toBe(false);
  });
  it("无下注可过牌", () => {
    const r = validateAction({ currentBet: 0, minRaise: 1, bigBlind: bb, streetBet: 0, stack: 50 }, "check");
    expect(r.ok).toBe(true);
    expect(r.added).toBe(0);
  });
  it("跟注补齐差额", () => {
    const r = validateAction({ currentBet: 1, minRaise: 1, bigBlind: bb, streetBet: 0.5, stack: 49.5 }, "call");
    expect(r.ok).toBe(true);
    expect(r.added).toBe(0.5);
    expect(r.streetBetAfter).toBe(1);
  });
  it("跟注不够则全下（封顶为 stack）", () => {
    const r = validateAction({ currentBet: 10, minRaise: 1, bigBlind: bb, streetBet: 0, stack: 4 }, "call");
    expect(r.ok).toBe(true);
    expect(r.added).toBe(4);
    expect(r.allIn).toBe(true);
  });
  it("raise 不足最小加注被拒", () => {
    // currentBet 2，minRaise 2 → 最小加注到 4；raise 到 3 非法
    const r = validateAction({ currentBet: 2, minRaise: 2, bigBlind: bb, streetBet: 0, stack: 50 }, "raise", 3);
    expect(r.ok).toBe(false);
  });
  it("raise 到合法额通过并标记 raised", () => {
    const r = validateAction({ currentBet: 2, minRaise: 2, bigBlind: bb, streetBet: 0, stack: 50 }, "raise", 4);
    expect(r.ok).toBe(true);
    expect(r.streetBetAfter).toBe(4);
    expect(r.raised).toBe(true);
  });
  it("all-in 不足最小加注仍合法（短 all-in）", () => {
    // 只剩 3，currentBet 2，最小加注到 4，但 all-in 到 3 允许
    const r = validateAction({ currentBet: 2, minRaise: 2, bigBlind: bb, streetBet: 0, stack: 3 }, "allin");
    expect(r.ok).toBe(true);
    expect(r.allIn).toBe(true);
    expect(r.streetBetAfter).toBe(3);
  });
  it("preflop 开注下限 = 1bb（bet 小于 bb 且非全下被拒）", () => {
    const r = validateAction({ currentBet: 0, minRaise: 1, bigBlind: bb, streetBet: 0, stack: 50 }, "bet", 0.5);
    expect(r.ok).toBe(false);
    const ok = validateAction({ currentBet: 0, minRaise: 1, bigBlind: bb, streetBet: 0, stack: 50 }, "bet", 1);
    expect(ok.ok).toBe(true);
  });
  it("有下注时不能 bet（应 raise）", () => {
    const r = validateAction({ currentBet: 2, minRaise: 2, bigBlind: bb, streetBet: 0, stack: 50 }, "bet", 4);
    expect(r.ok).toBe(false);
  });
  it("fold 恒合法", () => {
    const r = validateAction({ currentBet: 5, minRaise: 1, bigBlind: bb, streetBet: 0, stack: 50 }, "fold");
    expect(r.ok).toBe(true);
    expect(r.folded).toBe(true);
  });
});

describe("minRaiseTo", () => {
  it("= currentBet + minRaise", () => {
    expect(minRaiseTo(2, 2)).toBe(4);
    expect(minRaiseTo(0, 1)).toBe(1);
  });
});
