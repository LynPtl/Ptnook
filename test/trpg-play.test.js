import { env, runInDurableObject, fetchMock } from "cloudflare:test";
import { describe, it, expect, afterEach } from "vitest";
import { createCharacter } from "../src/trpg-rules.js";
import { validatePlan, narrationContext, modelRequest } from "../src/trpg-ai.js";

const players = [{ id: "a", name: "A" }, { id: "b", name: "B" }];
const character = id => createCharacter(id, { name: id, role: "guard", background: "护送信件", wish: "寻找旧友", boundary: "保护无辜", bond: "共同护送" });
async function setup(fn) {
  const stub = env.TRPG_CAMPAIGN.getByName(crypto.randomUUID());
  return runInDurableObject(stub, async instance => {
    instance.initialize("test-" + crypto.randomUUID(), players[0], { name: "测试", boundaries: [] });
    const s = instance.state();
    s.members = players.map(p => ({ ...p, character: character(p.id), ready: true, away: false, boundaries: [], lastSeen: Date.now() }));
    s.members.forEach(m => { m.character.bondWith = m.id === "a" ? "b" : "a"; m.character.bondAccepted = true; });
    s.status = "exploration"; s.attending = ["a", "b"];
    instance.save(s);
    await fn(instance);
  });
}

afterEach(() => { fetchMock.deactivate(); });

describe("主持输出契约", () => {
  it("拒绝不属于本轮的行动者、不存在选项及越界难度", () => {
    const state = { scene: "gate", completed: [], flags: {}, relationships: {}, drafts: { a: { kind: "action", text: "观察" } } };
    expect(() => validatePlan({ actions: [{ player: "x", intent: "观察", option: null }] }, state)).toThrow();
    expect(() => validatePlan({ actions: [{ player: "a", intent: "观察", option: "god" }] }, state)).toThrow();
    expect(() => validatePlan({ actions: [{ player: "a", intent: "观察", option: null, check: { stat: "body", difficulty: 999 } }] }, state)).toThrow();
  });
  it("拒绝模型重定向和非法 JSON，不向新主机转发密钥", async () => {
    await setup(async instance => {
      Object.assign(instance.env, { TRPG_AI_URL: "https://fixture.example/chat", TRPG_AI_KEY: "fixture-only", TRPG_AI_MODEL: "fixture", TRPG_AI_PROVIDER: "fixture", TRPG_AI_POLICY: "fixture" });
      fetchMock.activate(); fetchMock.disableNetConnect();
      fetchMock.get("https://fixture.example").intercept({ path: "/chat", method: "POST" }).reply(302, "", { headers: { location: "https://untrusted.example/collect" } });
      await expect(modelRequest(instance, "narrate", instance.state(), { facts: ["已保存"] })).rejects.toThrow("不可用");
      fetchMock.get("https://fixture.example").intercept({ path: "/chat", method: "POST" }).reply(200, JSON.stringify({ choices: [{ message: { content: "not-json" } }], usage: { total_tokens: 100 } }));
      await expect(modelRequest(instance, "narrate", instance.state(), { facts: ["已保存"] })).rejects.toThrow("JSON");
      delete instance.env.TRPG_AI_URL;
    });
  });
  it("公开叙述上下文不含世界真相、隐藏动机和场外讨论", () => {
    const context = narrationContext({ scene: "gate", members: [], clues: [], promises: [], flags: {}, discussion: [{ text: "PRIVATE CHAT" }], summaries: [], relationships: {} }, { facts: ["观察了名单"] });
    expect(JSON.stringify(context)).not.toContain("PRIVATE CHAT");
    expect(JSON.stringify(context)).not.toContain("回声不是恶魔");
    expect(JSON.stringify(context)).not.toContain("secret");
  });
});

