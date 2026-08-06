import { describe, it, expect } from "vitest";
import { soundButtonLabel, pokerCardView, formatBb, halfBbAmount } from "../src/ui-helpers.js";

describe("ui helpers", () => {
  it("soundButtonLabel 显示当前提示音状态", () => {
    expect(soundButtonLabel(false)).toBe("提示音 开");
    expect(soundButtonLabel(true)).toBe("提示音 关");
  });

  it("pokerCardView 渲染 T 和红色花色", () => {
    expect(pokerCardView("Th")).toEqual({ text: "10♥", red: true });
    expect(pokerCardView("As")).toEqual({ text: "A♠", red: false });
    expect(pokerCardView("9d")).toEqual({ text: "9♦", red: true });
  });

  it("formatBb 保留必要的小数", () => {
    expect(formatBb(2)).toBe("2");
    expect(formatBb(2.5)).toBe("2.5");
    expect(formatBb(null)).toBe("0");
  });

  it("halfBbAmount 把任意输入归到 0.5bb 单位", () => {
    expect(halfBbAmount("2.3")).toBe(2.5);
    expect(halfBbAmount(2.24)).toBe(2);
    expect(halfBbAmount(2.25)).toBe(2.5);
  });
});
