import { insist } from "./trpg-store.js";
import { text, STATS, check, startBattle, combatAction, enemyTurns, syncBattle } from "./trpg-rules.js";
import { CAMPAIGN, sceneById, availableOptions, encounterById } from "./trpg-content.js";
import { aiReady, modelRequest } from "./trpg-ai.js";

function attending(s) { return s.members.filter(m => s.attending.includes(m.id)); }
function available(s) { return availableOptions(sceneById(s.scene), s); }
function errorText(error) { return String(error.message || "AI 暂时不可用").replace(/^\[TRPG:\d+\]/, "").slice(0, 200); }

function addClue(s, clue) {
  if (clue && !s.clues.some(c => c.id === clue[0])) s.clues.push({ id: clue[0], title: clue[1], text: clue[2], kind: clue[3] || "fact", event: s.lastEvent + 1 });
}
function enterScene(store, s, nextId, facts) {
  const old = sceneById(s.scene); const scene = sceneById(nextId);
  s.scene = scene.id; s.chapter = scene.chapter; s.stage = scene.chapter;
  for (const clue of scene.reveal || []) addClue(s, clue);
  if (scene.npc) s.met = [...new Set([...(s.met || []), scene.npc])];
  facts.push(`来到${scene.name}：${scene.text}`);
  if (scene.chapter > old.chapter) {
    s.summaries.push({ chapter: old.chapter, event: s.lastEvent + 1, text: `完成「${old.chapterName}」。队伍选择：${JSON.stringify(s.flags)}。每位成员解锁一次成长，暂停时选择。`, contributions: s.members.map(m => ({ name: m.character?.name || m.name, actions: m.contributions || 0 })) });
  }
}
function cardsFor(s, actions) {
  const options = available(s);
  const cards = actions.map(a => {
    const option = a.option ? options.find(o => o.id === a.option) : null;
    insist(!a.option || option, 409, "选项已失效，请重新提交");
    const main = s.members.find(m => m.id === a.player);
    const helpers = Object.entries(s.drafts).filter(([, d]) => d.kind === "assist" && d.target === a.player);
    insist(helpers.length <= 1, 409, "每个行动最多一人协助");
    const test = option?.check || a.check;
    return {
      player: a.player, name: main.character.name, intent: a.intent, option: option?.id || null,
      check: test || null, helper: helpers[0]?.[0] || null, major: !!option?.major,
      travel: !!option?.next, success: option?.success || "达成当前意图；不会凭空获得物品或改变世界。",
      partial: option?.partial || "仅部分达成意图，需进一步沟通或准备。", failure: option?.failure || "未达成意图，需改变方法后再尝试。",
      resource: option?.battle ? "将进入短回合战斗，可以倒地但不会自动永久死亡。" : option?.major ? "这是会影响后续故事的队伍选择。" : "不消耗物品。",
    };
  });
  const transitions = cards.filter(c => c.travel || c.major);
  insist(new Set(transitions.map(c => c.option)).size <= 1, 409, "行动方向存在冲突，请先讨论达成一致");
  insist(!transitions.length || cards.every(c => c.option === transitions[0].option), 409, "先完成当前调查，再在下一轮旅行或作重大决定");
  for (const [id, d] of Object.entries(s.drafts)) {
    if (d.kind === "assist") insist(cards.some(c => c.player === d.target && c.player !== id), 409, "协助必须指向本轮的一项主行动");
  }
  return cards;
}

async function releaseRoom(store, s) {
  if (!s.room) return;
  const room = s.room; s.room = null; store.save(s);
  await store.env.CHAT_ROOM.getByName(room).releaseTrpg(s.id);
}

export async function pauseCampaign(store, s, reason = "队伍暂停了冒险") {
  s.pausedFrom = s.status === "combat" ? "combat" : s.pausedFrom || "exploration";
  if (!["ended", "archived"].includes(s.status)) s.status = s.ending && !s.job ? "ended" : "paused";
  s.startToken = null;
  s.members.forEach(m => { m.ready = false; });
  store.event(s, "pause", reason); store.save(s);
  await releaseRoom(store, s);
}

