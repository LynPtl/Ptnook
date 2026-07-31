# 上次阅读位置分隔线 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户重新进房或切回窗口时,在第一条未读消息前显示"以上是新消息"分隔线并自动定位,纯前端(localStorage),不动服务端。

**Architecture:** 判定逻辑抽成纯函数 `firstUnreadIndex(items, lastReadTs)` 放 `src/messages.js` 做单测;因为前端是无构建的内联脚本(不能 import 模块),同一逻辑在 `renderPage()` 的浏览器脚本里镜像一份(极小函数,故意的重复,注释标明)。前端用 localStorage 按房间记"上次读到的最后一条 ts",窗口 blur / beforeunload / 离开时更新,进房与 focus 时插入分隔线并滚动定位。

**Tech Stack:** JavaScript (ES modules) + Cloudflare Workers 内联 HTML;Vitest。零第三方依赖,零构建。

## Global Constraints

- 现有文件:`src/worker.js`(ChatRoom DO + default 路由 + 内联 `renderPage()` HTML)、`src/messages.js`(纯函数)、`test/messages.test.js`、`test/room.test.js`。当前 20 个测试通过。
- localStorage key:`ptnook:lastread:<房间名>`,value 为数字 ts(该房间上次读到的最后一条消息 ts)。
- 判定纯函数:`firstUnreadIndex(items, lastReadTs)` — `items` 是按显示顺序的 `[{ts}]`;返回第一条 `ts > lastReadTs` 的索引;`lastReadTs` 为 falsy(null/undefined/0)或无更新消息时返回 `-1`(不插线);等于 `lastReadTs` 的消息算已读(不算新)。
- 分隔线文案:`—— 以上是新消息 ——`,纯静态,用 `textContent`。
- 方案 A:分隔线插入后稳定保留,不随普通新消息移动;仅在"进房 / 窗口 focus"时重算,重算前先移除已有分隔线(同一时刻最多一条)。
- "已读位置"以**窗口 blur** 为准更新;另在离开房间(点「离开」)和 `beforeunload` 时补存;当前无消息则不写。
- 进房渲染历史后:有分隔线则滚到分隔线,否则滚到底。focus 时:有分隔线则滚到分隔线。
- localStorage 不可用(隐私模式)时静默降级,不报错、不影响聊天。
- XSS 不变:所有 nick/text 与分隔线文案均 `textContent`,唯一允许的 innerHTML 是清空 `#messages` 的空字符串字面量。
- 不动服务端、不加依赖、不改部署。commit message **不得**含 `Co-authored-by: TRAE CLI` 或任何 TRAE 署名(自动 `Change-Id:` 行允许)。

---

### Task 1: firstUnreadIndex 纯函数 + 单测

**Files:**
- Modify: `src/messages.js`(末尾新增导出函数)
- Test: `test/messages.test.js`(新增 describe 块;import 加 `firstUnreadIndex`)

**Interfaces:**
- Consumes: 无
- Produces: `firstUnreadIndex(items, lastReadTs): number` — 见 Global Constraints 语义。

- [ ] **Step 1: 写失败测试(追加到 `test/messages.test.js`)**

在文件顶部 import 追加 `firstUnreadIndex`(现有:`import { sanitizeNick, sanitizeText, parseInbound, chatMsg, systemMsg, presenceMsg, historyMsg } from "../src/messages.js";` → 末尾加 `, firstUnreadIndex`)。追加:

```js
describe("firstUnreadIndex", () => {
  const items = [{ ts: 10 }, { ts: 20 }, { ts: 30 }];
  it("返回第一条晚于 lastRead 的索引", () => {
    expect(firstUnreadIndex(items, 15)).toBe(1);
    expect(firstUnreadIndex(items, 20)).toBe(2); // 等于算已读
  });
  it("全部已读返回 -1", () => {
    expect(firstUnreadIndex(items, 30)).toBe(-1);
    expect(firstUnreadIndex(items, 99)).toBe(-1);
  });
  it("lastRead 为空返回 -1", () => {
    expect(firstUnreadIndex(items, null)).toBe(-1);
    expect(firstUnreadIndex(items, undefined)).toBe(-1);
    expect(firstUnreadIndex(items, 0)).toBe(-1);
  });
  it("空列表返回 -1", () => {
    expect(firstUnreadIndex([], 5)).toBe(-1);
  });
  it("全部都新则返回 0", () => {
    expect(firstUnreadIndex(items, 5)).toBe(0);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/messages.test.js`
