import { TrpgStore, insist, token, digest, equalHash } from "./trpg-store.js";

const DAY = 86400000;
export class TrpgIdentity extends TrpgStore {
  async create(id, name) {
    insist(!this.read("player"), 409, "身份已经存在");
    const recovery = token(); const session = token();
    const [recoveryHash, sessionHash] = await Promise.all([digest(recovery), digest(session)]);
    this.ctx.storage.transactionSync(() => {
      this.write("player", { id, name, recoveryHash, campaigns: [], version: 1 });
      this.write("sessions", [{ hash: sessionHash, expires: Date.now() + 30 * DAY }]);
    });
    return { player: { id, name }, recovery: `${id}.${recovery}`, session: `${id}.${session}` };
  }
  async authenticate(secret) {
    const hash = await digest(secret);
    const player = this.read("player");
    const sessions = this.read("sessions") || [];
    if (!player || !sessions.some(s => s.expires > Date.now() && equalHash(hash, s.hash))) return null;
    return { id: player.id, name: player.name, campaigns: player.campaigns, version: player.version };
  }
  async recover(secret) {
    const hash = await digest(secret);
    const session = token(); const sessionHash = await digest(session);
    const player = this.read("player");
    insist(player && equalHash(hash, player.recoveryHash), 401, "恢复码无效或已失效");
    const sessions = (this.read("sessions") || []).filter(s => s.expires > Date.now()).slice(-9);
    sessions.push({ hash: sessionHash, expires: Date.now() + 30 * DAY });
    this.write("sessions", sessions);
    return { player: { id: player.id, name: player.name }, session: `${player.id}.${session}` };
  }
  async rotate(secret) {
    const recovery = token(); const recoveryHash = await digest(recovery); const hash = await digest(secret);
    const player = this.read("player"); const sessions = this.read("sessions") || [];
    const session = sessions.find(s => equalHash(hash, s.hash) && s.expires > Date.now());
    insist(player && session, 401, "会话已失效");
    player.recoveryHash = recoveryHash; player.version++;
    this.ctx.storage.transactionSync(() => { this.write("player", player); this.write("sessions", [session]); });
    return { recovery: `${player.id}.${recovery}` };
  }
  async revoke(secret, others = false) {
    const hash = await digest(secret);
    const sessions = this.read("sessions") || [];
    insist(sessions.some(s => equalHash(hash, s.hash) && s.expires > Date.now()), 401, "会话已失效");
    this.write("sessions", sessions.filter(s => others ? equalHash(hash, s.hash) : !equalHash(hash, s.hash)));
    return { ok: true };
  }
  reserveCampaign(id) {
    const p = this.read("player");
    insist(p, 401, "身份不存在");
    const existing = p.campaigns.find(c => c.id === id);
    if (existing?.owner) return;
    insist(p.campaigns.filter(c => c.owner).length < 3, 409, "最多拥有三个战役，归档也计入");
    if (existing) existing.owner = true;
    else p.campaigns.push({ id, owner: true });
    this.write("player", p);
  }
  linkCampaign(id, owner = false) {
    const p = this.read("player"); insist(p, 401, "身份不存在");
    const existing = p.campaigns.find(c => c.id === id);
    if (existing) existing.owner = owner;
    else { insist(p.campaigns.length < 50, 409, "参与战役数量达到上限"); p.campaigns.push({ id, owner }); }
    this.write("player", p);
  }
  unlinkCampaign(id) {
    const p = this.read("player"); if (!p) return;
    p.campaigns = p.campaigns.filter(c => c.id !== id); this.write("player", p);
  }
}

export class TrpgQuota extends TrpgStore {
  throttle(key, limit, windowMs) {
    const now = Date.now(); const old = this.read(key);
    const value = old && old.until > now ? old : { until: now + windowMs, count: 0 };
    insist(value.count < limit, 429, "请求过于频繁，请稍后重试");
    value.count++; this.write(key, value);
  }
  reserve(id, amount, limit) {
    insist(Number.isSafeInteger(amount) && amount > 0 && Number.isSafeInteger(limit) && limit > 0, 503, "AI 预算配置不正确");
    const date = new Date().toISOString().slice(0, 10);
    let q = this.read("budget");
    if (!q || q.date !== date) q = { date, used: 0, reservations: {} };
    if (q.reservations[id]) return { date };
    insist(q.used + amount <= limit, 429, "今日 AI 额度已用完，进度已保存");
    q.used += amount; q.reservations[id] = amount; this.write("budget", q);
    return { date };
  }
  settle(id, date, actual) {
    const q = this.read("budget");
    if (!q || q.date !== date || !q.reservations[id]) return;
    const reserved = q.reservations[id];
    q.used += actual - reserved; delete q.reservations[id]; this.write("budget", q);
  }
}
