# 聊天体验优化(第一梯队)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Ptnook 聊天室加上房间历史缓存(最近50条,进房推送,空房30分钟清除)、消息时间戳、多行输入与滚动优化,不改技术栈、不加依赖、不破坏现有 12/12 测试与 XSS 安全。

**Architecture:** 服务端在每个 ChatRoom Durable Object 的 `ctx.storage`(SQLite)里维护滚动 50 条 chat 历史,新连接建立后先单独收到 `history` 消息再收到加入广播;房间空置时用 DO Alarm 在 30 分钟后清除历史。前端在内嵌 HTML 里渲染时间戳、改用 textarea 多行输入(Enter 发送/Shift+Enter 换行)、并实现"进房到底/贴底才自动滚"的滚动逻辑。

**Tech Stack:** JavaScript (ES modules)、Cloudflare Workers、Durable Objects(SQLite 后端,Hibernation API,Alarm)、Wrangler、Vitest + `@cloudflare/vitest-pool-workers`。零第三方依赖。

## Global Constraints

- 现有文件:`src/worker.js`(ChatRoom DO + default 路由 + 内嵌 `renderPage()` HTML)、`src/messages.js`(纯函数)、`test/messages.test.js`、`test/room.test.js`。
- 历史上限 **50 条**,只存 chat(system/presence 不入历史),每房间独立(存各自 DO 的 `ctx.storage`)。
- 空房阈值 **30 分钟**(`30 * 60 * 1000` ms)。
- 新消息协议:`{ "type": "history", "items": [{ "nick", "text", "ts" }, ...] }`,**仅发给刚建连的那个连接**,不广播。现有 `chat`/`system`/`presence` 不变。
- 推送顺序:新连接先收到 `history`,再收到 "加入了房间" 的 system 广播。
- XSS:所有服务端提供的 nick/text 一律经 `textContent` 渲染;唯一允许的 innerHTML 是清空 `#messages` 用空字符串字面量。多行文本用 CSS `white-space: pre-wrap` 保留换行,不用 innerHTML。
- 多行输入:`<textarea id="text">`,**Enter 发送**、**Shift+Enter 换行**,`maxlength` 2000 保留。
- 滚动:贴底判断 `scrollTop + clientHeight >= scrollHeight - 40`;进房渲染完历史强制到底;收新消息仅在"渲染前已贴底"时才滚到底。
- 时间戳格式 `HH:MM`(本地时区,补零),仅 chat 显示,system 不显示。
- 不做:左右气泡、本地即时回显(optimistic echo)、Markdown、登录、永久全量历史。
- Commit message **不得**包含 `Co-authored-by: TRAE CLI` 或任何 TRAE 署名(本地 git 钩子会自动加 `Change-Id`,那是允许的)。

---

### Task 1: messages.js 新增 historyMsg 构造函数

**Files:**
- Modify: `src/messages.js`(在末尾新增一个导出函数)
- Test: `test/messages.test.js`(新增 describe 块)

**Interfaces:**
- Consumes: 无
- Produces: `historyMsg(items: Array<{nick,text,ts}>): string` — 返回 `JSON.stringify({ type: "history", items })`。

- [ ] **Step 1: 写失败测试(追加到 `test/messages.test.js` 末尾)**

先在文件顶部的 import 里加入 `historyMsg`(现有行:`import { sanitizeNick, sanitizeText, parseInbound, chatMsg, systemMsg, presenceMsg } from "../src/messages.js";` → 末尾加 `, historyMsg`)。然后追加:

```js
describe("historyMsg", () => {
  it("构造 history 消息", () => {
    const items = [{ nick: "小明", text: "hi", ts: 5 }];
    expect(JSON.parse(historyMsg(items))).toEqual({ type: "history", items });
  });
  it("空历史 items 为空数组", () => {
    expect(JSON.parse(historyMsg([]))).toEqual({ type: "history", items: [] });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/messages.test.js`
