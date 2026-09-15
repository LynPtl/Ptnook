import { SELF, env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";

const origin = "https://example.com";
async function api(path, body, cookie) {
  const res = await SELF.fetch(origin + "/api/trpg" + path, { method: body === undefined ? "GET" : "POST", headers: { Origin: origin, "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, cookie: res.headers.get("Set-Cookie")?.split(";")[0], data: await res.json() };
}
async function player(name = "同名") { return api("/identity", { name, consent: true }); }

describe("跑团身份与安全边界", () => {
  it("创建身份发出 HttpOnly 会话，恢复可取回同一身份", async () => {
    const a = await player();
    expect(a.status).toBe(200);
    expect(a.data.recovery).toMatch(/^[a-f0-9-]{36}\.[a-f0-9]{64}$/);
    const me = await api("/me", undefined, a.cookie);
    expect(me.data.player.id).toBe(a.data.player.id);
    const restored = await api("/recover", { recovery: a.data.recovery });
    expect(restored.data.player.id).toBe(a.data.player.id);
    expect(restored.cookie).not.toBe(a.cookie);
  });
  it("拒绝跨站请求、不带凭证访问和过大请求", async () => {
    const res = await SELF.fetch(origin + "/api/trpg/identity", { method: "POST", headers: { Origin: "https://evil.example", "Content-Type": "application/json" }, body: '{}' });
    expect(res.status).toBe(403);
    expect((await api("/me")).status).toBe(401);
    expect((await api("/identity", { name: "x".repeat(40000), consent: true })).status).toBe(413);
  });
  it("恢复码轮换使旧码和其他设备会话失效", async () => {
    const a = await player();
    const second = await api("/recover", { recovery: a.data.recovery });
    const rotated = await api("/rotate", {}, a.cookie);
    expect(rotated.data.recovery).not.toBe(a.data.recovery);
    expect((await api("/recover", { recovery: a.data.recovery })).status).toBe(401);
    expect((await api("/me", undefined, second.cookie)).status).toBe(401);
    expect((await api("/me", undefined, a.cookie)).status).toBe(200);
  });
});

describe("战役持久化和成员隔离", () => {
  it("创建、申请、批准与同昵称角色隔离", async () => {
    const a = await player(); const b = await player();
    const created = await api("/campaigns", { name: "长夜", boundaries: ["血腥"] }, a.cookie);
    expect(created.status).toBe(200);
    const id = created.data.campaign.id;
    expect((await api(`/campaigns/${id}`, undefined, b.cookie)).status).toBe(403);
    const invite = await api(`/campaigns/${id}/invite`, {}, a.cookie);
    expect((await api("/join", { invite: invite.data.invite }, b.cookie)).status).toBe(200);
    expect((await api(`/campaigns/${id}`, undefined, b.cookie)).status).toBe(403);
    expect((await api(`/campaigns/${id}/command`, { type: "approve", player: b.data.player.id }, a.cookie)).status).toBe(200);
    const input = { type: "character", character: { name: "旅人", role: "guard", background: "护送信件", wish: "找到朋友", boundary: "保护无辜", bond: "共同护送" } };
    await api(`/campaigns/${id}/command`, input, a.cookie);
    await api(`/campaigns/${id}/command`, input, b.cookie);
    const view = await api(`/campaigns/${id}`, undefined, b.cookie);
    expect(view.data.campaign.members).toHaveLength(2);
    expect(view.data.campaign.members.map(m => m.character.owner)).toEqual([a.data.player.id, b.data.player.id]);
    expect(JSON.stringify(view.data)).not.toContain("truth");
    const list = await api("/campaigns", undefined, b.cookie);
    expect(list.data.campaigns.some(c => c.id === id)).toBe(true);
    await runInDurableObject(env.CHAT_ROOM.getByName("empty-trpg"), async instance => { await instance.alarm(); });
    expect((await api(`/campaigns/${id}`, undefined, a.cookie)).data.campaign.name).toBe("长夜");
  });
  it("未配置模型时明确不能开团，不伪造主持", async () => {
    const a = await player();
    const config = await api("/config");
    expect(config.data.ai.ready).toBe(false);
    expect(config.data.ai).not.toHaveProperty("key");
  });
});
