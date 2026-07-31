# 即时聊天室 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建一个免登录、房间名即口令的即时纯文字聊天室，部署在 Cloudflare Workers + Durable Objects，不保存历史。

**Architecture:** 单个 Worker 作为入口，按房间名把 WebSocket 请求路由到对应的 Durable Object（一个房间一个 DO 实例）。DO 使用 WebSocket Hibernation API 持有房间内所有连接，收到消息即广播，处理加入/离开的 presence 计数与系统消息。前端为单个内嵌 HTML 页面，由 Worker 在非 WS 请求时返回。

**Tech Stack:** JavaScript (ES modules)、Cloudflare Workers、Durable Objects (SQLite-backed, Hibernation API)、Wrangler、Vitest + `@cloudflare/vitest-pool-workers`。

## Global Constraints

- 运行时：Cloudflare Workers；模块入口 `src/worker.js`（`export default { fetch }` + `export class ChatRoom extends DurableObject`）。
- `compatibility_date = "2026-04-21"`，启用 `nodejs_compat` 非必需（不使用）。
- Durable Object 绑定名：`CHAT_ROOM`；类名：`ChatRoom`；migration `new_sqlite_classes = ["ChatRoom"]`。
- 纯即时，服务端**不做任何持久化存储**（不写 storage、不存历史）。
- 房间名、昵称长度上限 32 字符；单条消息文本上限 2000 字符；超长一律截断。
- 所有服务端广播出去的文本字段（nick、text）在**前端渲染时**用 textContent 而非 innerHTML，杜绝 XSS；服务端负责长度截断与去除首尾空白。
- 消息协议（JSON）：
  - client→server: `{ "type": "chat", "text": string }`
  - server→client: `{ "type": "chat", "nick": string, "text": string, "ts": number }`
  - server→client: `{ "type": "system", "text": string, "ts": number }`
  - server→client: `{ "type": "presence", "count": number }`
- 昵称为空或纯空白 → 回退为 `"访客"`。
- 非法/无法解析的入站消息一律忽略（不抛错、不断开）。

---

### Task 1: 项目脚手架与配置

**Files:**
- Create: `package.json`
- Create: `wrangler.toml`
- Create: `vitest.config.js`
- Create: `src/worker.js`（占位，仅用于让配置可加载）

**Interfaces:**
- Consumes: 无
- Produces: 可运行 `npx vitest run` 的测试环境；`wrangler.toml` 中声明 `CHAT_ROOM` 绑定与 `ChatRoom` migration；`src/worker.js` 导出 `default` 与 `ChatRoom`。

- [ ] **Step 1: 写 `package.json`**

```json
{
  "name": "chatroom",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "test": "vitest run"
  },
  "devDependencies": {
    "@cloudflare/vitest-pool-workers": "^0.9.0",
    "wrangler": "^4.0.0",
    "vitest": "^3.2.0"
  }
}
```

- [ ] **Step 2: 写 `wrangler.toml`**

```toml
name = "chatroom"
main = "src/worker.js"
compatibility_date = "2026-04-21"

[[durable_objects.bindings]]
name = "CHAT_ROOM"
class_name = "ChatRoom"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["ChatRoom"]
```

- [ ] **Step 3: 写 `vitest.config.js`**

```js
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
      },
    },
  },
});
```

- [ ] **Step 4: 写占位 `src/worker.js`**

```js
import { DurableObject } from "cloudflare:workers";

export class ChatRoom extends DurableObject {}

export default {
  async fetch(request, env, ctx) {
    return new Response("ok");
  },
};
```

- [ ] **Step 5: 安装依赖**

Run: `cd /Users/bytedance/chatroom && npm install`
Expected: 依赖安装成功，生成 `node_modules/` 与 `package-lock.json`。

- [ ] **Step 6: 冒烟测试环境可加载**

Run: `npx vitest run` （此时无测试文件，应显示 "No test files found" 且退出码 0，或创建后续任务的测试前先跳过）
Expected: vitest 能启动（无配置错误）。

- [ ] **Step 7: Commit**

