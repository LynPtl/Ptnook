import { describe, it, expect } from "vitest";
import {
  sanitizeNick,
  sanitizeText,
  parseInbound,
  chatMsg,
  systemMsg,
  presenceMsg,
  historyMsg,
} from "../src/messages.js";

describe("sanitizeNick", () => {
  it("空白回退为访客", () => {
    expect(sanitizeNick("   ")).toBe("访客");
    expect(sanitizeNick(null)).toBe("访客");
  });
  it("去空白并截断到32", () => {
    expect(sanitizeNick("  小明  ")).toBe("小明");
    expect(sanitizeNick("a".repeat(50)).length).toBe(32);
  });
});

describe("sanitizeText", () => {
  it("非字符串或空返回null", () => {
    expect(sanitizeText(123)).toBeNull();
    expect(sanitizeText("   ")).toBeNull();
  });
  it("去空白并截断到2000", () => {
    expect(sanitizeText("  hi ")).toBe("hi");
    expect(sanitizeText("a".repeat(3000)).length).toBe(2000);
  });
});

describe("parseInbound", () => {
  it("合法chat消息", () => {
    expect(parseInbound(JSON.stringify({ type: "chat", text: "hi" }))).toEqual({ text: "hi" });
  });
  it("非法输入返回null", () => {
    expect(parseInbound("not json")).toBeNull();
    expect(parseInbound(JSON.stringify({ type: "chat", text: "  " }))).toBeNull();
    expect(parseInbound(JSON.stringify({ type: "other", text: "hi" }))).toBeNull();
  });
});

describe("builders", () => {
  it("chatMsg", () => {
    expect(JSON.parse(chatMsg("小明", "hi", 5))).toEqual({ type: "chat", nick: "小明", text: "hi", ts: 5 });
  });
  it("systemMsg", () => {
    expect(JSON.parse(systemMsg("x 加入了房间", 6))).toEqual({ type: "system", text: "x 加入了房间", ts: 6 });
  });
  it("presenceMsg", () => {
    expect(JSON.parse(presenceMsg(3))).toEqual({ type: "presence", count: 3 });
  });
});

describe("historyMsg", () => {
  it("构造 history 消息", () => {
    const items = [{ nick: "小明", text: "hi", ts: 5 }];
    expect(JSON.parse(historyMsg(items))).toEqual({ type: "history", items });
  });
  it("空历史 items 为空数组", () => {
    expect(JSON.parse(historyMsg([]))).toEqual({ type: "history", items: [] });
  });
});
