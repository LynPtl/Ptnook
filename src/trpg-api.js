import { boundedJson, insist, HttpError, digest } from "./trpg-store.js";
import { text } from "./trpg-rules.js";
import { CAMPAIGN } from "./trpg-content.js";

export function aiConfiguration(env) {
  let valid = false;
  try { const url = new URL(env.TRPG_AI_URL); valid = url.protocol === "https:" && !url.username && !url.password; } catch {}
  return { ready: !!(valid && env.TRPG_AI_KEY && env.TRPG_AI_MODEL && env.TRPG_AI_PROVIDER && env.TRPG_AI_POLICY), provider: env.TRPG_AI_PROVIDER || "尚未配置", model: env.TRPG_AI_MODEL || "", policy: env.TRPG_AI_POLICY || "" };
}

function credentials(value) {
  const match = typeof value === "string" && value.match(/^([a-f0-9-]{36})\.([a-f0-9]{64})$/);
  insist(match, 401, "会话或恢复码无效");
  return { id: match[1], secret: match[2] };
}
function cookie(value, url, clear = false) {
  return `ptnook_trpg=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : 2592000}${url.protocol === "https:" ? "; Secure" : ""}`;
}
function json(data, status = 200, headers = {}) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers } });
}
export async function handleTrpg(request, env) {
  const url = new URL(request.url); const path = url.pathname.slice("/api/trpg".length);
  try {
    insist(["GET", "POST"].includes(request.method), 405, "不支持的请求方法");
    if (request.method === "POST") {
      insist(request.headers.get("Origin") === url.origin, 403, "请求来源不正确");
      insist(request.headers.get("Content-Type")?.startsWith("application/json"), 415, "请使用 JSON 请求");
    }
    const input = request.method === "POST" ? await boundedJson(request) : null;
    if (request.method === "POST") insist(input && typeof input === "object" && !Array.isArray(input), 400, "请求必须是 JSON 对象");
    if (path === "/config" && request.method === "GET") return json({ ai: aiConfiguration(env), campaign: { name: CAMPAIGN.name, introduction: CAMPAIGN.introduction } });
    if (["/identity", "/recover"].includes(path) && request.method === "POST") {
      const ip = await digest(request.headers.get("CF-Connecting-IP") || "local");
      await env.TRPG_QUOTA.getByName(`auth:${ip}`).throttle(path, 20, 60000);
      let result;
      if (path === "/identity") {
        insist(input.consent === true, 400, "请先确认数据保存与 AI 处理说明");
        const id = crypto.randomUUID(); result = await env.TRPG_IDENTITY.getByName(id).create(id, text(input.name, 32));
      } else {
        const { id, secret } = credentials(input.recovery); result = await env.TRPG_IDENTITY.getByName(id).recover(secret);
      }
      const { session, ...publicResult } = result;
      return json(publicResult, 200, { "Set-Cookie": cookie(session, url) });
    }
    const raw = (request.headers.get("Cookie") || "").split(";").map(s => s.trim()).find(s => s.startsWith("ptnook_trpg="))?.slice(12);
    const { id, secret } = credentials(raw);
    const identity = env.TRPG_IDENTITY.getByName(id); const player = await identity.authenticate(secret);
    insist(player, 401, "身份已过期，请使用恢复码重新进入");
    if (request.method === "POST") await env.TRPG_QUOTA.getByName(`player:${id}`).throttle("write", 120, 60000);
    if (path === "/me" && request.method === "GET") return json({ player: { id, name: player.name } });
    if (path === "/rotate" && input) return json(await identity.rotate(secret));
    if (path === "/logout" && input) { await identity.revoke(secret); return json({ ok: true }, 200, { "Set-Cookie": cookie("", url, true) }); }
    if (path === "/revoke" && input) return json(await identity.revoke(secret, true));
    if (path === "/campaigns") {
      if (input) {
        const campaignId = crypto.randomUUID();
        await identity.reserveCampaign(campaignId);
        try {
          const campaign = await env.TRPG_CAMPAIGN.getByName(campaignId).initialize(campaignId, player, input);
          return json({ campaign });
        } catch (error) { await identity.unlinkCampaign(campaignId); throw error; }
      }
      const campaigns = [];
      for (const ref of player.campaigns) {
        try { const s = await env.TRPG_CAMPAIGN.getByName(ref.id).view(player); campaigns.push({ id: s.id, name: s.name, status: s.status, chapter: s.chapter, updated: s.updated, members: s.members.length }); }
        catch (error) { if (!/^\[TRPG:(403|404)\]/.test(error.message)) throw error; }
      }
      return json({ campaigns });
    }
    if (path === "/join" && input) {
      const { id: campaignId, secret: invitation } = credentials(input.invite);
      return json(await env.TRPG_CAMPAIGN.getByName(campaignId).requestJoin(player, invitation));
    }
    const match = path.match(/^\/campaigns\/([a-f0-9-]{36})(?:\/(command|invite|events))?$/);
    insist(match, 404, "接口不存在");
    const campaign = env.TRPG_CAMPAIGN.getByName(match[1]);
    if (!match[2] && request.method === "GET") return json({ campaign: await campaign.view(player, true) });
    if (match[2] === "invite" && input) return json(await campaign.issueInvite(player));
    if (match[2] === "command" && input) {
      if (["draft", "withdraw", "submit", "combat", "rest"].includes(input.type)) insist(typeof input.context === "string" && input.context.length <= 100, 400, "缺少当前行动轮次，请刷新后重试");
      return json(await campaign.command(player, input));
    }
    if (match[2] === "events" && request.method === "GET") {
      const before = Number(url.searchParams.get("before") || 0); insist(Number.isSafeInteger(before) && before >= 0, 400, "事件游标无效");
      return json({ events: await campaign.listEvents(player, before) });
    }
    throw new HttpError(405, "不支持的请求方法");
  } catch (error) {
    if (request.body && !request.bodyUsed && !request.body.locked) await request.body.cancel();
    const known = error.message?.match(/^\[TRPG:(\d{3})\](.*)$/s);
    const status = known ? Number(known[1]) : error instanceof RangeError ? 400 : 500;
    if (status === 500) console.error(JSON.stringify({ kind: "trpg_request_failed", path, type: error.name }));
    return json({ error: known ? known[2] : status === 400 ? error.message : "服务暂时不可用，进度已保存，请稍后重试" }, status);
  }
}