async function narrate(store, operation) {
  let s = store.state(); if (s.job?.id !== operation) return;
  s.job.phase = "narrating"; s.job.error = null; s.job.attempt = crypto.randomUUID(); s.job.started = Date.now();
  const attempt = s.job.attempt; store.save(s);
  try {
    const narration = await modelRequest(store, "narrate", s, s.job.result);
    s = store.state(); if (s.job?.id !== operation || s.job.attempt !== attempt) return;
    publish(store, s, narration.text);
    if (s.status === "ended" || s.pauseRequested) { s.pauseRequested = false; await pauseCampaign(store, s, "进度已保存"); }
  } catch (error) {
    s = store.state(); if (s.job?.id !== operation || s.job.attempt !== attempt) return;
    s.job.phase = "failed_narration"; s.job.error = errorText(error); s.job.failures = (s.job.failures || 0) + 1;
    store.save(s);
  }
}
function publish(store, s, narration) {
  const result = s.job.result;
  store.ctx.storage.transactionSync(() => {
    store.event(s, "story", narration, { result, operation: s.job.id });
    s.summaries.push({ event: s.lastEvent, chapter: s.chapter, text: result.facts.join("\n").slice(0, 1000) });
    if (s.summaries.length > 30) s.summaries = s.summaries.slice(-30);
    s.job = null; s.drafts = {}; s.round++;
    s.status = s.ending ? "ended" : s.status === "paused" || s.pauseRequested ? "paused" : s.battle && !s.battle.outcome ? "combat" : "exploration";
    store.save(s);
  });
}
async function settle(store, operation) {
  const s = store.state(); insist(s.job?.id === operation && s.job.phase === "confirm", 409, "操作已更新");
  const facts = []; const results = []; const applied = new Set();
  store.ctx.storage.transactionSync(() => {
    for (const card of s.job.cards) {
      const member = s.members.find(m => m.id === card.player);
      member.contributions = (member.contributions || 0) + 1;
      const option = card.option ? available(s).find(o => o.id === card.option) || s.job.options.find(o => o.id === card.option) : null;
      if (option && applied.has(option.id)) { facts.push(`${member.character.name} 共同参与了 ${card.intent}`); continue; }
      if (option) applied.add(option.id);
      const rolled = card.check ? check(member.character.stats[card.check.stat], card.check.difficulty, card.helper ? 1 : 0) : null;
      const outcome = rolled?.outcome || "success";
      results.push({ player: card.player, intent: card.intent, ...(rolled || { outcome }) });
      facts.push(`${member.character.name}：${card.intent}。${card[outcome]}`);
      if (card.helper) { const helper = s.members.find(m => m.id === card.helper); helper.contributions = (helper.contributions || 0) + 1; facts.push(`${helper.character.name} 提供了协助。`); }
      if (!option) continue;
      if (option.once) s.completed.push(`${s.scene}:${option.id}`);
      addClue(s, option.clue);
      if (option.item && !s.items.some(i => i.id === option.item[0])) s.items.push({ id: option.item[0], name: option.item[1], count: 1 });
      if (option.flag) { s.flags[option.flag[0]] = option.flag[1]; facts.push(`队伍选择已记录：${option.label}`); }
      if (option.promise && !s.promises.some(p => p.text === option.promise)) s.promises.push({ text: option.promise, status: "有效", event: s.lastEvent + 1 });
      if (option.npc) {
        const change = outcome === "failure" ? -1 : 1;
        s.relationships[option.npc] = Math.max(-2, Math.min(2, (s.relationships[option.npc] || 0) + change));
        s.met = [...new Set([...(s.met || []), option.npc])];
        facts.push(`${CAMPAIGN.npcs.find(n => n.id === option.npc).name} 对队伍态度${change > 0 ? "有所缓和" : "更加戒备"}，原因是本轮行动。`);
      }
      if (option.battle) {
        s.battle = startBattle(attending(s).map(m => m.character), encounterById(option.battle, s.attending.length));
        s.battle.nextScene = option.next; s.status = "combat";
        const events = enemyTurns(s.battle); results.push(...events); syncBattle(s.members.map(m => m.character).filter(Boolean), s.battle);
        facts.push("进入遭遇：" + s.battle.name);
      } else if (option.next) enterScene(store, s, option.next, facts);
      if (option.ending) { s.ending = option.ending; facts.push(CAMPAIGN.endings[option.ending]); s.status = "ended"; }
    }
    for (const [id, draft] of Object.entries(s.drafts)) if (draft.kind === "wait") facts.push(`${s.members.find(m => m.id === id).character.name} 选择观察等待。`);
    s.job.result = { facts, checks: results }; s.job.phase = "settled";
    store.event(s, "resolution", "本轮判定已保存", { result: s.job.result, operation }); store.save(s);
  });
  await narrate(store, operation);
}

