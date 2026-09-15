export const STATS = { body: "体魄", agility: "灵巧", insight: "洞察", lore: "学识", will: "意志" };
export const ROLES = {
  guard: { name: "守卫", stats: [2, 0, 1, 0, 1], attack: "body", position: "front", ability: "坚守", upgrades: ["减伤提高至 3", "防御提高至＋3"] },
  ranger: { name: "游侠", stats: [0, 2, 1, 1, 0], attack: "agility", position: "back", ability: "瞄准", upgrades: ["命中伤害＋1", "每场可用两次"] },
  mage: { name: "秘术师", stats: [0, 1, 1, 2, 0], attack: "lore", position: "back", ability: "牵制", upgrades: ["牵制检定获得优势", "每场可用两次"] },
  healer: { name: "祈愿者", stats: [1, 0, 1, 0, 2], attack: "body", position: "front", ability: "援护", upgrades: ["治疗提高至 4", "每场可用两次"] },
};

export function requireRule(condition, message) {
  if (!condition) throw new RangeError(message);
}

export function text(value, max = 2000, optional = false) {
  requireRule(typeof value === "string" && value.length <= max, "文字格式或长度不正确");
  const result = value.trim();
  requireRule(optional || result.length > 0, "请填写内容");
  return result;
}

export function createCharacter(owner, input) {
  const role = ROLES[input.role];
  requireRule(!!role, "请选择有效职业");
  const stats = Object.fromEntries(Object.keys(STATS).map((key, i) => [key, role.stats[i]]));
  if (input.allocation) {
    requireRule(Object.keys(input.allocation).length === 5 && Object.keys(STATS).every(k => Number.isInteger(input.allocation[k])) && Object.values(input.allocation).sort().join() === "0,0,1,1,2", "属性必须分配＋2、＋1、＋1、0、0");
    Object.assign(stats, input.allocation);
  }
  return {
    owner, name: text(input.name, 32), role: input.role, stats, hp: 8, maxHp: 8,
    background: text(input.background, 200), wish: text(input.wish, 200), boundary: text(input.boundary, 200),
    bond: text(input.bond || "共同护送来信", 200), bondWith: null, bondAccepted: false,
    upgrades: [], items: [{ id: "potion", name: "治疗药剂", count: 1 }],
  };
}

export function d20() {
  const buffer = new Uint32Array(1);
  do { crypto.getRandomValues(buffer); } while (buffer[0] >= 4294967280);
  return buffer[0] % 20 + 1;
}

export function check(modifier, difficulty, advantage = 0, roll = d20) {
  const rolls = [roll()];
  if (advantage) rolls.push(roll());
  const face = advantage > 0 ? Math.max(...rolls) : Math.min(...rolls);
  const total = face + modifier;
  return { rolls, modifier, difficulty, total, outcome: total >= difficulty ? "success" : total >= difficulty - 3 ? "partial" : "failure" };
}

export function grow(character, choice, stage) {
  requireRule(["A", "B"].includes(choice) && stage > character.upgrades.length + 1 && !character.upgrades.includes(choice), "当前无法选择这项成长");
  character.upgrades.push(choice);
}

export function startBattle(characters, encounter, roll = d20) {
  const units = characters.map(c => ({
    id: c.owner, side: "party", name: c.name, role: c.role, stats: { ...c.stats }, upgrades: [...c.upgrades],
    hp: c.hp, maxHp: c.maxHp, position: ROLES[c.role].position, used: 0, defense: 12,
    potions: c.items.find(i => i.id === "potion")?.count || 0,
  })).concat(encounter.enemies.map(e => ({ ...e, side: "enemy", maxHp: e.hp, position: e.position || "front", defense: 12, stats: { agility: 0 } })));
  units.forEach((u, i) => { u.initiative = roll() + (u.stats.agility || 0); u.tie = i; });
  const order = [...units].sort((a, b) => b.initiative - a.initiative || a.tie - b.tie).map(u => u.id);
  return { id: encounter.id, name: encounter.name || "遭遇", units, order, index: 0, round: 1, outcome: null, moved: false, retreatVotes: [], goal: encounter.goal || "击退追兵或全队同意撤离" };
}

function unit(battle, id) { return battle.units.find(u => u.id === id); }

function finish(battle) {
  if (!battle.units.some(u => u.side === "enemy" && u.hp > 0)) battle.outcome = "victory";
  else if (!battle.units.some(u => u.side === "party" && u.hp > 0)) battle.outcome = "defeat";
}

function next(battle) {
  finish(battle);
  if (battle.outcome) return;
  do {
    battle.index = (battle.index + 1) % battle.order.length;
    if (!battle.index) battle.round++;
  } while (unit(battle, battle.order[battle.index]).hp <= 0);
  const actor = unit(battle, battle.order[battle.index]);
  actor.defense = 12;
  for (const u of battle.units) {
    if (u.shield?.source === actor.id) delete u.shield;
    if (u.advantage?.source === actor.id) delete u.advantage;
  }
  battle.moved = false;
}

