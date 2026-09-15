import { env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { createCharacter } from "../src/trpg-rules.js";

async function campaign(fn) {
  return runInDurableObject(env.TRPG_CAMPAIGN.getByName(crypto.randomUUID()), async instance => {
    const player = { id: "owner", name: "发起人" };
    instance.initialize("campaign", player, { name: "边界测试", boundaries: [] });
    const s = instance.state();
    s.members[0].character = createCharacter("owner", { name: "主角", role: "guard", background: "旅人", wish: "探索", boundary: "保护队友", bond: "同行" });
    instance.save(s);
    await fn(instance, player);
  });
}

describe("战役状态不变量", () => {
  it("归档不能被重复归档覆盖来源，不能在归档中改角色或约定", async () => {
    await campaign(async (instance, player) => {
      const s = instance.state(); s.status = "paused"; instance.save(s);
      await instance.command(player, { type: "archive" });
      await expect(instance.command(player, { type: "archive" })).rejects.toThrow();
      await expect(instance.command(player, { type: "preferences", away: true, boundaries: [] })).rejects.toThrow();
      await instance.command(player, { type: "unarchive" });
      expect(instance.state().status).toBe("paused");
    });
  });
  it("更换出席成员前清理未锁定行动，不能执行缺席者旧草稿", async () => {
    await campaign(async (instance, player) => {
      const s = instance.state(); s.status = "paused"; s.drafts = { owner: { kind: "action", text: "旧行动" } }; instance.save(s);
      await instance.command(player, { type: "preferences", away: true, boundaries: [] });
      expect(instance.state().drafts).toEqual({});
    });
  });
  it("危急时先暂停但不丢失已结算结果，alarm 能恢复 settled 作业", async () => {
    await campaign(async instance => {
      const s = instance.state(); s.status = "paused"; s.job = { id: "lost", phase: "settled", started: 0, result: { facts: ["骰子已保存"], checks: [] } }; instance.save(s);
      await instance.alarm();
      expect(instance.state().job.phase).toBe("failed_narration");
      expect(instance.state().job.result.facts).toEqual(["骰子已保存"]);
    });
  });
  it("拒绝过期页面操作，防止误将旧场景行为提交到新场景", async () => {
    await campaign(async (instance, player) => {
      const s = instance.state(); s.status = "exploration"; s.attending = [player.id]; instance.save(s);
      await expect(instance.command(player, { type: "draft", context: "gate:0:exploration", kind: "action", option: "notice", text: "观察" })).rejects.toThrow("更新");
      expect(instance.state().drafts).toEqual({});
    });
  });
  it("结局叙述失败时仍能发布已保存的系统简报", async () => {
    await campaign(async (instance, player) => {
      const s = instance.state(); s.status = "ended"; s.ending = "keep"; s.attending = [player.id]; s.job = { id: "ending", phase: "failed_narration", result: { facts: ["旧约受到公开监督"], checks: [] } }; instance.save(s);
      await instance.command(player, { type: "brief" });
      expect(instance.state().status).toBe("ended"); expect(instance.state().job).toBeNull();
    });
  });
  it("纠错只能引用已存在记录，生成更正记录而不改变骰子", async () => {
    await campaign(async (instance, player) => {
      const s = instance.state(); s.status = "paused"; instance.event(s, "resolution", "判定", { result: { facts: ["队伍取得许可"], checks: [{ total: 16 }] }, operation: "roll" });
      instance.event(s, "story", "文案误称队伍被拒绝", { operation: "roll" }); instance.save(s);
      const id = s.lastEvent;
      await instance.command(player, { type: "report", event: id, text: "与判定不符" });
      expect(instance.state().correction.event).toBe(id);
      await instance.command(player, { type: "correct_brief" });
      const logs = instance.listEvents(player);
      expect(logs.at(-1).title).toContain("队伍取得许可");
      expect(logs.find(e => e.kind === "resolution").result.checks[0].total).toBe(16);
    });
  });
  it("双方确认后转移药剂，不允许从队友背包直接取走", async () => {
    await campaign(async (instance, player) => {
      const s = instance.state(); s.status = "paused";
      s.members.push({ id: "b", name: "乙", character: { ...structuredClone(s.members[0].character), owner: "b", items: [] }, boundaries: [] }); instance.save(s);
      await instance.command(player, { type: "offer_item", player: "b", item: "potion" });
      expect(instance.state().members[0].character.items[0].count).toBe(1);
      await expect(instance.command(player, { type: "accept_item" })).rejects.toThrow();
      await instance.command({ id: "b" }, { type: "accept_item" });
      expect(instance.state().members[1].character.items[0].count).toBe(1);
    });
  });
  it("修改开团约定后全队重新准备，启动过程中禁止修改成员状态", async () => {
    await campaign(async (instance, player) => {
      const s = instance.state(); s.members[0].ready = true;
      s.members.push({ id: "b", name: "乙", ready: true, boundaries: [], character: null }); instance.save(s);
      await instance.command(player, { type: "preferences", away: true, boundaries: ["恐怖"] });
      expect(instance.state().members.every(m => !m.ready)).toBe(true);
      const current = instance.state(); current.startToken = "starting"; current.startingAt = Date.now(); instance.save(current);
      await expect(instance.command(player, { type: "ready", ready: true })).rejects.toThrow("启动");
    });
  });
  it("已有恢复关系的角色不能在开团后反复重建刷药剂", async () => {
    await campaign(async (instance, player) => {
      const s = instance.state(); s.started = true; s.status = "paused"; s.members[0].character.items[0].count = 0; instance.save(s);
      await expect(instance.command(player, { type: "character", character: s.members[0].character })).rejects.toThrow();
      expect(instance.state().members[0].character.items[0].count).toBe(0);
    });
  });
  it("开场调整角色保留背包，不允许重复领取起始药剂", async () => {
    await campaign(async (instance, player) => {
      const s = instance.state(); s.members[0].character.items[0].count = 0; instance.save(s);
      await instance.command(player, { type: "character", character: { ...s.members[0].character, name: "修改名字" } });
      expect(instance.state().members[0].character.items[0].count).toBe(0);
    });
  });
  it("暂停等待确认不会持续调度 alarm", async () => {
    await campaign(async instance => {
      const s = instance.state(); s.status = "paused"; s.job = { id: "confirm", phase: "confirm", cards: [] }; instance.save(s);
      await instance.alarm();
      expect(await instance.ctx.storage.getAlarm()).toBeNull();
    });
  });
  it("单人拥有的战役删除也进入冷静期", async () => {
    await campaign(async (instance, player) => {
      await instance.command(player, { type: "delete_request" });
      expect(instance.state().deletion.expires).toBeGreaterThan(Date.now());
    });
  });
});

describe("模型预算与身份索引", () => {
  it("模型实际用量大于预留时计入额外用量，拒绝 NaN 上限", async () => {
    await runInDurableObject(env.TRPG_QUOTA.getByName(crypto.randomUUID()), async q => {
      const { date } = q.reserve("a", 100, 300);
      q.settle("a", date, 200);
      expect(q.read("budget").used).toBe(200);
      expect(() => q.reserve("b", 101, 300)).toThrow();
      expect(() => q.reserve("b", 101, NaN)).toThrow();
    });
  });
  it("转交发起人时把已有成员索引升级为拥有者并计算限额", async () => {
    await runInDurableObject(env.TRPG_IDENTITY.getByName(crypto.randomUUID()), async identity => {
      await identity.create("p", "玩家");
      identity.linkCampaign("joined", false);
      identity.reserveCampaign("joined");
      expect(identity.read("player").campaigns).toEqual([{ id: "joined", owner: true }]);
      identity.reserveCampaign("second"); identity.reserveCampaign("third"); identity.linkCampaign("fourth", false);
      expect(() => identity.reserveCampaign("fourth")).toThrow();
    });
  });
});