```bash
git add package.json wrangler.toml vitest.config.js src/worker.js package-lock.json
git commit -m "chore: 项目脚手架与 Cloudflare 配置

Co-authored-by: TRAE CLI <noreply@bytedance.com>"
```

---

### Task 2: 服务端纯函数——昵称/文本清洗与消息构造

**Files:**
- Create: `src/messages.js`
- Test: `test/messages.test.js`

**Interfaces:**
- Consumes: 无
- Produces:
  - `sanitizeNick(raw: string | null): string` — 去首尾空白，截断到 32 字符；空则返回 `"访客"`。
  - `sanitizeText(raw: unknown): string | null` — 非字符串或去空白后为空返回 `null`；否则去首尾空白并截断到 2000 字符。
  - `parseInbound(raw: string): { text: string } | null` — 解析入站 JSON，仅接受 `{type:"chat", text}` 且 text 经 `sanitizeText` 有效；否则 `null`。
  - `chatMsg(nick, text, ts): string` — 返回 `JSON.stringify({type:"chat",nick,text,ts})`。
  - `systemMsg(text, ts): string` — 返回 `JSON.stringify({type:"system",text,ts})`。
  - `presenceMsg(count): string` — 返回 `JSON.stringify({type:"presence",count})`。

- [ ] **Step 1: 写失败测试 `test/messages.test.js`**

```js
import { describe, it, expect } from "vitest";
import {
  sanitizeNick,
  sanitizeText,
  parseInbound,
  chatMsg,
  systemMsg,
  presenceMsg,
} from "../src/messages.js";

describe("sanitizeNick", () => {
  it("空白回退为访客", () => {
    expect(sanitizeNick("   ")).toBe("访客");
    expect(sanitizeNick(null)).toBe("访客");
  });
  it("去空白并截断到32", () => {
    expect(sanitizeNick("  小明  ")).toBe("小明");
    expect(sanitizeNick("a".repeat(50)).length).toBe(32);
  });
});

describe("sanitizeText", () => {
  it("非字符串或空返回null", () => {
    expect(sanitizeText(123)).toBeNull();
    expect(sanitizeText("   ")).toBeNull();
  });
  it("去空白并截断到2000", () => {
    expect(sanitizeText("  hi ")).toBe("hi");
    expect(sanitizeText("a".repeat(3000)).length).toBe(2000);
  });
});

describe("parseInbound", () => {
  it("合法chat消息", () => {
    expect(parseInbound(JSON.stringify({ type: "chat", text: "hi" }))).toEqual({ text: "hi" });
  });
  it("非法输入返回null", () => {
    expect(parseInbound("not json")).toBeNull();
    expect(parseInbound(JSON.stringify({ type: "chat", text: "  " }))).toBeNull();
    expect(parseInbound(JSON.stringify({ type: "other", text: "hi" }))).toBeNull();
  });
});

describe("builders", () => {
  it("chatMsg", () => {
    expect(JSON.parse(chatMsg("小明", "hi", 5))).toEqual({ type: "chat", nick: "小明", text: "hi", ts: 5 });
  });
  it("systemMsg", () => {
    expect(JSON.parse(systemMsg("x 加入了房间", 6))).toEqual({ type: "system", text: "x 加入了房间", ts: 6 });
  });
  it("presenceMsg", () => {
    expect(JSON.parse(presenceMsg(3))).toEqual({ type: "presence", count: 3 });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/messages.test.js`
Expected: FAIL（找不到 `../src/messages.js` 或导出未定义）。

- [ ] **Step 3: 写实现 `src/messages.js`**