function hit(battle, actor, target, roll, advantage = false, bonus = 0) {
  const positive = !!(advantage || actor.advantage);
  const negative = !!actor.disadvantage;
  const modifier = actor.side === "enemy" ? actor.attack : actor.stats[ROLES[actor.role].attack];
  const result = check(modifier, target.defense, Number(positive) - Number(negative), roll);
  const damage = result.total >= target.defense ? Math.max(0, (actor.side === "enemy" ? actor.damage : 2) + bonus - (target.shield?.amount || 0)) : 0;
  if (damage || result.total >= target.defense) delete target.shield;
  delete actor.advantage;
  delete actor.disadvantage;
  target.hp = Math.max(0, target.hp - damage);
  return { actor: actor.name, target: target.name, kind: "attack", ...result, damage, outcome: result.total >= target.defense ? "success" : "failure" };
}

export function combatAction(battle, owner, action, roll = d20) {
  requireRule(!battle.outcome, "战斗已经结束");
  const actor = unit(battle, battle.order[battle.index]);
  requireRule(actor.id === owner && actor.side === "party" && actor.hp > 0, "尚未轮到你行动");
  const target = unit(battle, action.target);
  const role = ROLES[actor.role];
  const events = [];
  if (action.kind === "move") {
    requireRule(!battle.moved && ["front", "back"].includes(action.position) && action.position !== actor.position, "本回合无法再次移动");
    actor.position = action.position;
    battle.moved = true;
    return { events: [{ actor: actor.name, kind: "move", position: actor.position }] };
  }
  if (action.kind === "attack" || action.kind === "ability" && actor.role === "ranger") {
    requireRule(target?.side === "enemy" && target.hp > 0, "请选择存活的敌人");
    requireRule(role.attack !== "body" || actor.position === "front" && target.position === "front", "近战双方都必须位于前线");
  }
  if (action.kind === "ability") {
    const limit = actor.upgrades.includes("B") && actor.role !== "guard" ? 2 : 1;
    requireRule(actor.used < limit, "本场职业能力次数已用完");
    if (actor.role === "mage") requireRule(target?.side === "enemy" && target.hp > 0, "请选择存活的敌人");
    if (["healer", "guard"].includes(actor.role)) requireRule(target?.side === "party" && (actor.role === "healer" || target.id !== owner && target.hp > 0), "请选择有效队友");
  }
  if (action.kind === "assist") requireRule(target?.side === "party" && target.id !== owner && target.hp > 0, "请选择可行动的队友");
  if (action.kind === "potion") requireRule(actor.potions > 0 && target?.side === "party", "没有可用药剂或目标不正确");
  if (action.kind === "retreat") requireRule(battle.units.filter(u => u.side === "party").every(u => battle.retreatVotes.includes(u.id)), "撤离需要全队同意");
  requireRule(["attack", "defend", "assist", "ability", "potion", "retreat"].includes(action.kind), "不支持的战斗动作");
  if (action.kind === "attack") events.push(hit(battle, actor, target, roll));
  if (action.kind === "defend") actor.defense = 14;
  if (action.kind === "assist") target.advantage = { source: owner };
  if (action.kind === "potion") { actor.potions--; target.hp = Math.min(target.maxHp, target.hp + 3); }
  if (action.kind === "retreat") battle.outcome = "retreat";
  if (action.kind === "ability") {
    actor.used++;
    if (actor.role === "guard") {
      actor.defense = actor.upgrades.includes("B") ? 15 : 14;
      target.shield = { source: owner, amount: actor.upgrades.includes("A") ? 3 : 2 };
    } else if (actor.role === "ranger") {
      events.push(hit(battle, actor, target, roll, true, actor.upgrades.includes("A") ? 1 : 0));
    } else if (actor.role === "mage") {
      const result = check(actor.stats.lore, 12, actor.upgrades.includes("A") ? 1 : 0, roll);
      if (result.total >= 12) target.disadvantage = true;
      events.push({ actor: actor.name, target: target.name, kind: "ability", ...result, outcome: result.total >= 12 ? "success" : "failure" });
    } else target.hp = Math.min(target.maxHp, target.hp + (actor.upgrades.includes("A") ? 4 : 3));
  }
  if (!events.length) events.push({ actor: actor.name, target: target?.name, kind: action.kind });
  delete actor.disadvantage;
  next(battle);
  return { events };
}

export function enemyTurns(battle, roll = d20) {
  const events = [];
  while (!battle.outcome) {
    const actor = unit(battle, battle.order[battle.index]);
    if (actor.side !== "enemy") break;
    const targets = battle.units.filter(u => u.side === "party" && u.hp > 0);
    const target = targets.find(u => u.position === "front") || targets[0];
    events.push(hit(battle, actor, target, roll));
    next(battle);
  }
  return events;
}

export function syncBattle(characters, battle) {
  for (const c of characters) {
    const u = unit(battle, c.owner);
    if (!u) continue;
    c.hp = battle.outcome ? Math.max(1, u.hp) : u.hp;
    const potion = c.items.find(i => i.id === "potion");
    if (potion) potion.count = u.potions;
  }
}