Expected: FAIL(`firstUnreadIndex is not a function`)。

- [ ] **Step 3: 实现(追加到 `src/messages.js` 末尾)**

```js
export function firstUnreadIndex(items, lastReadTs) {
  if (!lastReadTs) return -1;
  for (let i = 0; i < items.length; i++) {
    if (items[i].ts > lastReadTs) return i;
  }
  return -1;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/messages.test.js`
Expected: PASS(原有 + 新增全部通过)。

- [ ] **Step 5: Commit**

```bash
git add src/messages.js test/messages.test.js
git commit -m "feat: firstUnreadIndex 未读分界纯函数"
```

---

### Task 2: 前端分隔线(localStorage + blur/focus + 插入/滚动)

**Files:**
- Modify: `src/worker.js`(仅 `renderPage()` 返回的 HTML 字符串:新增 CSS `.divider`、`addChat` 打 data-ts、新增 localStorage 与分隔线逻辑、绑定 blur/focus/beforeunload、改 history 渲染后的滚动、`enter`/`leave` 接入)

**Interfaces:**
- Consumes: 无(浏览器脚本内镜像一份 `firstUnreadIndex`,与 Task 1 逻辑相同)。
- Produces: 完整前端行为。

- [ ] **Step 1: 新增 `.divider` 样式**

在 `<style>` 中 `.sys { ... }` 之后新增一行:
```css
  .divider { color: #e0533d; font-size: 12px; text-align: center; margin: 12px 0; border-top: 1px solid #f0c9c2; padding-top: 6px; }
```

- [ ] **Step 2: `addChat` 给消息元素打上 data-ts**

在 `addChat` 里给最外层 `div`(`div.className = "msg";` 那个)紧随其后加一行,记录时间戳供后续扫描:
```js
    div.className = "msg";
    div.dataset.ts = ts;
```
(其余 addChat 逻辑不变。)

- [ ] **Step 3: 在浏览器脚本顶部(IIFE 内、`teardown` 附近)新增工具函数**

在 `var $ = ...;` 之后、`teardown` 之前插入:
```js
  // 与 src/messages.js 的 firstUnreadIndex 保持一致（浏览器内联脚本无法 import，故镜像一份）
  function firstUnreadIndex(items, lastReadTs) {
    if (!lastReadTs) return -1;
    for (var i = 0; i < items.length; i++) {
      if (items[i].ts > lastReadTs) return i;
    }
    return -1;
  }
  function lsKey() { return "ptnook:lastread:" + room; }
  function lsGet() {
    try { var v = localStorage.getItem(lsKey()); return v ? Number(v) : null; } catch (_) { return null; }
  }
  function lsSet(ts) {
    try { if (ts) localStorage.setItem(lsKey(), String(ts)); } catch (_) {}
  }
  function msgEls() {
    return Array.prototype.slice.call($("messages").querySelectorAll(".msg"));
  }
  function lastMsgTs() {
    var els = msgEls();
    if (!els.length) return null;
    return Number(els[els.length - 1].dataset.ts);
  }
  function markRead() {
    var ts = lastMsgTs();
    if (ts) lsSet(ts);
  }
  // 移除旧分隔线，按 lastReadTs 在第一条未读前插入新分隔线；返回是否插入
  function showDivider(lastReadTs) {
    var old = $("messages").querySelector(".divider");
    if (old) old.parentNode.removeChild(old);
    var els = msgEls();
    var items = els.map(function (el) { return { ts: Number(el.dataset.ts) }; });
    var idx = firstUnreadIndex(items, lastReadTs);
    if (idx < 0) return false;
    var div = document.createElement("div");
    div.className = "divider";
    div.textContent = "—— 以上是新消息 ——";
    els[idx].parentNode.insertBefore(div, els[idx]);
    div.scrollIntoView({ block: "center" });
    return true;
  }
```

- [ ] **Step 4: history 渲染后改为"有分隔线滚到线,否则滚到底"**

把 `connect()` 内 onmessage 的 history 分支:
```js
      else if (m.type === "history") {
        $("messages").innerHTML = "";
        (m.items || []).forEach(function (it) { addChat(it.nick, it.text, it.ts); });
        scrollToBottom();
      }
```
改为:
```js
      else if (m.type === "history") {
        $("messages").innerHTML = "";
        (m.items || []).forEach(function (it) { addChat(it.nick, it.text, it.ts); });
        if (!showDivider(lsGet())) scrollToBottom();
      }
```