Expected: FAIL(`historyMsg` is not a function / 未导出)。

- [ ] **Step 3: 实现(追加到 `src/messages.js` 末尾)**

```js
export function historyMsg(items) {
  return JSON.stringify({ type: "history", items });
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/messages.test.js`
Expected: PASS(原有 + 新增全部通过)。

- [ ] **Step 5: Commit**

```bash
git add src/messages.js test/messages.test.js
git commit -m "feat: 新增 historyMsg 消息构造函数"
```

---

### Task 2: ChatRoom 历史缓存(写入 + 进房推送)

**Files:**
- Modify: `src/worker.js`(ChatRoom 类:`fetch`、`webSocketMessage`,新增 `appendHistory`,import 加 `historyMsg`)
- Test: `test/room.test.js`(新增历史相关用例 + 一个可复用的 collect helper)

**Interfaces:**
- Consumes: `src/messages.js` 的 `historyMsg`(Task 1),以及现有 `sanitizeNick`/`parseInbound`/`chatMsg`/`systemMsg`/`presenceMsg`。
- Produces: 每个 ChatRoom 在 `ctx.storage` key `"history"` 下维护 `Array<{nick,text,ts}>`(≤50);新连接建连后立即收到 `historyMsg(history)`。`appendHistory(item)` 供内部使用。

行为约定(供测试):
- 新连接先收到 `{type:"history", items:[...]}`,再收到 system "加入了房间"。
- 每条合法 chat 广播的同时追加 `{nick,text,ts}` 到 history,超过 50 条丢弃最旧。
- 空房首次进入时 history items 为 `[]`。

- [ ] **Step 1: 写失败测试(追加到 `test/room.test.js`)**

在文件已有 helper 附近新增一个立即挂监听的 collect helper(放在现有 `openWS` 之后):