```js
const NICK_MAX = 32;
const TEXT_MAX = 2000;

export function sanitizeNick(raw) {
  const s = (typeof raw === "string" ? raw : "").trim();
  if (!s) return "访客";
  return s.slice(0, NICK_MAX);
}

export function sanitizeText(raw) {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s) return null;
  return s.slice(0, TEXT_MAX);
}

export function parseInbound(raw) {
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!obj || obj.type !== "chat") return null;
  const text = sanitizeText(obj.text);
  if (text === null) return null;
  return { text };
}

export function chatMsg(nick, text, ts) {
  return JSON.stringify({ type: "chat", nick, text, ts });
}

export function systemMsg(text, ts) {
  return JSON.stringify({ type: "system", text, ts });
}

export function presenceMsg(count) {
  return JSON.stringify({ type: "presence", count });
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/messages.test.js`
Expected: PASS（全部通过）。

- [ ] **Step 5: Commit**

```bash
git add src/messages.js test/messages.test.js
git commit -m "feat: 消息清洗与构造纯函数

Co-authored-by: TRAE CLI <noreply@bytedance.com>"
```

---

### Task 3: ChatRoom Durable Object——连接、广播、presence

**Files:**
- Modify: `src/worker.js`（替换占位的 `ChatRoom` 类为完整实现）
- Test: `test/room.test.js`

**Interfaces:**
- Consumes: `src/messages.js` 的 `sanitizeNick`、`parseInbound`、`chatMsg`、`systemMsg`、`presenceMsg`。
- Produces: `ChatRoom` DO，`fetch(request)` 接受 `?nick=` 的 WS 升级请求；`webSocketMessage`/`webSocketClose` 处理广播与离开。DO 的路由入口在 Task 4。

行为约定（供测试断言）：
- 新连接接入：向所有连接（含自己）广播 `system` "「nick」 加入了房间"，再广播 `presence`（count = 当前连接数）。
- 收到合法 chat：向所有连接广播 `chatMsg(nick, text, ts)`，`ts = Date.now()`。
- 连接关闭：广播 `system` "「nick」 离开了房间" 与 `presence`（count = 剩余连接数）。
- 非法入站消息：忽略，无广播。

- [ ] **Step 1: 写失败测试 `test/room.test.js`**

使用 vitest-pool-workers 的 `SELF` 直接对 Worker 发起真实 WS 连接（Task 4 会补齐路由；本任务先写测试，允许在 Task 4 完成后整体转绿——若单独运行本步骤，路由未接通时测试应 FAIL）。

```js
import { env, SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";

function connect(room, nick) {
  const url = `https://example.com/room/${room}?nick=${encodeURIComponent(nick)}`;
  const res = SELF.fetch(url, { headers: { Upgrade: "websocket" } });
  return res;
}

async function openWS(room, nick) {
  const res = await connect(room, nick);
  const ws = res.webSocket;
  ws.accept();
  return ws;
}

function nextMessage(ws) {
  return new Promise((resolve) => {
    ws.addEventListener("message", (e) => resolve(JSON.parse(e.data)), { once: true });
  });
}