- [ ] **Step 5: 绑定窗口 blur/focus 与 beforeunload;leave 时补存**

在 IIFE 末尾(现有 `$("text").addEventListener("keydown", ...)` 之后)新增:
```js
  window.addEventListener("blur", function () {
    if (room) markRead();
  });
  window.addEventListener("focus", function () {
    if (room) showDivider(lsGet());
  });
  window.addEventListener("beforeunload", function () {
    if (room) markRead();
  });
```
并在 `$("leave").onclick` 里,`teardown();` 之前加一行补存已读:
```js
  $("leave").onclick = function () {
    manualClose = true;
    markRead();
    teardown();
    $("chat").style.display = "none";
    $("join").style.display = "flex";
    $("messages").innerHTML = "";
  };
```
说明:进房(`enter`/history 渲染)读取的是**上一次**存下的 lastRead,不在进房时立即 markRead,以保证方案 A 的分隔线基于历史值。blur 时更新 lastRead 为当前最后一条;focus 时以该值插线——正好标出离开期间到达的消息。

- [ ] **Step 6: 运行全部测试确认未回归**

Run: `npx vitest run`
Expected: PASS(服务端 20 + Task1 新增;前端改动不影响服务端测试)。

- [ ] **Step 7: 静态校验前端 hook(沙箱无法交互浏览器)**

Run(逐个确认非空):
```bash
grep -n 'ptnook:lastread' src/worker.js
grep -n 'function showDivider' src/worker.js
grep -n 'dataset.ts' src/worker.js
grep -n '以上是新消息' src/worker.js
grep -n 'addEventListener("blur"' src/worker.js
grep -n 'addEventListener("focus"' src/worker.js
grep -n 'if (!showDivider(lsGet())) scrollToBottom' src/worker.js
```
Expected: 每条有匹配。交互式浏览器冒烟 **NOT RUN(沙箱)**,如实记录。

- [ ] **Step 8: 本地冒烟(手动,用户执行)**

Run: `npx wrangler dev`
两个窗口进同一房间:A 发几条 → 切走 B 的窗口(失焦)→ A 再发几条 → 切回 B,应在离开期间第一条新消息前看到"—— 以上是新消息 ——"并自动定位到那里;全部已读时不显示分隔线;关页面再进,分隔线基于上次离开位置。隐私模式下功能失效但不报错。

- [ ] **Step 9: Commit**

```bash
git add src/worker.js
git commit -m "feat: 上次阅读位置分隔线（localStorage，失焦为准）"
```

---

### Task 3: 更新 README

**Files:**
- Modify: `README.md`(用法一节追加一条)

**Interfaces:**
- Consumes: 无
- Produces: 说明新特性。

- [ ] **Step 1: 在 `README.md` 的「用法」小节末尾追加**

```markdown
- 切走窗口再切回（或重新进房）时，会在第一条未读消息前显示「以上是新消息」分隔线并自动定位（记录在本浏览器本地，按房间区分）。
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: README 补充未读分隔线特性"
```

---

## Self-Review

**Spec coverage:**
- localStorage 按房间记 lastread → Task 2 `lsKey/lsGet/lsSet`。✓
- 失焦为准更新 + beforeunload/leave 补存 → Task 2 Step 5。✓
- 进房/focus 插分隔线 + 滚动定位 → Task 2 Step 3/4/5(`showDivider`)。✓
- 方案 A 稳定保留、重算前移除旧线、最多一条 → `showDivider` 先移除再插。✓
- 判定纯函数 firstUnreadIndex + 语义(> 比较、等于算已读、空返回 -1)→ Task 1。✓
- 50 条上限自然兜底 → 无需额外处理(注释/spec 已述)。✓
- XSS textContent、localStorage 降级 → Task 2 try/catch + textContent。✓
- 不动服务端、零依赖、不带 TRAE 署名 → 全程遵守。✓
- README → Task 3。✓

**Placeholder scan:** 无 TODO/TBD;每个代码步骤含完整代码。✓

**Type consistency:** `firstUnreadIndex(items, lastReadTs)` 在 Task 1(messages.js)与 Task 2(浏览器镜像)签名/语义一致;`items` 均为 `[{ts}]`;localStorage key `ptnook:lastread:<room>` 前后一致;`showDivider` 返回布尔用于决定滚动,调用处一致。✓

**重复说明:** `firstUnreadIndex` 在 messages.js(测试)与浏览器脚本(运行)各一份,是无构建内联脚本的必要镜像,已加注释标明,函数体极小、漂移风险低。✓