describe("多人推进与恢复", () => {
  it("系统选项不调用规划模型，等待所有人提交且不能重复结算", async () => {
    await setup(async instance => {
      await instance.playCommand(players[0], { type: "draft", kind: "action", option: "notice", text: "观察擦痕" });
      await expect(instance.playCommand(players[0], { type: "submit", operation: "round-1" })).rejects.toThrow("所有出席玩家");
      await instance.playCommand(players[1], { type: "draft", kind: "wait", text: "" });
      await instance.playCommand(players[0], { type: "submit", operation: "round-1" });
      expect(instance.state().job.phase).toBe("confirm");
      await instance.playCommand(players[0], { type: "confirm", operation: "round-1" });
      const s = instance.state();
      expect(s.clues.some(c => c.id === "erased")).toBe(true);
      expect(s.job.phase).toBe("failed_narration");
      const result = structuredClone(s.job.result);
      await instance.playCommand(players[0], { type: "retry" });
      expect(instance.state().job.result).toEqual(result);
      await instance.playCommand(players[0], { type: "brief" });
      expect(instance.state().status).toBe("paused");
      expect(instance.state().job).toBeNull();
      await expect(instance.playCommand(players[0], { type: "submit", operation: "round-1" })).rejects.toThrow();
      expect(instance.state().clues.filter(c => c.id === "erased")).toHaveLength(1);
    });
  });
  it("重大选择必须全员确认，AI 失败不重复应用世界变化", async () => {
    await setup(async instance => {
      const s = instance.state(); s.scene = "dock"; instance.save(s);
      await instance.playCommand(players[0], { type: "draft", kind: "action", option: "protect", text: "保护梅拉" });
      await instance.playCommand(players[1], { type: "draft", kind: "wait", text: "" });
      await instance.playCommand(players[0], { type: "submit", operation: "decision" });
      await instance.playCommand(players[0], { type: "confirm", operation: "decision" });
      expect(instance.state().scene).toBe("dock");
      await instance.playCommand(players[1], { type: "confirm", operation: "decision" });
      expect(instance.state().scene).toBe("square");
      expect(instance.state().promises).toHaveLength(1);
    });
  });
  it("同时选择不同方向时要求先讨论", async () => {
    await setup(async instance => {
      const s = instance.state(); s.scene = "dock"; instance.save(s);
      await instance.playCommand(players[0], { type: "draft", kind: "action", option: "protect", text: "保护" });
      await instance.playCommand(players[1], { type: "draft", kind: "action", option: "publish", text: "公开" });
      await expect(instance.playCommand(players[0], { type: "submit", operation: "conflict" })).rejects.toThrow("冲突");
      expect(instance.state().scene).toBe("dock");
      expect(instance.state().job).toBeNull();
    });
  });
  it("完整三章推进后保持已完结，不能通过暂停重新开团", async () => {
    await setup(async instance => {
      for (const option of ["archive", "dock", "protect", "negotiate", "council", "renew", "bell", "reconcile", "prepare", "renew"]) {
        const s = instance.state(); s.status = "exploration"; s.members.forEach(m => { m.lastSeen = Date.now(); }); instance.save(s);
        await instance.playCommand(players[0], { type: "draft", kind: "action", option, text: option });
        await instance.playCommand(players[1], { type: "draft", kind: "wait", text: "" });
        const operation = crypto.randomUUID();
        await instance.playCommand(players[0], { type: "submit", operation });
        await instance.playCommand(players[0], { type: "confirm", operation });
        if (instance.state().job.phase === "confirm") await instance.playCommand(players[1], { type: "confirm", operation });
        await instance.playCommand(players[0], { type: "brief" });
      }
      expect(instance.state().ending).toBe("renew");
      expect(instance.state().status).toBe("ended");
      await instance.playCommand(players[0], { type: "pause" });
      expect(instance.state().status).toBe("ended");
      expect(instance.state().stage).toBe(3);
    });
  });
  it("暂停后补写成功的结果仍保持暂停，不能偷偷恢复推进", async () => {
    await setup(async instance => {
      const s = instance.state(); s.status = "paused"; s.job = { id: "saved", phase: "failed_narration", result: { facts: ["已保存"], checks: [] } }; instance.save(s);
      instance.env.TRPG_AI_URL = "https://fixture.example/chat";
      instance.env.TRPG_AI_KEY = "fixture-only"; instance.env.TRPG_AI_MODEL = "fixture";
      instance.env.TRPG_AI_PROVIDER = "fixture"; instance.env.TRPG_AI_POLICY = "fixture";
      fetchMock.activate(); fetchMock.disableNetConnect();
      fetchMock.get("https://fixture.example").intercept({ path: "/chat", method: "POST" }).reply(200, JSON.stringify({ choices: [{ message: { content: JSON.stringify({ text: "已保存的故事继续留在记录里。" }) } }], usage: { total_tokens: 100 } }));
      await instance.playCommand(players[0], { type: "retry" });
      expect(instance.state().status).toBe("paused");
      expect(instance.state().job).toBeNull();
      delete instance.env.TRPG_AI_URL;
    });
  });
  it("非出席成员不能取消已经提交的轮次", async () => {
    await setup(async instance => {
      const s = instance.state(); s.members.push({ id: "spectator", name: "缺席", boundaries: [] }); s.job = { id: "round", phase: "confirm" }; instance.save(s);
      await expect(instance.playCommand({ id: "spectator" }, { type: "cancel_round" })).rejects.toThrow();
    });
  });
  it("启动请求进行中不能重复发起，暂停会使启动失效", async () => {
    await setup(async instance => {
      const s = instance.state(); s.status = "paused"; s.startToken = "starting"; s.startingAt = Date.now(); instance.save(s);
      await expect(instance.playCommand(players[0], { type: "start", room: "race" })).rejects.toThrow("启动");
      await instance.playCommand(players[0], { type: "pause" });
      expect(instance.state().pauseRequested).toBe(true);
    });
  });
  it("旁观成员尚未建角时，出席队伍仍可进入战斗", async () => {
    await setup(async instance => {
      const s = instance.state(); s.scene = "square"; s.members.push({ id: "c", name: "缺席", character: null, away: true, boundaries: [] }); instance.save(s);
      await instance.playCommand(players[0], { type: "draft", kind: "action", option: "fight", text: "迎战" });
      await instance.playCommand(players[1], { type: "draft", kind: "wait", text: "" });
      await instance.playCommand(players[0], { type: "submit", operation: "battle" });
      await instance.playCommand(players[0], { type: "confirm", operation: "battle" });
      await instance.playCommand(players[1], { type: "confirm", operation: "battle" });
      expect(instance.state().battle.units.filter(u => u.side === "party")).toHaveLength(2);
    });
  });
  it("结构化选项也必须确认，不能借任意文字绕过理解", async () => {
    await setup(async instance => {
      await instance.playCommand(players[0], { type: "draft", kind: "action", option: "notice", text: "摧毁整座城镇" });
      expect(instance.state().drafts.a.text).not.toContain("摧毁");
    });
  });
  it("主动暂停保留未判定内容，零人在线不继续推进", async () => {
    await setup(async instance => {
      const s = instance.state(); s.members.forEach(m => { m.lastSeen = 0; }); instance.save(s);
      await instance.alarm();
      expect(instance.state().status).toBe("paused");
      expect(instance.state().members).toHaveLength(2);
    });
  });
});
