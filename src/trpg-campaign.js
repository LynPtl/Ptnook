import { TrpgStore, insist, token, digest, equalHash } from "./trpg-store.js";
import { CAMPAIGN, sceneById, availableOptions } from "./trpg-content.js";
import { createCharacter, text, grow } from "./trpg-rules.js";
import { playCommand, pauseCampaign } from "./trpg-play.js";

export class TrpgCampaign extends TrpgStore {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql.exec("CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, actor TEXT NOT NULL, body TEXT NOT NULL)");
  }
  state() { const s = this.read("state"); insist(s && !s.deleted, 404, "战役不存在或已删除"); return s; }
  member(s, player) { const m = s.members.find(m => m.id === player.id); insist(m, 403, "你不是这场战役的成员"); return m; }
  save(s) { s.version++; s.updated = Date.now(); this.write("state", s); }
  event(s, kind, title, detail = {}) {
    this.sql.exec("INSERT INTO events(data) VALUES (?)", JSON.stringify({ chapter: sceneById(s.scene)?.chapter || 1, scene: s.scene, kind, title, ...detail, ts: Date.now() }));
    s.lastEvent = this.sql.exec("SELECT last_insert_rowid() AS id").one().id;
  }
  initialize(id, player, input) {
    if (this.read("state")) return this.view(player);
    const boundaries = this.boundaries(input.boundaries);
    const s = {
      id, name: text(input.name, 60), template: CAMPAIGN.id, rules: 1, owner: player.id,
      members: [{ id: player.id, name: player.name, ready: false, away: false, boundaries, lastSeen: Date.now(), character: null }],
      requests: [], status: "waiting", scene: "gate", chapter: 1, stage: 1, round: 1, version: 0, lastEvent: 0,
      flags: {}, relationships: {}, clues: [], promises: [], items: [], completed: [], summaries: [],
      attending: [], drafts: {}, job: null, battle: null, room: null, discussion: [], created: Date.now(), updated: Date.now(),
    };
    this.ctx.storage.transactionSync(() => { this.event(s, "system", "战役已创建：" + s.name); this.save(s); });
    return this.view(player);
  }
  boundaries(value) {
    insist(Array.isArray(value) && value.length <= 10 && value.every(v => typeof v === "string" && v.length <= 40), 400, "内容边界格式不正确");
    return [...new Set(value)];
  }
  async issueInvite(player) {
    const secret = token(); const hash = await digest(secret);
    const s = this.state(); this.member(s, player); insist(s.owner === player.id, 403, "只有发起人能管理邀请");
    s.invite = { hash, expires: Date.now() + 7 * 86400000 }; this.save(s);
    return { invite: `${s.id}.${secret}`, expires: s.invite.expires };
  }
  async requestJoin(player, secret) {
    const hash = await digest(secret); const s = this.state();
    insist(s.invite && s.invite.expires > Date.now() && equalHash(hash, s.invite.hash), 403, "邀请无效或已过期");
    insist(!["archived", "ended"].includes(s.status) && !s.deletion, 409, "当前战役不接受加入");
    if (s.members.some(m => m.id === player.id)) { await this.env.TRPG_IDENTITY.getByName(player.id).linkCampaign(s.id, player.id === s.owner); return { id: s.id, approved: true }; }
    insist(s.members.length < 4 && s.requests.length < 16, 409, "队伍或申请列表已满");
    if (!s.requests.some(m => m.id === player.id)) s.requests.push({ id: player.id, name: player.name });
    this.save(s); return { id: s.id, approved: false };
  }
  view(player, heartbeat = false) {
    const s = this.state(); const m = this.member(s, player);
    if (heartbeat) { m.lastSeen = Date.now(); this.write("state", s); }
    const scene = sceneById(s.scene);
    const job = s.job ? {
      id: s.job.id, phase: s.job.phase, error: s.job.error || null, cards: s.job.cards || [],
      approvals: s.job.approvals || [], result: s.job.result || null, proposal: s.job.proposal || null,
    } : null;
    return {
      id: s.id, name: s.name, owner: s.owner, proxy: s.proxy || null, status: s.status, chapter: scene.chapter, chapterName: scene.chapterName,
      scene: { id: scene.id, name: scene.name, goal: scene.goal, text: scene.text, safe: !!scene.safe },
      version: s.version, context: `${s.scene}:${s.round}:${s.battle ? `${s.battle.round}:${s.battle.index}:${s.battle.moved}` : "exploration"}`, round: s.round, stage: s.stage, lastEvent: s.lastEvent, created: s.created, updated: s.updated,
      members: s.members.map(({ boundaries, ...member }) => ({ ...member, online: member.lastSeen > Date.now() - 45000 })),
      boundaries: [...new Set(s.members.flatMap(m => m.boundaries))],
      requests: player.id === s.owner ? s.requests : [], attending: s.attending, room: s.room,
      drafts: s.drafts, job, battle: s.battle, flags: s.flags, clues: s.clues, promises: s.promises, items: s.items,
      npcs: CAMPAIGN.npcs.filter(n => s.met?.includes(n.id)).map(n => ({ id: n.id, name: n.name, description: n.public, relationship: s.relationships[n.id] || 0 })),
      options: availableOptions(scene, s).map(o => ({ id: o.id, label: o.label, major: !!o.major, travel: !!o.next, check: o.check || null })),
      summaries: s.summaries, discussion: s.discussion.slice(-50), deletion: s.deletion || null, transfer: s.transfer || null, correction: s.correction || null, trade: s.trade || null,
      warning: this.sql.databaseSize > 40 * 1024 * 1024 ? "存储已达到 80%，请导出并规划归档" : null,
    };
  }
  listEvents(player, before = 0) {
    this.member(this.state(), player);
    const rows = before ? this.sql.exec("SELECT id, data FROM events WHERE id < ? ORDER BY id DESC LIMIT 50", before).toArray() : this.sql.exec("SELECT id, data FROM events ORDER BY id DESC LIMIT 50").toArray();
    return rows.reverse().map(r => ({ id: r.id, ...JSON.parse(r.data) }));
  }
  async command(player, input) {
    const s = this.state(); const m = this.member(s, player);
    insist(input && typeof input.type === "string", 400, "操作格式不正确");
    const owner = s.owner === player.id;
    const safe = ["waiting", "paused"].includes(s.status) && !s.job;
    if (s.startToken && s.startingAt > Date.now() - 30000) insist(["pause", "safety", "discuss"].includes(input.type), 409, "战役正在启动，请稍后修改");
    if (["draft", "withdraw", "submit", "combat", "rest"].includes(input.type) && input.context !== undefined) insist(input.context === this.view(player).context, 409, "场景或行动轮次已更新，请检查当前状态后重新操作");
    if (["archived", "ended"].includes(s.status)) insist(["unarchive", "archive", "delete_request", "delete_confirm", "delete_cancel", "pause", "safety", "discuss", "leave", "transfer", "accept_transfer", "revoke_invite", "retry", "brief", "report", "correct_brief", "dismiss_report"].includes(input.type), 409, "战役已只读");
    if (s.deletion) insist(["delete_confirm", "delete_cancel", "pause"].includes(input.type), 409, "删除确认期间战役只读");
    if (input.type === "approve") {
      insist(owner && safe && !s.battle, 403, "只能在安全暂停点批准成员");
      const already = s.members.find(member => member.id === input.player);
      if (already) { await this.env.TRPG_IDENTITY.getByName(already.id).linkCampaign(s.id, already.id === s.owner); return { campaign: this.view(player) }; }
      const req = s.requests.find(r => r.id === input.player); insist(req && s.members.length < 4, 409, "申请不存在或队伍已满");
      s.members.push({ ...req, character: null, ready: false, away: false, boundaries: [], lastSeen: 0 });
      s.requests = s.requests.filter(r => r.id !== req.id);
      this.event(s, "member", `${req.name} 加入了战役`); this.save(s);
      await this.env.TRPG_IDENTITY.getByName(req.id).linkCampaign(s.id, false);
    } else if (input.type === "character") {
      insist(safe && !s.battle && (s.status === "waiting" || !m.character), 409, "角色只能在首次出发前创建或调整");
      const previousItems = m.character?.items;
      m.character = createCharacter(player.id, input.character);
      if (previousItems) m.character.items = previousItems;
      s.members.forEach(member => { member.ready = false; if (member.character?.bondWith === player.id) member.character.bondAccepted = false; });
      this.save(s);
    } else if (input.type === "preferences") {
      insist(safe, 409, "请先暂停再修改约定");
      m.away = input.away === true; m.boundaries = this.boundaries(input.boundaries || []);
      s.members.forEach(member => { member.ready = false; }); s.drafts = {}; this.save(s);
    } else if (input.type === "bond") {
      insist(safe && m.character, 409, "请先创建角色并暂停");
      const other = s.members.find(x => x.id === input.player && x.id !== player.id && x.character);
      insist(other, 400, "请选择队友");
      m.character.bond = text(input.text, 200); m.character.bondWith = other.id; m.character.bondAccepted = false; this.save(s);
    } else if (input.type === "accept_bond") {
      const other = s.members.find(x => x.id === input.player);
      insist(safe && other?.character?.bondWith === player.id, 409, "没有需要确认的关系");
      other.character.bondAccepted = true; this.save(s);
    } else if (input.type === "ready") {
      insist(m.character && ["waiting", "paused"].includes(s.status), 409, "请先创建角色或暂停");
      m.ready = input.ready === true; m.lastSeen = Date.now(); this.save(s);
    } else if (input.type === "grow") {
      insist(safe && m.character, 409, "请在暂停时选择成长"); grow(m.character, input.choice, s.stage); this.save(s);
    } else if (input.type === "discuss") {
      s.discussion.push({ id: crypto.randomUUID(), player: player.id, name: m.character?.name || m.name, text: text(input.text), ts: Date.now() });
      s.discussion = s.discussion.slice(-50); this.save(s);
    } else if (input.type === "theory") {
      insist(!["ended", "archived"].includes(s.status), 409, "战役已只读");
      insist(s.clues.length < 100, 409, "线索条目达到上限");
      s.clues.push({ id: crypto.randomUUID(), title: "队伍推测", text: text(input.text, 600), kind: "theory", author: player.id, event: s.lastEvent }); this.save(s);
    } else if (input.type === "offer_item") {
      insist(safe && !s.battle && !s.trade && m.character, 409, "请在安全暂停点转移物品");
      const recipient = s.members.find(x => x.id === input.player && x.id !== player.id && x.character);
      const item = m.character.items.find(i => i.id === input.item && i.count > 0);
      insist(recipient && item, 400, "物品或接收人无效");
      s.trade = { from: player.id, to: recipient.id, item: item.id, name: item.name }; this.save(s);
    } else if (input.type === "accept_item") {
      insist(safe && !s.battle && s.trade?.to === player.id, 403, "没有待接受的物品");
      const source = s.members.find(x => x.id === s.trade.from)?.character?.items.find(i => i.id === s.trade.item && i.count > 0);
      insist(source && m.character, 409, "物品已不可用");
      const target = m.character.items.find(i => i.id === source.id);
      insist(target || m.character.items.length < 8, 409, "背包条目已满");
      source.count--; if (target) target.count++; else m.character.items.push({ ...source, count: 1 });
      this.event(s, "item", `${m.character.name} 接收了 ${s.trade.name}`); s.trade = null; this.save(s);
    } else if (input.type === "cancel_item") {
      insist(s.trade && [s.trade.from, s.trade.to].includes(player.id), 403, "没有可取消的物品转移"); s.trade = null; this.save(s);
    } else if (input.type === "edit_theory") {
      const clue = s.clues.find(c => c.id === input.clue && c.kind === "theory" && c.author === player.id);
      insist(clue && !["ended", "archived"].includes(s.status), 403, "只能修改自己记录的推测"); clue.text = text(input.text, 600); this.save(s);
    } else if (input.type === "report") {
      insist(Number.isSafeInteger(input.event), 400, "请关联一条事件");
      const row = this.sql.exec("SELECT data FROM events WHERE id = ?", input.event).toArray()[0]; insist(row, 404, "事件不存在");
      s.correction = { event: input.event, text: text(input.text, 600), player: player.id };
      s.pauseRequested = true; await pauseCampaign(this, s, "队伍请求核对事件 " + input.event);
    } else if (input.type === "correct_brief") {
      insist(s.correction && !s.job, 409, "请先完成或取消当前未决行动");
      const source = JSON.parse(this.sql.exec("SELECT data FROM events WHERE id = ?", s.correction.event).one().data);
      const rows = this.sql.exec("SELECT data FROM events WHERE json_extract(data, '$.operation') = ? AND json_extract(data, '$.kind') = 'resolution' LIMIT 1", source.operation || "").toArray();
      insist(rows.length === 1, 409, "没有对应权威判定，无法自动更正；请联系管理员核对原始记录");
      const result = JSON.parse(rows[0].data).result;
      this.event(s, "correction", `事件 ${s.correction.event} 的权威判定简报：\n${result.facts.join("\n")}`, { corrects: s.correction.event, result });
      s.correction = null; this.save(s);
    } else if (input.type === "dismiss_report") {
      insist(s.correction && s.correction.player === player.id, 403, "只有提出者可撤回核对请求"); s.correction = null; this.save(s);
    } else if (input.type === "archive") {
      insist(owner && !s.job && ["paused", "ended"].includes(s.status), 403, "请在暂停或完结后归档");
      s.archivedFrom = s.status; s.status = "archived"; this.save(s);
    } else if (input.type === "unarchive") {
      insist(owner && s.status === "archived", 403, "只有发起人能恢复归档");
      s.status = s.archivedFrom || "paused"; this.save(s);
    } else if (input.type === "transfer") {
      insist(owner && safe && s.members.some(x => x.id === input.player && x.id !== player.id), 403, "无法转交给该成员");
      s.transfer = input.player; this.save(s);
    } else if (input.type === "accept_transfer") {
      insist(safe && s.transfer === player.id, 403, "没有待接受的转交");
      await this.env.TRPG_IDENTITY.getByName(player.id).reserveCampaign(s.id);
      const current = this.state();
      if (current.transfer !== player.id || current.version !== s.version) {
        if (current.owner !== player.id) await this.env.TRPG_IDENTITY.getByName(player.id).linkCampaign(s.id, false);
        insist(false, 409, "战役已更新，请重试");
      }
      current.owner = player.id; current.transfer = null; this.event(current, "member", `${m.name} 接任发起人`); this.save(current);
      await this.env.TRPG_IDENTITY.getByName(s.owner).linkCampaign(s.id, false);
    } else if (input.type === "leave" || input.type === "remove") {
      const target = input.type === "leave" ? player.id : input.player;
      insist(safe && !s.battle && (input.type === "leave" || owner) && target !== s.owner, 403, "请先解决未决行动；发起人须先转交权限");
      const leaving = s.members.find(x => x.id === target); insist(leaving, 404, "成员不存在");
      s.retired = [...(s.retired || []), { ...leaving, retired: true }]; s.members = s.members.filter(x => x.id !== target);
      s.attending = s.attending.filter(id => id !== target); this.event(s, "member", `${leaving.name} 退出，角色已归档`); this.save(s);
      await this.env.TRPG_IDENTITY.getByName(target).unlinkCampaign(s.id);
      if (target === player.id) return { left: true };
    } else if (input.type === "delete_request") {
      insist(owner && !s.job && ["waiting", "paused", "ended", "archived"].includes(s.status), 403, "请在暂停后请求删除");
      s.deletion = { approvals: [player.id], expires: s.members.length === 1 ? Date.now() + 7 * 86400000 : null }; this.save(s);
      if (s.deletion.expires) await this.ctx.storage.setAlarm(s.deletion.expires);
    } else if (input.type === "delete_confirm") {
      insist(s.deletion, 409, "没有删除请求");
      if (!s.deletion.approvals.includes(player.id)) s.deletion.approvals.push(player.id);
      if (s.members.every(x => s.deletion.approvals.includes(x.id))) s.deletion.expires ||= Date.now() + 7 * 86400000;
      this.save(s); await this.ctx.storage.setAlarm(Date.now() + 60000);
    } else if (input.type === "delete_cancel") {
      s.deletion = null; this.save(s);
    } else if (input.type === "revoke_invite") {
      insist(owner, 403, "只有发起人能撤销邀请"); s.invite = null; this.save(s);
    } else {
      return this.playCommand(player, input);
    }
    return { campaign: this.view(player) };
  }
  async playCommand(player, input) { return playCommand(this, player, input); }
  async alarm() {
    const s = this.read("state"); if (!s || s.deleted) return;
    if (s.job && ["planning", "narrating", "settled"].includes(s.job.phase) && (s.job.started || 0) < Date.now() - 60000) {
      s.job.phase = s.job.result ? "failed_narration" : "failed_plan";
      s.job.attempt = null;
      s.job.error = "主持请求中断，已保存的结果可以继续重试";
      this.save(s);
    }
    if (["exploration", "combat"].includes(s.status) && !s.members.some(m => s.attending.includes(m.id) && m.lastSeen > Date.now() - 45000)) {
      s.pauseRequested = !!s.job;
      await pauseCampaign(this, s, "所有出席玩家离线，冒险自动暂停");
    }
    if (s.deletion?.expires && s.deletion.expires <= Date.now()) {
      const members = s.members;
      this.ctx.storage.transactionSync(() => { this.sql.exec("DELETE FROM events; DELETE FROM receipts; DELETE FROM records"); this.write("state", { deleted: true }); });
      for (const m of members) await this.env.TRPG_IDENTITY.getByName(m.id).unlinkCampaign(s.id);
      return;
    }
    if (["exploration", "combat"].includes(s.status) && s.room) await this.env.CHAT_ROOM.getByName(s.room).renewTrpg(s.id);
    const active = ["exploration", "combat"].includes(s.status) || s.job && ["planning", "narrating", "settled"].includes(s.job.phase);
    if (active) await this.ctx.storage.setAlarm(Date.now() + 45000);
    else if (s.deletion?.expires) await this.ctx.storage.setAlarm(s.deletion.expires);
    else await this.ctx.storage.deleteAlarm();
  }
}