describe("ChatRoom", () => {
  it("加入广播 system + presence", async () => {
    const a = await openWS("r1", "小明");
    const msgs = [];
    a.addEventListener("message", (e) => msgs.push(JSON.parse(e.data)));
    await new Promise((r) => setTimeout(r, 100));
    const sys = msgs.find((m) => m.type === "system");
    const pres = msgs.find((m) => m.type === "presence");
    expect(sys.text).toContain("小明");
    expect(sys.text).toContain("加入");
    expect(pres.count).toBe(1);
    a.close();
  });

  it("聊天消息广播给所有人", async () => {
    const a = await openWS("r2", "A");
    const b = await openWS("r2", "B");
    await new Promise((r) => setTimeout(r, 100));
    const got = nextMessage(b).then((m) => m);
    a.send(JSON.stringify({ type: "chat", text: "hello" }));
    // 轮询等待 b 收到 chat
    let received = null;
    for (let i = 0; i < 20 && !received; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    // 简化断言：直接监听
    const chat = await new Promise((resolve) => {
      b.addEventListener("message", (e) => {
        const m = JSON.parse(e.data);
        if (m.type === "chat") resolve(m);
      });
      a.send(JSON.stringify({ type: "chat", text: "hello2" }));
    });
    expect(chat.nick).toBeDefined();
    expect(chat.text).toBeDefined();
    a.close();
    b.close();
  });

  it("非法消息被忽略不崩溃", async () => {
    const a = await openWS("r3", "A");
    a.send("garbage-not-json");
    a.send(JSON.stringify({ type: "chat", text: "   " }));
    await new Promise((r) => setTimeout(r, 100));
    expect(true).toBe(true); // 未抛错即通过
    a.close();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/room.test.js`
Expected: FAIL（路由/DO 未实现，WS 升级失败或无广播）。

- [ ] **Step 3: 实现 `ChatRoom` 类（替换 `src/worker.js` 中占位类）**

```js
import { DurableObject } from "cloudflare:workers";
import { sanitizeNick, parseInbound, chatMsg, systemMsg, presenceMsg } from "./messages.js";

export class ChatRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    // 从 hibernation 恢复：无需额外 sessions map，用 ctx.getWebSockets() 即可
  }

  async fetch(request) {
    const url = new URL(request.url);
    const nick = sanitizeNick(url.searchParams.get("nick"));

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ nick });

    const ts = Date.now();
    this.broadcast(systemMsg(`${nick} 加入了房间`, ts));
    this.broadcast(presenceMsg(this.ctx.getWebSockets().length));

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    if (typeof message !== "string") return;
    const parsed = parseInbound(message);
    if (!parsed) return;
    const att = ws.deserializeAttachment() || {};
    const nick = att.nick || "访客";
    this.broadcast(chatMsg(nick, parsed.text, Date.now()));
  }

  async webSocketClose(ws, code, reason, wasClean) {
    const att = ws.deserializeAttachment() || {};
    const nick = att.nick || "访客";
    try {
      ws.close(code, reason);
    } catch {}
    const ts = Date.now();
    const remaining = this.ctx.getWebSockets().filter((s) => s !== ws).length;
    this.broadcast(systemMsg(`${nick} 离开了房间`, ts));
    this.broadcast(presenceMsg(remaining));
  }

  broadcast(data) {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(data);
      } catch {}
    }
  }
}
```

- [ ] **Step 4: 运行测试（路由未接通时仍可能 FAIL，Task 4 后应 PASS）**

Run: `npx vitest run test/room.test.js`
Expected: 本步骤后若路由未接通仍 FAIL；完成 Task 4 后重跑应 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/worker.js test/room.test.js
git commit -m "feat: ChatRoom Durable Object 广播与 presence

Co-authored-by: TRAE CLI <noreply@bytedance.com>"
```

---

### Task 4: Worker 入口路由（WS → DO / 静态页）

**Files:**
- Modify: `src/worker.js`（替换 `export default` 的 `fetch`）

**Interfaces:**
- Consumes: `ChatRoom` DO 绑定 `env.CHAT_ROOM`。
- Produces: `GET /room/<房间名>` 带 `Upgrade: websocket` → 路由到 `env.CHAT_ROOM.getByName(房间名)` 并转发；其他 `GET` → 返回 HTML 页面（Task 5 填充真实页面，此处先返回占位字符串 `renderPage()`）。

- [ ] **Step 1: 实现路由 `fetch`（替换占位 default）**

```js
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/room\/([^/]+)$/);

    if (match) {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("expected websocket", { status: 426 });
      }
      const roomName = decodeURIComponent(match[1]).slice(0, 32);
      const stub = env.CHAT_ROOM.getByName(roomName);
      return stub.fetch(request);
    }

    return new Response(renderPage(), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  },
};

function renderPage() {
  return "<!doctype html><title>chatroom</title><p>placeholder</p>";
}
```

- [ ] **Step 2: 运行房间测试确认通过**

Run: `npx vitest run test/room.test.js`
Expected: PASS（Task 3 的广播/presence 测试现在应全绿）。

- [ ] **Step 3: 运行全部测试**

Run: `npx vitest run`
Expected: PASS（messages + room 全绿）。

- [ ] **Step 4: Commit**

```bash
git add src/worker.js
git commit -m "feat: Worker 入口路由 WS 到房间 DO

Co-authored-by: TRAE CLI <noreply@bytedance.com>"
```

