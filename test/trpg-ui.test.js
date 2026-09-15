import { SELF, env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";

describe("跑团入口和房间占用", () => {
  it("提供独立页面、明确行动模式与数据告知", async () => {
    const html = await (await SELF.fetch("https://example.com/trpg")).text();
    expect(html).toContain("我的战役");
    expect(html).toContain("恢复码");
    expect(html).toContain("正式行动");
    expect(html).toContain("AI 服务商");
    const chat = await (await SELF.fetch("https://example.com/")).text();
    expect(chat).toContain('id="trpgOpen"');
    expect(chat).toContain('t === "/trpg"');
  });
  it("牌局创建与跑团抢占并发时只允许一个成功", async () => {
    await runInDurableObject(env.CHAT_ROOM.getByName("trpg-race"), async (room, ctx) => {
      const ws = { deserializeAttachment: () => ({ nick: "A" }), send: () => {} };
      await Promise.allSettled([room.handlePoker(ws, { type: "poker_start" }), room.claimTrpg("c1")]);
      expect(!!(await ctx.storage.get("holdem")) && !!(await room.activeTrpg())).toBe(false);
    });
  });
  it("牌局与战役互斥，暂停释放占用", async () => {
    await runInDurableObject(env.CHAT_ROOM.getByName("trpg-lock"), async (room, ctx) => {
      await ctx.storage.put("ddz", { phase: "waiting" });
      await expect(room.claimTrpg("c1")).rejects.toThrow();
      await ctx.storage.delete("ddz");
      await room.claimTrpg("c1");
      await expect(room.claimTrpg("c2")).rejects.toThrow();
      expect(await room.activeTrpg()).toBe("c1");
      await room.releaseTrpg("c2");
      expect(await room.activeTrpg()).toBe("c1");
      await room.releaseTrpg("c1");
      expect(await room.activeTrpg()).toBeNull();
    });
  });
});
