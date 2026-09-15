import { describe, it, expect } from "vitest";
import * as rules from "../src/trpg-rules.js";
import { CAMPAIGN, sceneById } from "../src/trpg-content.js";

const sheet = (role = "guard", id = "a") => rules.createCharacter(id, { name: id, role, background: "送信人", wish: "找到旧友", boundary: "不伤害无辜", bond: "一起护送信件" });
const dice = (...values) => () => values.shift() ?? 10;

describe("跑团角色与检定", () => {
  it("创建角色的属性分布固定，拒绝注入生命和未知职业", () => {
    const c = sheet();
    expect(c.hp).toBe(8);
    expect(Object.values(c.stats).sort()).toEqual([0, 0, 1, 1, 2]);
    expect(() => sheet("admin")).toThrow();
    expect(rules.createCharacter("x", { ...c, hp: 999, stats: { body: 999 } }).hp).toBe(8);
  });
  it("使用优势、劣势和三档结果，不使用天然自动成功", () => {
    expect(rules.check(1, 12, 1, dice(6, 15))).toMatchObject({ rolls: [6, 15], total: 16, outcome: "success" });
    expect(rules.check(0, 12, 0, dice(10)).outcome).toBe("partial");
    expect(rules.check(0, 12, 0, dice(8)).outcome).toBe("failure");
    expect(rules.check(0, 20, -1, dice(20, 1)).outcome).toBe("failure");
  });
  it("不同身份同名不会拥有同一个角色", () => {
    const a = rules.createCharacter("a", { ...sheet(), name: "同名" });
    const b = rules.createCharacter("b", { ...sheet(), name: "同名" });
    expect(a.owner).not.toBe(b.owner);
  });
  it("成长每阶段只能选择一次固定能力", () => {
    const c = sheet();
    rules.grow(c, "A", 2);
    expect(c.upgrades).toEqual(["A"]);
    expect(() => rules.grow(c, "B", 2)).toThrow();
    expect(() => rules.grow(c, "A", 3)).toThrow();
    rules.grow(c, "B", 3);
    expect(c.upgrades).toEqual(["A", "B"]);
  });
});

describe("轻战术战斗", () => {
  it("先攻排序稳定，非法行动不修改战斗", () => {
    const battle = rules.startBattle([sheet(), sheet("ranger", "b")], { id: "test", name: "追兵", enemies: [{ id: "e", name: "追兵", hp: 4, attack: 0, damage: 1 }] }, dice(10, 10, 1));
    expect(battle.order[0]).toBe("b");
    const copy = structuredClone(battle);
    expect(() => rules.combatAction(battle, "a", { kind: "attack", target: "e" }, dice(20))).toThrow();
    expect(battle).toEqual(copy);
  });
  it("近战不能攻击后排，移动每回合一次", () => {
    const battle = rules.startBattle([sheet(), sheet("ranger", "b")], { id: "x", enemies: [{ id: "e", name: "弓手", hp: 4, position: "back", attack: 0, damage: 1 }] }, dice(20, 1, 1));
    expect(() => rules.combatAction(battle, "a", { kind: "attack", target: "e" }, dice(20))).toThrow();
    rules.combatAction(battle, "a", { kind: "move", position: "back" }, dice(20));
    expect(() => rules.combatAction(battle, "a", { kind: "move", position: "front" }, dice(20))).toThrow();
  });
  it("攻击由骰子结算，防御减伤不会越界", () => {
    const battle = rules.startBattle([sheet(), sheet("ranger", "b")], { id: "x", enemies: [{ id: "e", name: "追兵", hp: 2, attack: 0, damage: 1 }] }, dice(20, 1, 1));
    const result = rules.combatAction(battle, "a", { kind: "attack", target: "e" }, dice(20));
    expect(result.events[0].damage).toBe(2);
    expect(battle.outcome).toBe("victory");
  });
  it("祈愿者可以救起倒地者但不能重复使用已耗尽能力", () => {
    const battle = rules.startBattle([sheet("healer"), sheet("guard", "b")], { id: "x", enemies: [{ id: "e", name: "追兵", hp: 20, attack: 0, damage: 1 }] }, dice(20, 1, 1));
    battle.units.find(u => u.id === "b").hp = 0;
    rules.combatAction(battle, "a", { kind: "ability", target: "b" }, dice(1));
    expect(battle.units.find(u => u.id === "b").hp).toBe(3);
    battle.index = battle.order.indexOf("a");
    expect(() => rules.combatAction(battle, "a", { kind: "ability", target: "b" }, dice(1))).toThrow();
  });
  it("全员倒地进入失败结果，不删除角色", () => {
    const battle = rules.startBattle([sheet(), sheet("ranger", "b")], { id: "x", enemies: [{ id: "e", name: "追兵", hp: 20, attack: 10, damage: 20 }] }, dice(1, 1, 20));
    rules.enemyTurns(battle, dice(20));
    rules.combatAction(battle, battle.order[battle.index], { kind: "defend" }, dice(1));
    rules.enemyTurns(battle, dice(20));
    expect(battle.outcome).toBe("defeat");
    expect(battle.units.filter(u => u.side === "party")).toHaveLength(2);
  });
});

describe("原创三章内容", () => {
  it("三章都有核心场景、线索替代路径和不同结局", () => {
    expect(CAMPAIGN.chapters).toHaveLength(3);
    for (const chapter of CAMPAIGN.chapters) {
      expect(chapter.scenes.length).toBeGreaterThanOrEqual(3);
      for (const scene of chapter.scenes) {
        expect(sceneById(scene.id).id).toBe(scene.id);
        expect(scene.options.length).toBeGreaterThanOrEqual(2);
        for (const option of scene.options) {
          if (option.next) expect(sceneById(option.next)).toBeTruthy();
          if (option.check) expect(option.failure).toBeTruthy();
        }
      }
    }
    expect(Object.keys(CAMPAIGN.endings)).toHaveLength(3);
  });
});