---

### Task 5: 前端页面（表单 + 聊天界面 + 自动重连）

**Files:**
- Modify: `src/worker.js`（用真实 HTML 替换 `renderPage()` 的返回）

**Interfaces:**
- Consumes: WS 端点 `/room/<房间名>?nick=<昵称>`；消息协议见 Global Constraints。
- Produces: 完整单页应用。渲染所有 nick/text 使用 `textContent`。

- [ ] **Step 1: 用完整页面替换 `renderPage()`**

```js
function renderPage() {
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>聊天室</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, system-ui, sans-serif; height: 100vh; display: flex; flex-direction: column; background: #f5f5f5; }
  #join { margin: auto; padding: 24px; background: #fff; border-radius: 12px; box-shadow: 0 2px 12px rgba(0,0,0,.1); display: flex; flex-direction: column; gap: 12px; width: 280px; }
  #join h1 { font-size: 18px; margin: 0 0 8px; }
  #join input, #composer input { padding: 10px; border: 1px solid #ccc; border-radius: 8px; font-size: 15px; }
  button { padding: 10px 16px; border: 0; border-radius: 8px; background: #2f6feb; color: #fff; font-size: 15px; cursor: pointer; }
  button:hover { background: #2559c9; }
  #chat { display: none; flex-direction: column; height: 100%; }
  header { padding: 12px 16px; background: #fff; border-bottom: 1px solid #eee; display: flex; justify-content: space-between; align-items: center; }
  header .room { font-weight: 600; }
  header .count { color: #888; font-size: 13px; }
  #messages { flex: 1; overflow-y: auto; padding: 12px 16px; }
  .msg { margin: 6px 0; word-break: break-word; }
  .msg .nick { font-weight: 600; margin-right: 6px; }
  .sys { color: #999; font-size: 13px; text-align: center; margin: 8px 0; }
  #composer { display: flex; gap: 8px; padding: 12px 16px; background: #fff; border-top: 1px solid #eee; }
  #composer input { flex: 1; }
  #status { font-size: 12px; color: #c00; padding: 0 16px; }
</style>
</head>
<body>
  <div id="join">
    <h1>进入聊天室</h1>
    <input id="room" placeholder="房间名（即口令）" maxlength="32" autofocus>
    <input id="nick" placeholder="你的昵称" maxlength="32">
    <button id="enter">进入</button>
  </div>
  <div id="chat">
    <header>
      <span class="room" id="roomLabel"></span>
      <span class="count" id="countLabel"></span>
    </header>
    <div id="status"></div>
    <div id="messages"></div>
    <form id="composer">
      <input id="text" placeholder="说点什么…" maxlength="2000" autocomplete="off">
      <button type="submit">发送</button>
    </form>
  </div>
<script>
(function () {
  var room, nick, ws, reconnectDelay = 500, manualClose = false;
  var $ = function (id) { return document.getElementById(id); };

  $("enter").onclick = function () {
    room = $("room").value.trim();
    nick = $("nick").value.trim();
    if (!room) { $("room").focus(); return; }
    $("join").style.display = "none";
    $("chat").style.display = "flex";
    $("roomLabel").textContent = "房间：" + room;
    connect();
  };

  function connect() {
    var proto = location.protocol === "https:" ? "wss:" : "ws:";
    var url = proto + "//" + location.host + "/room/" + encodeURIComponent(room) + "?nick=" + encodeURIComponent(nick);
    ws = new WebSocket(url);
    ws.onopen = function () { reconnectDelay = 500; $("status").textContent = ""; };
    ws.onmessage = function (e) {
      var m;
      try { m = JSON.parse(e.data); } catch (_) { return; }
      if (m.type === "chat") addChat(m.nick, m.text);
      else if (m.type === "system") addSystem(m.text);
      else if (m.type === "presence") $("countLabel").textContent = "在线 " + m.count + " 人";
    };
    ws.onclose = function () {
      if (manualClose) return;
      $("status").textContent = "连接断开，重连中…";
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 8000);
    };
  }

  function addChat(n, t) {
    var div = document.createElement("div");
    div.className = "msg";
    var s = document.createElement("span");
    s.className = "nick";
    s.textContent = n + "：";
    var b = document.createElement("span");
    b.textContent = t;
    div.appendChild(s); div.appendChild(b);
    append(div);
  }
  function addSystem(t) {
    var div = document.createElement("div");
    div.className = "sys";
    div.textContent = t;
    append(div);
  }
  function append(el) {
    var box = $("messages");
    box.appendChild(el);
    box.scrollTop = box.scrollHeight;
  }

  $("composer").onsubmit = function (e) {
    e.preventDefault();
    var t = $("text").value.trim();
    if (!t || !ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify({ type: "chat", text: t }));
    $("text").value = "";
  };
})();
</script>
</body>
</html>`;
}
```

- [ ] **Step 2: 运行全部测试确认未回归**

Run: `npx vitest run`
Expected: PASS（页面改动不影响 WS/消息逻辑测试）。

- [ ] **Step 3: 本地冒烟（手动）**

Run: `npx wrangler dev`
在浏览器开两个窗口访问本地地址，进同一房间名与不同昵称，验证：加入/离开系统提示、在线人数、消息实时互通、超长消息被截断、断开后自动重连。

- [ ] **Step 4: Commit**

```bash
git add src/worker.js
git commit -m "feat: 前端聊天页面与自动重连