```js
async function openWSCollect(room, nick) {
  const url = `https://example.com/room/${room}?nick=${encodeURIComponent(nick)}`;
  const res = await SELF.fetch(url, { headers: { Upgrade: "websocket" } });
  const ws = res.webSocket;
  const msgs = [];
  ws.addEventListener("message", (e) => { msgs.push(JSON.parse(e.data)); });
  ws.accept();
  return { ws, msgs };
}
```

然后新增用例:

```js
describe("ChatRoom 历史", () => {
  it("新连接先收到 history 再收到加入 system", async () => {
    const { ws, msgs } = await openWSCollect("hist-order", "A");
    await new Promise((r) => setTimeout(r, 150));
    const historyIdx = msgs.findIndex((m) => m.type === "history");
    const joinIdx = msgs.findIndex((m) => m.type === "system");
    expect(historyIdx).toBeGreaterThanOrEqual(0);
    expect(joinIdx).toBeGreaterThan(historyIdx);
    expect(Array.isArray(msgs[historyIdx].items)).toBe(true);
    ws.close();
  });

  it("后进者能在 history 中看到先前的消息", async () => {
    const a = await openWS("hist-see", "A");
    await new Promise((r) => setTimeout(r, 100));
    a.send(JSON.stringify({ type: "chat", text: "old-msg" }));
    await new Promise((r) => setTimeout(r, 150));
    const { ws: b, msgs } = await openWSCollect("hist-see", "B");
    await new Promise((r) => setTimeout(r, 150));
    const hist = msgs.find((m) => m.type === "history");
    expect(hist).toBeDefined();
    expect(hist.items.some((it) => it.text === "old-msg" && it.nick === "A")).toBe(true);
    a.close();
    b.close();
  });

  it("history 上限 50 条且保留最新", async () => {
    const a = await openWS("hist-cap", "A");
    await new Promise((r) => setTimeout(r, 100));
    for (let i = 0; i < 55; i++) {
      a.send(JSON.stringify({ type: "chat", text: "msg-" + i }));
      await new Promise((r) => setTimeout(r, 15));
    }
    await new Promise((r) => setTimeout(r, 150));
    const { ws: b, msgs } = await openWSCollect("hist-cap", "B");
    await new Promise((r) => setTimeout(r, 200));
    const hist = msgs.find((m) => m.type === "history");
    expect(hist.items.length).toBe(50);
    expect(hist.items[49].text).toBe("msg-54");
    expect(hist.items[0].text).toBe("msg-5");
    a.close();
    b.close();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/room.test.js`
Expected: FAIL(新连接收不到 history / items 不含旧消息)。

- [ ] **Step 3: 修改 ChatRoom 类**

在 `src/worker.js` 顶部 import 追加 `historyMsg`:
```js
import { sanitizeNick, parseInbound, chatMsg, systemMsg, presenceMsg, historyMsg } from "./messages.js";
```

把 `fetch` 中"建立连接后"的部分改为(在 `server.serializeAttachment({ nick });` 之后、原 join 广播之前插入历史推送):
```js
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ nick });

    // 先给新连接单独推送历史，再广播加入
    const history = (await this.ctx.storage.get("history")) || [];
    server.send(historyMsg(history));

    const ts = Date.now();
    this.broadcast(systemMsg(`${nick} 加入了房间`, ts));
    this.broadcast(presenceMsg(this.ctx.getWebSockets().length));

    return new Response(null, { status: 101, webSocket: client });
```

把 `webSocketMessage` 改为在广播后追加历史:
```js
  async webSocketMessage(ws, message) {
    if (typeof message !== "string") return;
    const parsed = parseInbound(message);
    if (!parsed) return;
    const att = ws.deserializeAttachment() || {};
    const nick = att.nick || "访客";
    const ts = Date.now();
    this.broadcast(chatMsg(nick, parsed.text, ts));
    await this.appendHistory({ nick, text: parsed.text, ts });
  }
```

在 `broadcast` 方法之前新增:
```js
  async appendHistory(item) {
    const history = (await this.ctx.storage.get("history")) || [];
    history.push(item);
    if (history.length > 50) history.splice(0, history.length - 50);
    await this.ctx.storage.put("history", history);
  }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run`
Expected: PASS(messages + room 全绿,含新历史用例)。

- [ ] **Step 5: Commit**

```bash
git add src/worker.js test/room.test.js
git commit -m "feat: 房间历史缓存与进房推送"
```

---

### Task 3: 空房 30 分钟清除历史(DO Alarm)

**Files:**
- Modify: `src/worker.js`(ChatRoom 类:`fetch` 加 deleteAlarm、`webSocketClose` 加 setAlarm、新增 `alarm()`)
- Test: `test/room.test.js`(新增 alarm 用例;import 增加 `runInDurableObject`)

**Interfaces:**
- Consumes: 已有 ChatRoom(Task 2)。
- Produces: 房间空(`remaining === 0`)时 `ctx.storage.setAlarm(now + 30min)`;有人建连时 `ctx.storage.deleteAlarm()`;`alarm()` 触发时二次确认无连接则 `ctx.storage.deleteAll()`。

- [ ] **Step 1: 写失败测试(追加到 `test/room.test.js`)**

修改文件顶部 import(现有 `import { env, SELF } from "cloudflare:test";`)为:
```js
import { env, SELF, runInDurableObject } from "cloudflare:test";
```
新增用例:
```js
describe("ChatRoom 空房清除", () => {
  it("alarm 在空房时清除历史", async () => {
    const id = env.CHAT_ROOM.idFromName("alarm-empty");
    const stub = env.CHAT_ROOM.get(id);
    await runInDurableObject(stub, async (instance, state) => {
      await state.storage.put("history", [{ nick: "A", text: "x", ts: 1 }]);
      await instance.alarm();
      expect(await state.storage.get("history")).toBeUndefined();
    });
  });

  it("alarm 在有人在线时保留历史", async () => {
    const { ws } = await openWSCollect("alarm-busy", "A");
    await new Promise((r) => setTimeout(r, 120));
    const id = env.CHAT_ROOM.idFromName("alarm-busy");
    const stub = env.CHAT_ROOM.get(id);
    await runInDurableObject(stub, async (instance, state) => {
      await state.storage.put("history", [{ nick: "A", text: "keep", ts: 1 }]);
      await instance.alarm();
      const h = await state.storage.get("history");
      expect(h).toBeDefined();
      expect(h.length).toBe(1);
    });
    ws.close();
  });

  it("空房后设清除闹钟，重新进入则取消", async () => {
    const { ws } = await openWSCollect("alarm-set", "A");
    await new Promise((r) => setTimeout(r, 120));
    ws.close();
    await new Promise((r) => setTimeout(r, 200));
    const id = env.CHAT_ROOM.idFromName("alarm-set");
    const stub = env.CHAT_ROOM.get(id);
    let scheduled;
    await runInDurableObject(stub, async (instance, state) => {
      scheduled = await state.storage.getAlarm();
    });
    expect(scheduled).not.toBeNull();

    const { ws: ws2 } = await openWSCollect("alarm-set", "B");
    await new Promise((r) => setTimeout(r, 120));
    await runInDurableObject(stub, async (instance, state) => {
      expect(await state.storage.getAlarm()).toBeNull();
    });
    ws2.close();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/room.test.js`
Expected: FAIL(`instance.alarm is not a function` / getAlarm 为 null)。

- [ ] **Step 3: 修改 ChatRoom 类**

在 `fetch` 里,`server.serializeAttachment({ nick });` 之后、历史推送之前(或紧邻)加入取消闹钟:
```js
    // 有人进来：取消待定的空房清除闹钟
    await this.ctx.storage.deleteAlarm();
```

在 `webSocketClose` 里,广播 presence 之后追加:
```js
    if (remaining === 0) {
      await this.ctx.storage.setAlarm(Date.now() + 30 * 60 * 1000);
    }
```
(即该方法结尾变为先 `this.broadcast(presenceMsg(remaining));` 再上面这段。)

在 `webSocketError` 之后、`appendHistory` 之前新增 `alarm()`:
```js
  async alarm() {
    if (this.ctx.getWebSockets().length === 0) {
      await this.ctx.storage.deleteAll();
    }
  }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run`
Expected: PASS(全部,含 alarm 用例)。

- [ ] **Step 5: Commit**

```bash
git add src/worker.js test/room.test.js
git commit -m "feat: 空房 30 分钟清除历史"
```

---

### Task 4: 前端时间戳 / 多行输入 / 滚动 / history 渲染

**Files:**
- Modify: `src/worker.js`(仅 `renderPage()` 返回的 HTML 字符串)

**Interfaces:**
- Consumes: 消息协议(含新 `history`)。
- Produces: 完整前端页面。所有 nick/text 经 `textContent`;多行 pre-wrap;时间 `HH:MM`;滚动按 Global Constraints。

- [ ] **Step 1: 用新版本替换 `renderPage()` 的返回值**

将 `src/worker.js` 中 `renderPage()` 函数整体替换为:

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
  #join input, #composer textarea { padding: 10px; border: 1px solid #ccc; border-radius: 8px; font-size: 15px; }
  button { padding: 10px 16px; border: 0; border-radius: 8px; background: #2f6feb; color: #fff; font-size: 15px; cursor: pointer; }
  button:hover { background: #2559c9; }
  #chat { display: none; flex-direction: column; height: 100%; }
  header { padding: 12px 16px; background: #fff; border-bottom: 1px solid #eee; display: flex; justify-content: space-between; align-items: center; }
  header .room { font-weight: 600; }
  header .count { color: #888; font-size: 13px; }
  #messages { flex: 1; overflow-y: auto; padding: 12px 16px; }
  .msg { margin: 6px 0; word-break: break-word; }
  .msg .nick { font-weight: 600; margin-right: 6px; }
  .msg .time { color: #bbb; font-size: 12px; margin-right: 6px; }
  .msg .body { white-space: pre-wrap; }
  .sys { color: #999; font-size: 13px; text-align: center; margin: 8px 0; }
  #composer { display: flex; gap: 8px; padding: 12px 16px; background: #fff; border-top: 1px solid #eee; align-items: flex-end; }
  #composer textarea { flex: 1; resize: none; height: 40px; max-height: 120px; line-height: 20px; font-family: inherit; }
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
      <button id="leave">离开</button>
    </header>
    <div id="status"></div>
    <div id="messages"></div>
    <form id="composer">
      <textarea id="text" placeholder="说点什么…（Enter 发送，Shift+Enter 换行）" maxlength="2000" rows="1"></textarea>
      <button type="submit">发送</button>
    </form>
  </div>
<script>
(function () {
  var room, nick, ws, reconnectDelay = 500, manualClose = false;
  var $ = function (id) { return document.getElementById(id); };

  function atBottom() {
    var box = $("messages");
    return box.scrollTop + box.clientHeight >= box.scrollHeight - 40;
  }
  function scrollToBottom() {
    var box = $("messages");
    box.scrollTop = box.scrollHeight;
  }
  function fmtTime(ts) {
    var d = new Date(ts);
    var h = ("0" + d.getHours()).slice(-2);
    var m = ("0" + d.getMinutes()).slice(-2);
    return h + ":" + m;
  }

  $("enter").onclick = function () {
    room = $("room").value.trim();
    nick = $("nick").value.trim();
    if (!room) { $("room").focus(); return; }
    manualClose = false;
    $("join").style.display = "none";
    $("chat").style.display = "flex";
    $("roomLabel").textContent = "房间：" + room;
    connect();
  };

  $("leave").onclick = function () {
    manualClose = true;
    if (ws) ws.close();
    $("chat").style.display = "none";
    $("join").style.display = "flex";
    $("messages").innerHTML = "";
  };

  function connect() {
    var proto = location.protocol === "https:" ? "wss:" : "ws:";
    var url = proto + "//" + location.host + "/room/" + encodeURIComponent(room) + "?nick=" + encodeURIComponent(nick);
    ws = new WebSocket(url);
    ws.onopen = function () { reconnectDelay = 500; $("status").textContent = ""; };
    ws.onmessage = function (e) {
      var m;
      try { m = JSON.parse(e.data); } catch (_) { return; }
      if (m.type === "chat") addChat(m.nick, m.text, m.ts);
      else if (m.type === "system") addSystem(m.text);
      else if (m.type === "presence") $("countLabel").textContent = "在线 " + m.count + " 人";
      else if (m.type === "history") {
        (m.items || []).forEach(function (it) { addChat(it.nick, it.text, it.ts); });
        scrollToBottom();
      }
    };
    ws.onclose = function () {
      if (manualClose) return;
      $("status").textContent = "连接断开，重连中…";
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 8000);
    };
  }

  function addChat(n, t, ts) {
    var wasBottom = atBottom();
    var div = document.createElement("div");
    div.className = "msg";
    var s = document.createElement("span");
    s.className = "nick";
    s.textContent = n + "：";
    var tm = document.createElement("span");
    tm.className = "time";
    tm.textContent = fmtTime(ts);
    var b = document.createElement("span");
    b.className = "body";
    b.textContent = t;
    div.appendChild(s); div.appendChild(tm); div.appendChild(b);
    $("messages").appendChild(div);
    if (wasBottom) scrollToBottom();
  }
  function addSystem(t) {
    var wasBottom = atBottom();
    var div = document.createElement("div");
    div.className = "sys";
    div.textContent = t;
    $("messages").appendChild(div);
    if (wasBottom) scrollToBottom();
  }

  function sendMessage() {
    var t = $("text").value.trim();
    if (!t || !ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify({ type: "chat", text: t }));
    $("text").value = "";
  }

  $("composer").onsubmit = function (e) {
    e.preventDefault();
    sendMessage();
  };
  $("text").addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
})();
</script>
</body>
</html>`;
}
```

- [ ] **Step 2: 运行全部测试确认未回归**

Run: `npx vitest run`
Expected: PASS(12 + 新增用例;页面改动不影响服务端逻辑测试)。

- [ ] **Step 3: 静态校验前端关键 hook(沙箱无法交互浏览器)**

Run(逐个 grep 确认存在,输出非空):
```bash
grep -n 'id="text"' src/worker.js            # textarea 存在
grep -n 'textarea' src/worker.js             # 已从 input 改为 textarea
grep -n 'white-space: pre-wrap' src/worker.js
grep -n 'fmtTime' src/worker.js              # 时间格式化
grep -n 'type === "history"' src/worker.js   # history 渲染分支
grep -n 'atBottom' src/worker.js             # 贴底判断
grep -n 'e.key === "Enter" && !e.shiftKey' src/worker.js  # Enter 发送
```
Expected: 每条都有匹配行。交互式浏览器冒烟 **NOT RUN(沙箱)**,如实记录;并在报告中列出静态确认的 hook。

- [ ] **Step 4: 本地冒烟(手动,由用户执行)**

Run: `npx wrangler dev`
浏览器两个窗口进同一房间:验证时间戳显示、Shift+Enter 换行且 Enter 发送、多行消息换行保留、进房自动到底、翻看历史时来新消息不被强制拉下、离开再进历史仍在(30 分钟内)。

- [ ] **Step 5: Commit**

```bash
git add src/worker.js
git commit -m "feat: 时间戳、多行输入与滚动优化前端"
```

---

### Task 5: 更新 README

**Files:**
- Modify: `README.md`(用法一节补充新特性)

**Interfaces:**
- Consumes: 无
- Produces: 反映新特性的用法说明。

- [ ] **Step 1: 在 `README.md` 的「用法」小节末尾追加**

```markdown
- 进房会看到该房间最近 50 条消息（每个房间独立，纯即时滚动，不做永久历史）。
- 消息显示发送时间（时:分）。
- 输入框支持多行：Enter 发送，Shift+Enter 换行。
- 房间在无人 30 分钟后自动清除这 50 条缓存，避免同名房间被后来者看到旧消息。
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: README 补充新体验特性"
```

---

## Self-Review

**Spec coverage:**
- 历史缓存 50 条 / 每房间独立 / 存 ctx.storage → Task 2。✓
- history 消息类型 + 先历史后加入顺序 → Task 1(构造)+ Task 2(推送顺序)。✓
- 写入裁剪 50 → Task 2 `appendHistory`。✓
- 空房 30 分钟 alarm 清除 + 进房取消 + 二次确认 → Task 3。✓
- 时间戳 HH:MM 仅 chat → Task 4 `fmtTime`/`addChat`,system 不加。✓
- 多行 textarea + Enter/Shift+Enter + pre-wrap → Task 4。✓
- 滚动:进房到底 / 贴底才自动滚 → Task 4 `atBottom`/history 分支强制 `scrollToBottom`。✓
- XSS textContent 不变 → Task 4 全部 textContent,仅清空用空串。✓
- 零依赖、不改部署 → 无新增依赖。✓
- README → Task 5。✓
- 测试:history 顺序/内容/上限、alarm 清除/保留/设置取消 → Task 2、3。✓

**Placeholder scan:** 无 TODO/TBD;每个代码步骤含完整代码。✓

**Type consistency:** `historyMsg(items)` 在 Task 1 定义、Task 2 import 使用一致;history 项结构 `{nick,text,ts}` 在 Task 2 写入、Task 4 `addChat(it.nick,it.text,it.ts)` 一致;`appendHistory`/`alarm`/`atBottom`/`fmtTime`/`sendMessage` 命名前后一致。✓

**Commit 署名:** 所有 commit message 均无 TRAE 署名(遵守 Global Constraints)。✓