async function prepare(store, operation) {
  let s = store.state();
  const attempt = crypto.randomUUID(); s.job.attempt = attempt; store.save(s);
  const direct = Object.entries(s.drafts).filter(([, d]) => d.kind === "action").every(([, d]) => d.option);
  let plan;
  try {
    if (direct) plan = { actions: Object.entries(s.drafts).filter(([, d]) => d.kind === "action").map(([player, d]) => ({ player, intent: d.text || available(s).find(o => o.id === d.option)?.label, option: d.option })) };
    else plan = await modelRequest(store, "plan", s, null);
    s = store.state(); if (s.job?.id !== operation || s.job.phase !== "planning" || s.job.attempt !== attempt) return;
    if (plan.clarification) {
      store.event(s, "clarification", plan.clarification); s.job = null; store.save(s); return;
    }
    s.job.cards = cardsFor(s, plan.actions); s.job.phase = "confirm"; s.job.approvals = [];
    s.job.options = available(s); store.save(s);
    if (s.status !== "paused" && !s.pauseRequested && !s.job.cards.some(c => c.check || c.major || c.travel || !c.option)) await settle(store, operation);
  } catch (error) {
    s = store.state(); if (s.job?.id !== operation || s.job.attempt !== attempt) return;
    if (direct) { s.job = null; store.save(s); throw error; }
    s.job.phase = "failed_plan"; s.job.error = errorText(error); store.save(s);
  }
}