Co-authored-by: TRAE CLI <noreply@bytedance.com>"
```

---

### Task 6: README 与部署说明

**Files:**
- Create: `README.md`

**Interfaces:**
- Consumes: 无
- Produces: 本地运行、测试、部署到 Cloudflare 的完整步骤文档。

- [ ] **Step 1: 写 `README.md`**

```markdown
# 即时聊天室

免登录、房间名即口令的即时纯文字聊天室。纯即时不存历史。部署在 Cloudflare Workers + Durable Objects。

## 本地运行

    npm install
    npm run dev

浏览器打开 wrangler 提示的本地地址，填房间名 + 昵称即可聊天。开多个窗口用同一房间名测试。

## 测试

    npm test

## 部署（免费）

1. 安装并登录：`npx wrangler login`
2. 一键部署：`npm run deploy`
3. 部署完成后得到 `https://chatroom.<你的子域>.workers.dev`，把地址发给朋友即可。

Workers 与 Durable Objects 的免费额度足够自己人小范围使用。

## 用法

- 房间名就是口令：知道房间名的人填入即可进入同一房间。
- 昵称留空会显示为「访客」。
- 关闭页面即离开，其他人会看到离开提示与实时在线人数。
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: README 与部署说明

Co-authored-by: TRAE CLI <noreply@bytedance.com>"
```

---

## Self-Review

**Spec coverage：**
- 纯文字 → Task 2/3/5 消息协议仅 text。✓
- 不存历史 → Global Constraints 明确 DO 不做持久化；Task 3 无 storage 写入。✓
- 房间名即口令 → Task 4 `getByName(roomName)`。✓
- 进房前填昵称 → Task 5 表单；Task 3 从 `?nick=` 读取。✓
- 顶部房间名 + 在线人数 → Task 5 header + presence。✓
- 加入/离开系统消息 → Task 3 systemMsg。✓
- 断线自动重连 → Task 5 指数退避。✓
- 长度限制与转义 → Task 2 截断 + Task 5 textContent 渲染。✓
- Cloudflare 部署 → Task 1 wrangler.toml + Task 6 部署说明。✓
- 单测覆盖广播/presence/校验/截断 → Task 2/3。✓

**Placeholder scan：** Task 1/4 的占位实现均在后续任务被真实实现替换，无遗留 TODO。✓

**Type consistency：** `messages.js` 导出的函数名在 Task 3 引用一致（`sanitizeNick`/`parseInbound`/`chatMsg`/`systemMsg`/`presenceMsg`）；DO 绑定名 `CHAT_ROOM`、类名 `ChatRoom` 全程一致。✓
