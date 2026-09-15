import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { Miniflare, Response } from "miniflare";

const playwright = process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : "playwright-core";
const { chromium } = await import(playwright);
const root = new URL("../", import.meta.url);
const built = await build({ entryPoints: [new URL("src/worker.js", root).pathname], bundle: true, write: false, format: "esm", platform: "browser", external: ["cloudflare:workers"] });
const client = await readFile(new URL("public/trpg-client.js", root), "utf8");
const calls = [];
const mf = new Miniflare({
  modules: true, script: built.outputFiles[0].text, compatibilityDate: "2025-10-11", host: "127.0.0.1", port: 8791,
  durableObjects: Object.fromEntries([ ["CHAT_ROOM", "ChatRoom"], ["TRPG_IDENTITY", "TrpgIdentity"], ["TRPG_CAMPAIGN", "TrpgCampaign"], ["TRPG_QUOTA", "TrpgQuota"] ].map(([key, className]) => [key, { className, useSQLite: true }])),
  bindings: { TRPG_AI_URL: "https://model.invalid/chat", TRPG_AI_KEY: "test-only-not-a-real-key", TRPG_AI_MODEL: "fixture", TRPG_AI_PROVIDER: "本地模拟（不调用外部服务）", TRPG_AI_POLICY: "只在测试内存中处理" },
  outboundService: async request => {
    assert.equal(request.url, "https://model.invalid/chat");
    const body = await request.json(); const context = JSON.parse(body.messages[1].content); calls.push(context);
    const output = context.actions ? { actions: Object.entries(context.actions).filter(([, d]) => d.kind === "action").map(([player, d]) => ({ player, intent: d.text, option: "notice", check: null })) } : { text: "队伍的行动已有结果。雾中的名单留下了线索，旅人们仍然可以自行选择接下来要前往哪里。" };
    return Response.json({ choices: [{ message: { content: JSON.stringify(output) } }], usage: { total_tokens: 200 } });
  },
});
let browser;
try {
  const url = await mf.ready;
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
  const contexts = await Promise.all([browser.newContext(), browser.newContext({ viewport: { width: 390, height: 844 } })]);
  const errors = [];
  for (const context of contexts) await context.route("**/trpg-client.js", route => route.fulfill({ body: client, contentType: "text/javascript" }));
  const [a, b] = await Promise.all(contexts.map(c => c.newPage()));
  for (const p of [a, b]) {
    p.on("pageerror", e => errors.push(e.message));
    p.on("response", async response => {
      if (response.url().includes("/command")) {
        const result = await response.json();
        console.log(JSON.stringify({ status: response.status(), error: result.error, phase: result.campaign?.job?.phase, aiError: result.campaign?.job?.error }));
      }
    });
  }
  async function identity(page, name) {
    await page.goto(new URL("/trpg", url).href);
    await page.locator("#createIdentity input[name=name]").fill(name);
    await page.locator("#createIdentity input[name=consent]").check();
    await page.locator("#createIdentity button").click();
    await page.locator("#messageDialog[open]").waitFor();
    const recovery = await page.locator("#dialogBody").innerText();
    await page.locator("#messageDialog form button").click();
    await page.locator("#lobby").waitFor({ state: "visible" }); return recovery;
  }
  const recovery = await identity(a, "冒烟甲"); await identity(b, "冒烟乙");
  await a.locator("#createCampaign input[name=name]").fill("浏览器测试战役");
  await a.locator("#createCampaign button").click(); await a.locator("#campaign").waitFor({ state: "visible" });
  const campaignURL = a.url();
  await a.locator("#invite").click(); await a.locator("#messageDialog[open]").waitFor();
  const invite = await a.locator("#dialogBody").innerText(); await a.locator("#messageDialog form button").click();
  await b.locator("#joinCampaign input").fill(invite); await b.locator("#joinCampaign button").click(); await b.locator("#messageDialog[open]").waitFor(); await b.locator("#messageDialog form button").click();
  await a.getByRole("button", { name: "批准", exact: true }).click();
  await b.locator("#home").click(); await b.getByRole("button", { name: "进入战役", exact: true }).click();
  for (const [p, name] of [[a, "甲角色"], [b, "乙角色"]]) {
    await p.locator("#characterEditor summary").click(); await p.locator("#characterForm input[name=name]").fill(name); await p.locator("#characterForm button").click();
    await p.locator("#myCharacter").getByText(name, { exact: false }).first().waitFor();
  }
  await a.getByRole("button", { name: "与 乙角色 建立关系" }).click(); await b.getByRole("button", { name: "与 甲角色 建立关系" }).click();
  await a.getByRole("button", { name: /^确认 乙角色 的关系/ }).click(); await b.getByRole("button", { name: /^确认 甲角色 的关系/ }).click();
  await a.locator("#ready").click(); await b.locator("#ready").click();
  await a.locator("#roomName").fill("smoke-room"); await a.locator("#start").click();
  await a.locator("#phase").filter({ hasText: "探索中" }).waitFor();
  await b.locator("#phase").filter({ hasText: "探索中" }).waitFor();
  await a.locator("#discussForm textarea").fill("PRIVATE_DISCUSSION_NOT_FOR_MODEL"); await a.locator("#discussForm button").click();
  await a.locator("#actionForm textarea").fill("我检查告示上的擦痕"); await a.locator("#actionForm button.primary").click();
  await b.locator("#actionForm select[name=kind]").selectOption("wait"); await b.locator("#actionForm button.primary").click();
  await a.locator("#submitRound").click(); await a.getByRole("button", { name: "确认并判定", exact: true }).click();
  await a.locator("#clues").getByText(/被擦去的名字/).waitFor();
  assert.equal(calls.length, 2);
  assert(!JSON.stringify(calls).includes("PRIVATE_DISCUSSION_NOT_FOR_MODEL"));
  await a.locator("#pause").click(); await a.locator("#phase").filter({ hasText: "已暂停" }).waitFor();
  await a.reload(); await a.locator("#clues").getByText(/被擦去的名字/).waitFor();
  const mobileOverflow = await b.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  assert.equal(mobileOverflow, false, "mobile page must not overflow horizontally");
  await a.locator("#identityOpen").click(); await a.getByRole("button", { name: "退出本机", exact: true }).click();
  await a.getByText("已有恢复码？", { exact: true }).click(); await a.locator("#recoverIdentity input").fill(recovery); await a.locator("#recoverIdentity button").click();
  await a.getByRole("button", { name: "进入战役", exact: true }).click(); await a.locator("#clues").getByText(/被擦去的名字/).waitFor();
  assert.equal(a.url(), campaignURL);
  await a.getByRole("button", { name: "赠予 乙角色：治疗药剂", exact: true }).click();
  await b.getByRole("button", { name: "接受物品", exact: true }).click();
  await b.locator("#myCharacter").getByText(/治疗药剂 ×2/).waitFor();
  await a.locator("#story .event.story").last().getByRole("button", { name: "与记录不符" }).click({ trial: true });
  a.once("dialog", dialog => dialog.accept("核对这段叙述与原始判定"));
  await a.locator("#story .event.story").last().getByRole("button", { name: "与记录不符" }).click();
  await a.getByRole("button", { name: "使用权威判定生成更正简报" }).click();
  await a.locator("#story .event.correction").waitFor();
  const campaignId = new URL(campaignURL).hash.slice(1);
  const state = async p => p.evaluate(async id => (await (await fetch('/api/trpg/campaigns/' + id)).json()).campaign, campaignId);
  const cmd = async (p, type, values = {}) => p.evaluate(async ({ id, type, values }) => {
    const s = (await (await fetch('/api/trpg/campaigns/' + id)).json()).campaign;
    const response = await fetch('/api/trpg/campaigns/' + id + '/command', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type, context: s.context, ...values }) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error); return result.campaign;
  }, { id: campaignId, type, values });
  await cmd(a, "ready", { ready: true }); await cmd(b, "ready", { ready: true }); await cmd(a, "start", { room: "smoke-room" });
  for (const option of ["archive", "dock", "protect", "fight"]) {
    await cmd(a, "draft", { kind: "action", option, text: option });
    await cmd(b, "draft", { kind: "wait", text: "" });
    const operation = crypto.randomUUID(); await cmd(a, "submit", { operation });
    let s = await cmd(a, "confirm", { operation });
    if (s.job?.phase === "confirm") s = await cmd(b, "confirm", { operation });
    assert(!s.job, "model narration must finish");
  }
  await a.reload(); await b.reload();
  await a.locator("#battlePanel").waitFor({ state: "visible" });
  const battleState = await state(a);
  const who = await a.evaluate(async () => (await (await fetch('/api/trpg/me')).json()).player.id);
  const activePage = battleState.battle.order[battleState.battle.index] === who ? a : b;
  await activePage.locator("#battle").getByRole("button", { name: "防御", exact: true }).click();
  await a.locator("#safety").click(); await a.locator("#phase").filter({ hasText: "已暂停" }).waitFor();
  const savedBattle = (await state(a)).battle;
  await a.reload(); await a.locator("#battlePanel").waitFor({ state: "visible" });
  assert.deepEqual((await state(a)).battle, savedBattle);
  const outsiderContext = await browser.newContext(); const outsider = await outsiderContext.newPage();
  await outsider.goto(new URL('/trpg', url).href);
  const unauthorized = await outsider.evaluate(async id => (await fetch('/api/trpg/campaigns/' + id)).status, campaignId);
  assert.equal(unauthorized, 401);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, model: "local fixture, no external AI calls", scenarios: ["two isolated players", "invite approval", "character and mutual bond", "ready and start", "free-text planning", "confirmation and roll", "discussion privacy", "pause and reload", "identity recovery", "390px mobile layout", "combat action UI", "safety pause", "battle reload", "unauthorized isolation", "consensual item transfer", "authoritative correction UI"], modelCalls: calls.length }));
} finally {
  if (browser) await browser.close();
  await mf.dispose();
}