export async function playCommand(store, player, input) {
  let s = store.state(); const m = store.member(s, player);
  if (input.type === "pause" || input.type === "safety") {
    s.pauseRequested = true;
    await pauseCampaign(store, s, input.type === "safety" ? "已停止当前情节，无需说明理由" : "队伍暂停了冒险");
    return { campaign: store.view(player) };
  }
  if (input.type === "start") {
    insist(s.owner === player.id || s.proxy === player.id, 403, "由发起人或代理组织续玩");
    insist(["waiting", "paused"].includes(s.status), 409, "战役已经开始或已只读");
    insist(!s.correction && !s.trade, 409, "请先处理纠错请求或物品转移");
    insist(!s.startToken || s.startingAt < Date.now() - 30000, 409, "战役正在启动，请稍候");
    insist(aiReady(store.env), 503, "AI 尚未配置，暂时不能开始冒险");
    const present = s.members.filter(x => x.ready && x.lastSeen > Date.now() - 45000);
    insist(present.length >= 2 && present.every(x => x.character && x.character.bondWith && x.character.bondAccepted), 409, "至少两名玩家创建角色、确认队友关系并准备");
    insist(s.members.every(x => present.includes(x) || x.away), 409, "缺席成员尚未允许续团");
    if (s.battle || s.job) insist(s.attending.every(id => present.some(x => x.id === id)) && present.length === s.attending.length, 409, "未决行动或战斗必须由原出席者继续");
    const room = text(input.room, 32);
    insist(!s.room || s.room === room, 409, "战役正在另一房间进行");
    s.startToken = crypto.randomUUID(); s.startingAt = Date.now(); s.pauseRequested = false; const startToken = s.startToken; store.save(s);
    try { await store.env.CHAT_ROOM.getByName(room).claimTrpg(s.id); }
    catch (error) { const current = store.state(); if (current.startToken === startToken) { current.startToken = null; store.save(current); } throw error; }
    s = store.state();
    if (s.startToken !== startToken || s.pauseRequested || !["waiting", "paused"].includes(s.status)) { await store.env.CHAT_ROOM.getByName(room).releaseTrpg(s.id); insist(false, 409, "启动已取消，请重试"); }
    s.startToken = null;
    if (!s.job) s.drafts = {};
    s.room = room; s.attending = present.map(x => x.id); s.status = s.battle && !s.battle.outcome ? "combat" : "exploration";
    s.proxy = present.find(x => x.id !== s.owner)?.id || s.owner;
    if (!s.started) { s.started = true; store.event(s, "story", sceneById(s.scene).text); }
    s.pauseRequested = false; store.save(s); await store.ctx.storage.setAlarm(Date.now() + 45000);
    return { campaign: store.view(player) };
  }
  if (input.type === "retry") {
    insist(s.job && ["failed_narration", "failed_plan"].includes(s.job.phase), 409, "没有需要重试的主持任务");
    insist(s.attending.includes(player.id), 403, "仅本次出席玩家可重试");
    if (s.job.phase === "failed_narration") await narrate(store, s.job.id);
    else { s.job.phase = "planning"; s.job.started = Date.now(); store.save(s); await prepare(store, s.job.id); }
    return { campaign: store.view(player) };
  }
  if (input.type === "brief") {
    insist(s.attending.includes(player.id), 403, "仅出席玩家可发布本轮简报");
    insist(s.job?.phase === "failed_narration", 409, "只有已结算但叙述失败时可发布简报");
    publish(store, s, s.job.result.facts.join("\n")); s = store.state(); await pauseCampaign(store, s, "已发布系统简报，等待主持恢复"); return { campaign: store.view(player) };
  }
  if (input.type === "cancel_round") {
    insist(s.attending.includes(player.id), 403, "仅出席玩家可取消本轮");
    insist(s.job && ["confirm", "failed_plan"].includes(s.job.phase), 409, "已结算的行动不可撤销");
    s.job = null; s.drafts = {}; store.save(s); return { campaign: store.view(player) };
  }
  insist(["exploration", "combat"].includes(s.status), 409, "请先组织续玩");
  insist(s.attending.includes(player.id), 403, "你没有参加本次聚会");
  insist(attending(s).every(x => x.lastSeen > Date.now() - 45000), 409, "有玩家离线，请等待重连或暂停");
  if (input.type === "draft") {
    insist(s.status === "exploration" && !s.job, 409, "当前行动已经锁定");
    insist(["action", "assist", "wait"].includes(input.kind), 400, "请选择行动、协助或观察等待");
    const draft = { kind: input.kind, text: text(input.text || "", 2000, input.kind === "wait"), option: null };
    if (input.option) { const option = available(s).find(o => o.id === input.option); insist(option && input.kind === "action", 409, "选项已失效"); draft.option = input.option; draft.text = option.label; }
    if (input.kind === "assist") { insist(input.target !== player.id && s.attending.includes(input.target), 400, "请选择出席队友"); draft.target = input.target; }
    s.drafts[player.id] = draft; store.save(s);
  } else if (input.type === "withdraw") {
    insist(!s.job && s.status === "exploration", 409, "行动已锁定"); delete s.drafts[player.id]; store.save(s);
  } else if (input.type === "submit") {
    insist(s.status === "exploration" && !s.job, 409, "本轮已提交或不在探索阶段");
    insist(s.attending.every(id => s.drafts[id]), 409, "请等待所有出席玩家提交");
    insist(Object.values(s.drafts).some(d => d.kind === "action"), 409, "至少需要一个主行动");
    const operation = text(input.operation, 80);
    insist(!store.sql.exec("SELECT id FROM receipts WHERE id = ?", operation).toArray().length, 409, "该操作已经提交");
    insist(store.sql.databaseSize < 49 * 1024 * 1024, 413, "存档接近容量上限，请导出后联系管理员");
    store.ctx.storage.transactionSync(() => {
      store.sql.exec("INSERT INTO receipts(id, actor, body) VALUES (?, ?, ?)", operation, player.id, JSON.stringify(s.drafts));
      s.job = { id: operation, phase: "planning", started: Date.now(), approvals: [] }; store.save(s);
    });
    await prepare(store, operation);
  } else if (input.type === "confirm") {
    insist(s.job?.phase === "confirm" && s.job.id === input.operation, 409, "判定卡已经更新");
    if (!s.job.approvals.includes(player.id)) s.job.approvals.push(player.id);
    const cards = s.job.cards; const votes = s.job.approvals;
    const ready = cards.some(c => c.major) ? s.attending.every(id => votes.includes(id))
      : cards.some(c => c.travel) ? votes.length > s.attending.length / 2
      : cards.filter(c => c.check).every(c => votes.includes(c.player));
    store.save(s); if (ready) await settle(store, s.job.id);
  } else if (input.type === "rest") {
    insist(!s.job && s.status === "exploration" && sceneById(s.scene).safe, 409, "当前场景不能安全休整");
    attending(s).forEach(x => { x.character.hp = 8; }); store.event(s, "rest", "队伍在安全地点完成休整，生命恢复"); store.save(s);
  } else if (input.type === "retreat_vote") {
    insist(s.status === "combat" && !s.job, 409, "当前不能表决撤离");
    s.battle.retreatVotes = [...new Set([...s.battle.retreatVotes, player.id])]; store.save(s);
  } else if (input.type === "combat") {
    insist(s.status === "combat" && !s.job, 409, "战斗正在结算");
    const op = text(input.operation, 80); insist(!store.sql.exec("SELECT id FROM receipts WHERE id = ?", op).toArray().length, 409, "该动作已处理");
    const output = combatAction(s.battle, player.id, input.action);
    output.events.push(...enemyTurns(s.battle)); syncBattle(s.members.map(x => x.character).filter(Boolean), s.battle);
    store.ctx.storage.transactionSync(() => {
      store.sql.exec("INSERT INTO receipts(id, actor, body) VALUES (?, ?, ?)", op, player.id, JSON.stringify(input.action));
      store.event(s, "combat", `${m.character.name} 完成战斗动作`, { events: output.events });
      if (s.battle.outcome) {
        const facts = [`遭遇结果：${s.battle.outcome === "victory" ? "队伍取得胜利" : s.battle.outcome === "retreat" ? "队伍撤离，承担巡逻队后续盘问" : "队伍倒地后被看守者带出冲突区，承担公开说明经过的人情"}，没有人永久死亡。`];
        enterScene(store, s, s.battle.nextScene, facts); s.battle = null;
        s.job = { id: op, phase: "settled", result: { facts, checks: output.events } };
      }
      store.save(s);
    });
    if (s.job) await narrate(store, op);
  } else insist(false, 400, "未知操作");
  return { campaign: store.view(player) };
}
