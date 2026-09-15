export function trpgClient() {
  const $ = id => document.getElementById(id);
  const phases = { waiting: "等待准备", exploration: "探索中", combat: "战斗中", paused: "已暂停", ended: "已完结", archived: "已归档" };
  const roles = { guard: "守卫", ranger: "游侠", mage: "秘术师", healer: "祈愿者" };
  const statNames = { body: "体魄", agility: "灵巧", insight: "洞察", lore: "学识", will: "意志" };
  let player, campaign, config, selectedOption = null, events = [], refreshing = false, busy = false, sound = "chat", audio;
  try { sound = localStorage.getItem("ptnook:sound:mode") || "chat"; } catch {}
  function feedback(value, error = false) { $("feedback").textContent = value; $("feedback").className = error ? "error" : ""; }
  function el(tag, text, cls) { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; return e; }
  function button(parent, label, handler, cls = "") { const b = el("button", label, cls); b.type = "button"; b.onclick = () => perform(handler); parent.append(b); return b; }
  function form(id) { return Object.fromEntries(new FormData($(id))); }
  function themes(value) { return value.split(/[,，]/).map(s => s.trim()).filter(Boolean); }
  async function request(path, body) {
    const response = await fetch("/api/trpg" + path, { credentials: "same-origin", ...(body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
    const data = await response.json();
    if (!response.ok) { if (response.status === 401) { player = null; campaign = null; events = []; $("story").replaceChildren(); show("auth"); } throw new Error(data.error); }
    return data;
  }
  async function perform(fn) {
    if (busy) return; busy = true; feedback("正在保存…");
    try { await fn(); feedback(""); } catch (error) { feedback(error.message, true); }
    finally { busy = false; }
  }
  function bindForm(id, handler) { $(id).onsubmit = event => { event.preventDefault(); perform(() => handler(form(id))); }; }
  function show(id) { for (const name of ["auth", "lobby", "campaign"]) $(name).hidden = name !== id; }
  function modal(title, message) {
    $("dialogTitle").textContent = title; $("dialogBody").replaceChildren(el("p", message, "code"));
    if (!$("messageDialog").open) $("messageDialog").showModal();
  }
  function soundLabel() { $("sound").textContent = sound === "off" ? "提示音 关" : sound === "all" ? "提示音 全部" : "提示音 聊天"; }
  function beep(key) {
    if (sound !== "all" || !document.hidden) return;
    try {
      if (sessionStorage.getItem("trpg:notice") === key) return;
      sessionStorage.setItem("trpg:notice", key);
      audio ||= new AudioContext();
      const oscillator = audio.createOscillator(), gain = audio.createGain(); oscillator.connect(gain); gain.connect(audio.destination);
      gain.gain.setValueAtTime(0.1, audio.currentTime); gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.2);
      oscillator.frequency.value = 660; oscillator.start(); oscillator.stop(audio.currentTime + 0.2);
    } catch {}
  }
  $("sound").onclick = () => { sound = sound === "chat" ? "all" : sound === "all" ? "off" : "chat"; try { localStorage.setItem("ptnook:sound:mode", sound); } catch {} soundLabel(); };
  soundLabel();
  async function lobby() {
    campaign = null; history.replaceState(null, "", "/trpg" + location.search); show("lobby");
    const { campaigns } = await request("/campaigns");
    $("campaignList").replaceChildren();
    if (!campaigns.length) $("campaignList").append(el("div", "还没有战役。发起一场冒险，或输入朋友的邀请口令。", "panel"));
    for (const c of campaigns) {
      const box = el("div", undefined, "panel"); box.append(el("h2", c.name), el("p", `第 ${c.chapter} 章 · ${phases[c.status]} · ${c.members} 位成员`, "muted"));
      button(box, "进入战役", () => openCampaign(c.id), "primary"); $("campaignList").append(box);
    }
  }
  async function openCampaign(id) {
    const response = await request(`/campaigns/${id}`); campaign = response.campaign; events = [];
    history.replaceState(null, "", "/trpg" + location.search + "#" + id); show("campaign");
    $("roomName").value = new URLSearchParams(location.search).get("room") || campaign.room || "";
    render(); await refreshEvents();
  }
  async function command(type, data = {}) {
    const id = campaign.id;
    try {
      const response = await request(`/campaigns/${id}/command`, { type, context: campaign.context, ...data });
      if (response.left) return lobby();
      if (!campaign || campaign.id !== id) return;
      campaign = response.campaign; render(); await refreshEvents();
    } catch (error) {
      if (player && campaign?.id === id) {
        try { campaign = (await request(`/campaigns/${id}`)).campaign; render(); } catch {}
      }
      throw error;
    }
  }
  async function refreshEvents(older = false) {
    if (!campaign) return;
    const first = older ? events[0]?.id || 0 : 0;
    const response = await request(`/campaigns/${campaign.id}/events${first ? "?before=" + first : ""}`);
    const map = new Map(events.map(e => [e.id, e])); response.events.forEach(e => map.set(e.id, e));
    events = [...map.values()].sort((a, b) => a.id - b.id);
    renderEvents();
  }
  function renderEvents() {
    const box = $("story"); const bottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 80;
    let read = 0; try { read = Number(localStorage.getItem("trpg:read:" + campaign.id) || 0); } catch {}
    box.replaceChildren();
    for (const event of events) {
      const entry = el("article", undefined, "event " + event.kind + (event.id > read ? " new" : ""));
      entry.append(el("div", `第 ${event.chapter} 章 · 事件 ${event.id} · ${new Date(event.ts).toLocaleTimeString()}`, "meta"), el("div", event.title));
      const checks = event.result?.checks || event.events || [];
      for (const c of checks) {
        if (c.rolls) entry.append(el("p", `${c.intent || c.actor || "检定"}：d20 [${c.rolls.join(" / ")}] ＋ ${c.modifier} = ${c.total}，目标 ${c.difficulty}；${{ success: "成功", partial: "带代价成功", failure: "失败" }[c.outcome]}${c.damage !== undefined ? "，伤害 " + c.damage : ""}`, "muted"));
      }
      button(entry, "与记录不符", () => { const reason = prompt("请说明与哪条已知事实冲突（不会重新掷骰）"); return reason && command("report", { event: event.id, text: reason }); });
      box.append(entry);
    }
    if (bottom) box.scrollTop = box.scrollHeight;
    if (!document.hidden) try { localStorage.setItem("trpg:read:" + campaign.id, String(campaign.lastEvent)); } catch {}
  }
  function list(id, items, formatter, empty = "暂时没有记录") {
    $(id).replaceChildren(); if (!items.length) $(id).append(el("p", empty, "muted"));
    for (const item of items) $(id).append(el("p", formatter(item)));
  }
  function render() {
    const s = campaign, me = s.members.find(m => m.id === player.id), owner = s.owner === player.id;
    $("campaignTitle").textContent = s.name; $("phase").textContent = phases[s.status];
    $("goal").textContent = `第 ${s.chapter} 章 · ${s.chapterName} / 当前目标：${s.scene.goal}`;
    $("sceneName").textContent = s.scene.name; $("saved").textContent = "已保存 · " + new Date(s.updated).toLocaleTimeString();
    $("ready").textContent = me.ready ? "已准备（点击取消）" : "我已准备好";
    $("start").hidden = !owner && s.proxy !== player.id; $("invite").hidden = !owner;
    $("ready").disabled = !["waiting", "paused"].includes(s.status);
    $("start").disabled = !config.ai.ready || !["waiting", "paused"].includes(s.status);
    $("campaignNotice").hidden = !s.warning && !s.deletion && config.ai.ready;
    $("campaignNotice").textContent = s.warning || (s.deletion ? "战役正在删除确认／冷静期内，只读；任何成员可取消。" : "AI 尚未配置，角色与准备流程可用，暂时无法开始冒险。");
    $("members").replaceChildren(); $("requests").replaceChildren(); $("assistTarget").replaceChildren();
    for (const m of s.members) {
      const box = el("div", undefined, "member"); box.append(el("strong", m.character?.name || m.name), el("div", `${m.online ? "在线" : "离线"} · ${m.ready ? "已准备" : "未准备"} · ${m.character ? roles[m.character.role] + " HP " + m.character.hp + "/8" : "未建角色"}`, "muted"));
      if (owner && m.id !== player.id) {
        button(box, "转交发起人", () => command("transfer", { player: m.id }));
        button(box, "移除成员", () => confirm("仅在安全暂停点移除该成员？") && command("remove", { player: m.id }), "danger");
      }
      $("members").append(box);
      if (m.id !== player.id) { const o = el("option", m.character?.name || m.name); o.value = m.id; $("assistTarget").append(o); }
    }
    for (const req of s.requests) { const row = el("p", req.name + " 请求加入 "); button(row, "批准", () => command("approve", { player: req.id })); $("requests").append(row); }
    $("myCharacter").replaceChildren();
    if (me.character) {
      const c = me.character; $("myCharacter").append(el("p", `${c.name} · ${roles[c.role]} · HP ${c.hp}/${c.maxHp}`), el("p", Object.entries(c.stats).map(([k, v]) => `${statNames[k]} ${v >= 0 ? "+" : ""}${v}`).join(" / "), "muted"), el("p", c.background), el("p", "愿望：" + c.wish), el("p", "底线：" + c.boundary), el("p", "物品：" + c.items.map(i => i.name + " ×" + i.count).join("、")));
      if (s.stage > c.upgrades.length + 1) for (const choice of ["A", "B"].filter(x => !c.upgrades.includes(x))) button($("myCharacter"), "选择成长 " + choice, () => command("grow", { choice }));
    } else $("myCharacter").append(el("p", "请先创建角色。"));
    $("characterEditor").hidden = !!me.character && s.status !== "waiting";
    $("bondControls").replaceChildren();
    if (me.character) {
      $("bondControls").append(el("p", "队友关系：" + me.character.bond + (me.character.bondAccepted ? "（已确认）" : "（待确认）"), "muted"));
      for (const other of s.members.filter(m => m.id !== player.id && m.character)) {
        if (!me.character.bondAccepted) button($("bondControls"), "与 " + other.character.name + " 建立关系", () => command("bond", { player: other.id, text: me.character.bond }));
        if (other.character.bondWith === player.id && !other.character.bondAccepted) button($("bondControls"), "确认 " + other.character.name + " 的关系：" + other.character.bond, () => command("accept_bond", { player: other.id }));
      }
    }
    $("options").replaceChildren();
    for (const option of s.options) button($("options"), option.label + (option.major ? "（全队确认）" : ""), () => { selectedOption = option.id; $("actionForm").elements.kind.value = "action"; $("actionForm").elements.text.value = option.label; $("selectedOption").textContent = "已选择建议：" + option.label; });
    $("drafts").replaceChildren();
    for (const [id, d] of Object.entries(s.drafts)) $("drafts").append(el("p", (s.members.find(m => m.id === id)?.character?.name || "队友") + "：" + ({ wait: "观察等待", assist: "协助：", action: "行动：" }[d.kind]) + (d.kind === "wait" ? "" : d.text), "muted"));
    $("judgment").replaceChildren();
    if (s.job) {
      const j = s.job;
      $("judgment").append(el("p", ({ planning: "主持正在理解行动…", confirm: "请确认判定与风险", narrating: "判定已保存，主持正在叙述…", failed_plan: "行动理解暂时失败", failed_narration: "结果已保存，叙述暂时失败", settled: "判定已保存" }[j.phase]) || j.phase, "notice"));
      for (const card of j.cards) {
        const box = el("div", undefined, "card"); box.append(el("strong", card.name + "：" + card.intent), el("p", card.check ? `${statNames[card.check.stat]}检定 · 目标 ${card.check.difficulty}${card.helper ? " · 有队友协助，优势" : ""}` : "无需掷骰"), el("p", card.resource), el("p", `成功：${card.success}\n部分成功：${card.partial}\n失败：${card.failure}`, "muted")); $("judgment").append(box);
      }
      if (j.error) $("judgment").append(el("p", j.error, "error"));
      if (j.phase === "confirm") {
        button($("judgment"), j.approvals.includes(player.id) ? "你已确认，等待队友" : "确认并判定", () => command("confirm", { operation: j.id }), "primary");
        button($("judgment"), "取消本轮，重新讨论", () => command("cancel_round")); beep(s.id + j.id);
      }
      if (j.phase.startsWith("failed")) button($("judgment"), "重试未完成阶段", () => command("retry"));
      if (j.phase === "failed_narration") button($("judgment"), "发布系统简报并暂停", () => command("brief"));
    }
    const locked = !!s.job || s.status !== "exploration";
    for (const e of $("actionForm").elements) e.disabled = locked;
    $("options").querySelectorAll("button").forEach(b => { b.disabled = locked; });
    list("clues", s.clues, c => `${c.kind === "theory" ? "推测" : c.kind === "claim" ? "说法" : "事实"} · ${c.title}：${c.text}（事件 ${c.event}）`);
    list("npcs", s.npcs, n => `${n.name}：${n.description} · 态度 ${["敌对", "戒备", "中立", "信任", "盟友"][n.relationship + 2]}`);
    list("promises", [...s.promises.map(p => ({ text: p.status + "：" + p.text })), ...s.items.map(i => ({ text: i.name + " ×" + i.count }))], p => p.text);
    list("summaries", s.summaries.slice(-8), x => `第 ${x.chapter} 章 · 事件 ${x.event}：${x.text}`);
    list("discussion", s.discussion, d => `${d.name}：${d.text}`);
    $("management").replaceChildren();
    if (owner) {
      button($("management"), s.status === "archived" ? "恢复归档" : "归档战役", () => command(s.status === "archived" ? "unarchive" : "archive"));
      button($("management"), "撤销邀请口令", () => command("revoke_invite"));
      button($("management"), "请求永久删除", () => confirm("需要全员确认，随后等待 7 天。是否发起？") && command("delete_request"), "danger");
    } else button($("management"), "退出战役", () => confirm("退出后将失去访问权，角色会归档。继续？") && command("leave"), "danger");
    if (s.transfer === player.id) button($("management"), "接受发起人权限", () => command("accept_transfer"));
    if (s.deletion) { button($("management"), "确认删除", () => command("delete_confirm"), "danger"); button($("management"), "取消删除", () => command("delete_cancel")); }
    if (me.character && ["paused", "waiting"].includes(s.status) && !s.battle) {
      for (const other of s.members.filter(m => m.id !== player.id && m.character)) for (const item of me.character.items.filter(i => i.count > 0)) button($("myCharacter"), `赠予 ${other.character.name}：${item.name}`, () => command("offer_item", { player: other.id, item: item.id }));
    }
    if (s.trade) {
      $("myCharacter").append(el("p", "待确认的物品转移：" + s.trade.name));
      if (s.trade.to === player.id) button($("myCharacter"), "接受物品", () => command("accept_item"));
      if ([s.trade.from, s.trade.to].includes(player.id)) button($("myCharacter"), "取消物品转移", () => command("cancel_item"));
    }
    if (s.correction) {
      $("judgment").append(el("p", `事件 ${s.correction.event} 待核对：${s.correction.text}`, "notice"));
      button($("judgment"), "使用权威判定生成更正简报", () => command("correct_brief"));
      if (s.correction.player === player.id) button($("judgment"), "撤回核对请求", () => command("dismiss_report"));
    }
    for (const clue of s.clues.filter(c => c.kind === "theory" && c.author === player.id)) button($("clues"), "编辑推测：" + clue.text.slice(0, 20), () => { const value = prompt("修改你的推测", clue.text); return value && command("edit_theory", { clue: clue.id, text: value }); });
    renderBattle();
  }
  function renderBattle() {
    const b = campaign.battle; $("battlePanel").hidden = !b; $("battle").replaceChildren(); if (!b) return;
    const current = b.order[b.index]; $("battle").append(el("p", `${b.name} · 第 ${b.round} 回合 · ${b.goal}`));
    for (const unit of b.units) $("battle").append(el("div", `${unit.id === current ? "当前行动：" : ""}${unit.name} · ${unit.position === "front" ? "前线" : "后排"} · HP ${unit.hp}/${unit.maxHp}${unit.hp === 0 ? " · 倒地" : ""}`, "member" + (unit.id === current ? " active" : "")));
    button($("battle"), "同意全队撤离", () => command("retreat_vote"));
    if (current !== player.id || campaign.job) { $("battle").append(el("p", "等待当前行动者或主持结算。", "muted")); return; }
    beep(campaign.id + "combat" + b.round + current);
    const actor = b.units.find(u => u.id === player.id);
    const act = action => command("combat", { action, operation: crypto.randomUUID() });
    if (!b.moved) button($("battle"), actor.position === "front" ? "移到后排" : "移到前线", () => act({ kind: "move", position: actor.position === "front" ? "back" : "front" }));
    button($("battle"), "防御", () => act({ kind: "defend" }));
    button($("battle"), "执行全队撤离", () => act({ kind: "retreat" }));
    for (const target of b.units) {
      if (target.side === "enemy" && target.hp > 0) {
        button($("battle"), "攻击 " + target.name, () => act({ kind: "attack", target: target.id }));
        if (["ranger", "mage"].includes(actor.role)) button($("battle"), "职业能力 → " + target.name, () => act({ kind: "ability", target: target.id }));
      }
      if (target.side === "party") {
        if (target.id !== player.id && target.hp > 0) button($("battle"), "协助 " + target.name, () => act({ kind: "assist", target: target.id }));
        if (["guard", "healer"].includes(actor.role) && (actor.role === "healer" || target.id !== player.id)) button($("battle"), "职业能力 → " + target.name, () => act({ kind: "ability", target: target.id }));
        if (actor.potions > 0) button($("battle"), "药剂 → " + target.name, () => act({ kind: "potion", target: target.id }));
      }
    }
  }
  bindForm("createIdentity", async values => { const data = await request("/identity", { name: values.name, consent: values.consent === "on" }); player = data.player; modal("请保存恢复码，丢失后可能无法找回", data.recovery); await lobby(); });
  bindForm("recoverIdentity", async values => { const data = await request("/recover", values); player = data.player; $("recoverIdentity").reset(); await lobby(); });
  bindForm("createCampaign", async values => { const data = await request("/campaigns", { name: values.name, boundaries: themes(values.boundaries) }); await openCampaign(data.campaign.id); });
  bindForm("joinCampaign", async values => { const result = await request("/join", values); if (result.approved) await openCampaign(result.id); else modal("已提交申请", "等待发起人批准，然后点击“我的战役”刷新列表。"); });
  bindForm("characterForm", values => command("character", { character: values }));
  bindForm("preferencesForm", values => command("preferences", { away: values.away === "on", boundaries: themes(values.boundaries) }));
  bindForm("actionForm", async values => { await command("draft", { ...values, option: values.kind === "action" ? selectedOption : null }); selectedOption = null; $("selectedOption").textContent = ""; });
  $("actionForm").elements.text.addEventListener("input", () => { selectedOption = null; $("selectedOption").textContent = "自由行动：由主持理解后确认"; });
  bindForm("discussForm", async values => { await command("discuss", values); $("discussForm").reset(); });
  bindForm("theoryForm", async values => { await command("theory", values); $("theoryForm").reset(); });
  $("home").onclick = () => perform(() => player ? lobby() : show("auth"));
  $("ready").onclick = () => perform(() => command("ready", { ready: !campaign.members.find(m => m.id === player.id).ready }));
  $("start").onclick = () => perform(() => command("start", { room: $("roomName").value }));
  const stop = type => command(type).catch(error => feedback(error.message, true));
  $("pause").onclick = () => stop("pause"); $("safety").onclick = () => stop("safety");
  $("rest").onclick = () => perform(() => command("rest")); $("withdraw").onclick = () => perform(() => command("withdraw"));
  $("submitRound").onclick = () => perform(() => command("submit", { operation: crypto.randomUUID() }));
  $("invite").onclick = () => perform(async () => { const data = await request(`/campaigns/${campaign.id}/invite`, {}); modal("邀请口令（新口令会使旧口令失效）", data.invite); });
  $("older").onclick = () => perform(() => refreshEvents(true));
  $("export").onclick = () => perform(async () => {
    let all = [], before = 0;
    do { const page = await request(`/campaigns/${campaign.id}/events${before ? "?before=" + before : ""}`); all = [...page.events, ...all]; if (page.events.length < 50) break; before = page.events[0].id; } while (before);
    const blob = new Blob([JSON.stringify({ campaign, events: all }, null, 2)], { type: "application/json" }); const url = URL.createObjectURL(blob); const a = el("a"); a.href = url; a.download = "ptnook-campaign.json"; a.click(); URL.revokeObjectURL(url);
  });
  $("identityOpen").onclick = () => {
    if (!player) return show("auth");
    $("dialogTitle").textContent = "身份与恢复 · " + player.name; $("dialogBody").replaceChildren(el("p", "恢复码持有者可以操作你的全部跑团角色。仅在可信设备保存；任何人都不应索要你的恢复码。"));
    button($("dialogBody"), "轮换恢复码并撤销其他设备", async () => { if (!confirm("旧恢复码和其他设备会话将失效，继续？")) return; const data = await request("/rotate", {}); modal("请立即保存新恢复码", data.recovery); });
    button($("dialogBody"), "撤销其他设备会话", async () => { await request("/revoke", {}); modal("已撤销", "其他设备需要使用恢复码重新进入。"); });
    button($("dialogBody"), "退出本机", async () => { await request("/logout", {}); player = null; campaign = null; $("messageDialog").close(); show("auth"); });
    $("messageDialog").showModal();
  };
  async function refresh() {
    if (!campaign || refreshing || busy) return;
    refreshing = true;
    try {
      const id = campaign.id; const data = await request(`/campaigns/${id}`);
      if (!campaign || campaign.id !== id) return;
      const changed = data.campaign.version !== campaign.version; campaign = data.campaign;
      if (changed && !busy) { render(); await refreshEvents(); }
    } catch (error) { feedback(error.message, true); }
    finally { refreshing = false; }
  }
  setInterval(refresh, 5000);
  window.addEventListener("focus", refresh);
  perform(async () => {
    config = await request("/config");
    $("provider").textContent = "AI 服务商：" + config.ai.provider + (config.ai.policy ? " · 数据政策：" + config.ai.policy : "");
    $("aiNotice").textContent = config.ai.ready ? "AI 主持已配置。正式行动会发送给 " + config.ai.provider + "，模型调用受每日额度限制。" : "AI 尚未配置。你可以建立身份、创建战役和角色；管理员配置模型后才能开始冒险。";
    try { player = (await request("/me")).player; } catch { show("auth"); return; }
    if (/^[a-f0-9-]{36}$/.test(location.hash.slice(1))) await openCampaign(location.hash.slice(1)); else await lobby();
  });
}

trpgClient();
