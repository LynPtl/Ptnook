# 图片消息（粘贴上传 + 房间级自动删除）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 输入框粘贴图片 → 传到自建 K-Vault 图床 → 聊天里显示；房间无人 30 分钟后图片随历史一起删除。

**Architecture:** Worker 代理上传/读取（Token 不出服务端），房间 DO 用 `img:<id>` 逐键记账，存在两个删除触发点：消息被 50 条窗口淘汰时精确删除、`alarm()` 房间空闲 30 分钟时兜底删除。渲染只放行本域 `/img/<id>`。

**Tech Stack:** Cloudflare Workers + Durable Objects（SQLite 存储）、原生 ES module、Vitest + `@cloudflare/vitest-pool-workers`。零依赖、零构建。

**Spec:** `docs/superpowers/specs/2026-11-17-image-paste-design.md`

## Global Constraints

- 零第三方依赖、无构建步骤；`package.json` 的 `dependencies` 必须保持为空。
- 所有用户可见文案用中文；注释用中文，风格与现有 `src/worker.js` 一致。
- DO 存储单 value 上限 128 KiB；`history` 是一条 value，图片字节绝不可进 DO 存储。
- 只渲染本域 `/img/<id>`；其它 `![]()` 保持文字（隐私不变量）。
- 上传：2 MiB 上限、类型白名单 `image/png|jpeg|webp|gif|avif`、每房间 20 次/分钟、账本 200 张。
- 前端压缩：最长边 1600px、WebP q=0.82；>2 MiB 时 q=0.6 重试一次；GIF 不压缩。
- 环境变量 `KVAULT_BASE` / `KVAULT_TOKEN` 只以 secret 形式存在；`wrangler.toml` 不得新增 `[vars]`，仓库中不得出现真实图床地址。
- 提交用 eval 的 `commit` 命名空间（`d = await commit.draft()` → `await d.commit(...)`），不要 `git add`/`git commit`。

## Review Focus

1. 粘贴**非图片**内容（纯文本、HTML、文件路径）必须完全走浏览器默认行为，不能被拦截或吞掉。（Task 5 Step 5 手动验证）
2. 4K 截图压缩后仍超 2 MiB 时，必须给出可读中文提示（`#status`），不能静默失败。（Task 5 Step 5 手动验证）
3. 房间名超过 32 字符时，上传记账用的 DO 名字必须与 `/room/` 路由一致（都截断到 32），否则图片永远删不掉。
4. 伪造的 `![](/img/<别人的id>)` 文本不得删除本房间账本以外的图片；只有账本内的 id 才可删。
5. 图床删除返回 404（已被删）算成功；返回 5xx/抛错要保留账本并重试，最多 2 轮后放弃，不能无限重试。

---

### Task 1: 图床客户端模块 `src/images.js`

**Files:**
- Create: `src/images.js`
- Test: `test/images.test.js`

**Interfaces:**
- Consumes: 无（纯模块，`fetchImpl` 可注入）。
- Produces:
  - `ALLOWED_IMAGE_TYPES: Set<string>`
  - `isAllowedImageType(type: string): boolean`
  - `extractImageIds(text: string): string[]`（从消息文本抽出 `/img/<id>` 并 `decodeURIComponent`）
  - `createImageClient(env: {KVAULT_BASE?: string, KVAULT_TOKEN?: string}, fetchImpl?: typeof fetch): {enabled: boolean, upload(bytes: ArrayBuffer, type: string): Promise<{id: string, url: string}>, remove(id: string): Promise<boolean>, fetchFile(id: string): Promise<Response|null>}`

- [ ] **Step 1: 写失败测试**

```js
// test/images.test.js
import { describe, it, expect } from "vitest";
import { createImageClient, extractImageIds, isAllowedImageType } from "../src/images.js";

const ENV = { KVAULT_BASE: "https://kv.test/", KVAULT_TOKEN: "tok" };

function fakeFetch(reply) {
  const calls = [];
  const f = async (url, init) => { calls.push({ url: String(url), init }); return reply(url, init); };
  f.calls = calls;
  return f;
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("isAllowedImageType", () => {
  it("只放行白名单图片类型，拒绝 svg 与文本", () => {
    expect(isAllowedImageType("image/webp")).toBe(true);
    expect(isAllowedImageType("IMAGE/PNG")).toBe(true);
    expect(isAllowedImageType("image/svg+xml")).toBe(false);
    expect(isAllowedImageType("text/html")).toBe(false);
  });
});

describe("extractImageIds", () => {
  it("抽出并解码本域图片 id", () => {
    expect(extractImageIds("看 ![](/img/img%3Aabc) 和 ![](/img/r2%3Ax)")).toEqual(["img:abc", "r2:x"]);
  });
  it("忽略外部图片与畸形转义", () => {
    expect(extractImageIds("![](https://e/x.png)")).toEqual([]);
    expect(extractImageIds("![](/img/%E0%A4%A)")).toEqual([]);
  });
});

describe("createImageClient", () => {
  it("缺任一环境变量时 enabled=false 且 upload 拒绝", async () => {
    const c = createImageClient({});
    expect(c.enabled).toBe(false);
    await expect(c.upload(new ArrayBuffer(1), "image/webp")).rejects.toThrow(/未配置/);
  });

  it("upload 拼对地址、带 Bearer、multipart 含 folderPath=chat", async () => {
    const f = fakeFetch(() => json({ success: true, file: { id: "img:abc" } }));
    const c = createImageClient(ENV, f);
    const r = await c.upload(new Uint8Array([1, 2, 3]).buffer, "image/webp");
    expect(r).toEqual({ id: "img:abc", url: "/img/img%3Aabc" });
    const call = f.calls[0];
    expect(call.url).toBe("https://kv.test/api/v1/upload");
    expect(call.init.headers.Authorization).toBe("Bearer tok");
    expect(call.init.body.get("folderPath")).toBe("chat");
    expect(call.init.body.get("file").name).toBe("image.webp");
  });

  it("upload 把上游错误映射成可读异常", async () => {
    const c1 = createImageClient(ENV, fakeFetch(() => json({ success: false, error: { message: "POLICY_DENIED" } }, 403)));
    await expect(c1.upload(new ArrayBuffer(1), "image/png")).rejects.toThrow("POLICY_DENIED");
    const c2 = createImageClient(ENV, fakeFetch(() => new Response("boom", { status: 500 })));
    await expect(c2.upload(new ArrayBuffer(1), "image/png")).rejects.toThrow(/500/);
  });

  it("remove：200 与 404 都算成功，5xx 失败", async () => {
    const mk = (status) => createImageClient(ENV, fakeFetch(() => new Response(null, { status })));
    expect(await mk(200).remove("img:abc")).toBe(true);
    expect(await mk(404).remove("img:abc")).toBe(true);
    expect(await mk(500).remove("img:abc")).toBe(false);
  });

  it("fetchFile 网络异常返回 null", async () => {
    const c = createImageClient(ENV, async () => { throw new Error("offline"); });
    expect(await c.fetchFile("img:abc")).toBe(null);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/images.test.js`
Expected: FAIL — `Failed to resolve import "../src/images.js"`.

- [ ] **Step 3: 实现 `src/images.js`**

要点（签名与测试已定，剩余是实现细节）：
- `normalizeBase(raw)`：去尾部 `/` 后拼 `/`，`new URL("api/v1/upload", base)`。
- `upload`：`FormData` 追加 `file`（`new File([bytes], "image." + ext, { type })`）与 `folderPath="chat"`；`Authorization: "Bearer " + token`；`content-type` 交给运行时自动生成（不要手写）。
- 扩展名映射：`image/png→png`、`image/jpeg→jpg`、`image/webp→webp`、`image/gif→gif`、`image/avif→avif`。
- 成功判定：`res.ok && data.success && data.file.id`；否则抛 `Error(上游 error.message || "图床上传失败 " + res.status)`。
- `remove`：`DELETE api/v1/file/<encodeURIComponent(id)>`，`res.ok || res.status === 404` 为真；`fetch` 抛错吞掉返回 `false`。
- `fetchFile`：`GET file/<encodeURIComponent(id)>`，异常返回 `null`。
- `extractImageIds`：全局匹配 `/!\[[^\]\n]{0,100}\]\(\/img\/([A-Za-z0-9_.%~-]{1,512})\)/g`，对捕获组 `decodeURIComponent`，解码失败跳过。
- 未配置时 `upload` 抛 `Error("图床未配置")`，`remove` 返回 `false`，`fetchFile` 返回 `null`。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/images.test.js`
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

`feat: 新增图床客户端模块（上传/删除/读取 + 环境变量配置）`

---

### Task 2: Markdown 只渲染本域图片

**Files:**
- Modify: `public/markdown.js`（`renderInline` 内，删除线之后、自动链接之前）
- Test: `test/markdown.test.js`

**Interfaces:**
- Consumes: Task 1 的 `extractImageIds` 共用同一字符类（不 import，保持渲染器零依赖）。
- Produces: `<img src="/img/<id>" alt="" loading="lazy" referrerpolicy="no-referrer">`。

- [ ] **Step 1: 写失败测试**

```js
it("只渲染本域 /img/ 图片", () => {
  expect(renderMd("![](/img/img%3Aabc)")).toBe(
    '<p><img src="/img/img%3Aabc" alt="" loading="lazy" referrerpolicy="no-referrer"></p>'
  );
  expect(renderMd("看图 ![](/img/r2-ab_c.png) 很好")).toBe(
    '<p>看图 <img src="/img/r2-ab_c.png" alt="" loading="lazy" referrerpolicy="no-referrer"> 很好</p>'
  );
});

it("外部图片与非法协议仍按文字显示", () => {
  const ext = renderMd("![](https://e/x.png)");
  expect(ext).not.toContain("<img");
  expect(ext).toContain("![](");
  const js = renderMd("![](javascript:alert(1))");
  expect(js).not.toContain("<img");
  expect(js).not.toContain("<a");
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/markdown.test.js`
Expected: 新增用例 FAIL（输出无 `<img`）。

- [ ] **Step 3: 实现**

在 `renderInline` 中 `s = s.replace(/~~.../g, ...)` 之后、自动链接 `s.replace(/(https?:\/\/...)/` 之前插入：

```js
s = s.replace(/!\[([^\]\n]{0,100})\]\((\/img\/[A-Za-z0-9_.%~-]{1,512})\)/g, (m, alt, src) =>
  '<img src="' + src + '" alt="' + alt + '" loading="lazy" referrerpolicy="no-referrer">'
);
```

同时把文件头的白名单说明与 `docs/superpowers/specs/2026-11-06-markdown-render-design.md` 里“图片不解析”的旧结论标注为已被本设计取代（一行注释即可，不要重写旧文档）。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/markdown.test.js`
Expected: 全部 PASS（含原有 300+ 断言）。

- [ ] **Step 5: 提交**

`feat: markdown 渲染本域 /img/ 图片，外部图片仍按文字`

---

### Task 3: DO 图片账本与两个删除触发点

**Files:**
- Modify: `src/worker.js`（`ChatRoom`：构造函数、`appendHistory`、`alarm`，新增 `trackImage`、`pruneDroppedImages`）
- Test: `test/room.test.js`

**Interfaces:**
- Consumes: `createImageClient`、`extractImageIds`（`src/images.js`）。
- Produces:
  - `ChatRoom#trackImage(id: string): Promise<{ok: true} | {ok: false, reason: "rate"|"full"}>`
  - `ChatRoom#pruneDroppedImages(items: {text: string}[]): Promise<void>`
  - 存储键 `img:<id>`（值 = 时间戳）、`imgRate`（`{start, n}`）、`imgAttempts`（number）
  - 实例字段 `this.imageClient`（测试可替换）

- [ ] **Step 1: 写失败测试**

在 `test/room.test.js` 追加（沿用文件头部已有的 `runInDurableObject` 用法）：

```js
it("trackImage 记账、限流与容量上限", async () => {
  const id = env.CHAT_ROOM.idFromName("img-ledger");
  const stub = env.CHAT_ROOM.get(id);
  await runInDurableObject(stub, async (instance, state) => {
    expect(await instance.trackImage("img:1")).toEqual({ ok: true });
    expect(await state.storage.get("img:img:1")).toBeTypeOf("number");
    for (let i = 2; i <= 20; i++) await instance.trackImage("img:" + i);
    expect(await instance.trackImage("img:21")).toEqual({ ok: false, reason: "rate" });
  });
});

it("alarm 只删账本内的图，失败保留并重试，404 视为成功", async () => {
  const id = env.CHAT_ROOM.idFromName("img-purge");
  const stub = env.CHAT_ROOM.get(id);
  await runInDurableObject(stub, async (instance, state) => {
    const removed = [];
    instance.imageClient = { remove: async (x) => { removed.push(x); return x !== "img:bad"; } };
    await instance.trackImage("img:ok");
    await instance.trackImage("img:bad");
    await instance.alarm();
    expect(removed).toEqual(["img:ok", "img:bad"]);
    expect(await state.storage.get("img:ok")).toBeUndefined();
    expect(await state.storage.get("img:bad")).toBeTypeOf("number");
    expect(await state.storage.getAlarm()).toBeTypeOf("number");
  });
});

it("消息淘汰时只删本房间账本里的图，伪造 id 不删", async () => {
  const id = env.CHAT_ROOM.idFromName("img-prune");
  const stub = env.CHAT_ROOM.get(id);
  await runInDurableObject(stub, async (instance, state) => {
    const removed = [];
    instance.imageClient = { remove: async (x) => { removed.push(x); return true; } };
    await instance.trackImage("img:mine");
    await instance.pruneDroppedImages([
      { text: "![](/img/img%3Amine)" },
      { text: "![](/img/img%3Aforged)" },
    ]);
    expect(removed).toEqual(["img:mine"]);
    expect(await state.storage.get("img:img:forged")).toBeUndefined();
  });
});

it("房间名超 32 字符时，淘汰判定用截断后的房间身份", async () => {
  const long = "r".repeat(40);
  const stub = env.CHAT_ROOM.getByName(long.slice(0, 32));
  await runInDurableObject(stub, async (instance, state) => {
    await instance.trackImage("img:x");
    expect(await state.storage.get("img:img:x")).toBeTypeOf("number");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/room.test.js`
Expected: FAIL — `instance.trackImage is not a function`。

- [ ] **Step 3: 实现**

- 构造函数：`this.imageClient = createImageClient(env);`
- `trackImage(id)`：
  - `imgRate` 60 秒滑窗，`n >= 20` 返回 `{ok:false, reason:"rate"}`。
  - `const list = await storage.list({ prefix: "img:", limit: 201 })`，`list.size >= 200` 返回 `{ok:false, reason:"full"}`。
  - `storage.put({ ["img:" + id]: Date.now(), imgRate: rate })`。
- `pruneDroppedImages(items)`：`extractImageIds` 汇总 → 逐个 `storage.get("img:" + id)` 判账本 → 命中的 `storage.delete` 后再 `imageClient.remove(id)`（失败忽略）。
- `appendHistory`：`splice` 出来的 `dropped` 非空时 `this.ctx.waitUntil(this.pruneDroppedImages(dropped))`。
- `alarm()`：开头加 `if (this.ctx.getWebSockets().length !== 0) return;`，然后：
  - `storage.list({ prefix: "img:" })` 得到 id 集合；逐个 `imageClient.remove`。
  - 失败集合非空且 `imgAttempts < 2` → `put({imgAttempts: n+1})`、`setAlarm(now + 5*60*1000)`、**保留** 失败键；否则删除所有 `img:*` 与 `imgAttempts`。
  - 之后维持现有 `history`/`ddz`/`holdem` 清理。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/room.test.js`
Expected: 全部 PASS（含原有斗地主/德州/历史用例）。

- [ ] **Step 5: 提交**

`feat: 房间 DO 记账图片并在空闲/淘汰时删除`

---

### Task 4: `/upload` 与 `/img/<id>` 路由

**Files:**
- Modify: `src/worker.js`（`export default { fetch }`）
- Test: `test/room.test.js`
- Modify: `vitest.config.js`（测试用图床绑定）

**Interfaces:**
- Consumes: Task 1 的 `createImageClient`/`isAllowedImageType`；Task 3 的 `trackImage`。
- Produces: `POST /upload?room=<name>` → `{url: "/img/<encodeURIComponent(id)>"}`；`GET /img/<id>` → 图片字节。

- [ ] **Step 1: 配置测试绑定**

`vitest.config.js` 增加：

```js
miniflare: { bindings: { KVAULT_BASE: "https://kvault.test", KVAULT_TOKEN: "test-token" } },
```

- [ ] **Step 2: 写失败测试**

```js
import { fetchMock } from "cloudflare:test";

it("上传：非同源 403、非图片 415、超限 413", async () => {
  const post = (headers, body) => SELF.fetch("https://example.com/upload?room=r", { method: "POST", headers, body });
  expect((await post({ "Content-Type": "image/webp" }, new Uint8Array([1]))).status).toBe(403);
  expect((await post({ Origin: "https://evil.com", "Content-Type": "image/webp" }, new Uint8Array([1]))).status).toBe(403);
  expect((await post({ Origin: "https://example.com", "Content-Type": "text/plain" }, "hi")).status).toBe(415);
  expect((await post({ Origin: "https://example.com", "Content-Type": "image/webp" }, new Uint8Array(2 * 1024 * 1024 + 1))).status).toBe(413);
});

it("图床上传失败映射为 502", async () => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
  fetchMock.get("https://kvault.test")
    .intercept({ path: "/api/v1/upload", method: "POST" })
    .reply(500, "boom");
  const res = await SELF.fetch("https://example.com/upload?room=img-502", {
    method: "POST",
    headers: { Origin: "https://example.com", "Content-Type": "image/webp" },
    body: new Uint8Array([1]),
  });
  expect(res.status).toBe(502);
});

it("上传成功返回 /img/ 地址并记账", async () => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
  fetchMock.get("https://kvault.test")
    .intercept({ path: "/api/v1/upload", method: "POST" })
    .reply(200, JSON.stringify({ success: true, file: { id: "img:abc" } }), { headers: { "Content-Type": "application/json" } });
  const res = await SELF.fetch("https://example.com/upload?room=img-route", {
    method: "POST",
    headers: { Origin: "https://example.com", "Content-Type": "image/webp" },
    body: new Uint8Array([1, 2, 3]),
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ url: "/img/img%3Aabc" });
  const stub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName("img-route"));
  await runInDurableObject(stub, async (instance, state) => {
    expect(await state.storage.get("img:img:abc")).toBeTypeOf("number");
  });
});

it("读取代理只放行 image/*，并带缓存头", async () => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
  fetchMock.get("https://kvault.test")
    .intercept({ path: "/file/img%3Aabc", method: "GET" })
    .reply(200, "BYTES", { headers: { "Content-Type": "image/webp" } });
  const ok = await SELF.fetch("https://example.com/img/img%3Aabc");
  expect(ok.status).toBe(200);
  expect(ok.headers.get("Content-Type")).toBe("image/webp");
  expect(ok.headers.get("Cache-Control")).toContain("max-age=1800");

  fetchMock.get("https://kvault.test")
    .intercept({ path: "/file/img%3Ahtml", method: "GET" })
    .reply(200, "<html>", { headers: { "Content-Type": "text/html" } });
  expect((await SELF.fetch("https://example.com/img/img%3Ahtml")).status).toBe(404);
});
```

- [ ] **Step 3: 运行确认失败**

Run: `npx vitest run test/room.test.js`
Expected: 新增用例 FAIL（404，路由未实现）。

- [ ] **Step 4: 实现 `handleUpload` / `handleImage`**

- `fetch` 里在 `/room/` 匹配**之前**加：
  - `url.pathname === "/upload" && request.method === "POST"` → `handleUpload`
  - `const m = url.pathname.match(/^\/img\/(.+)$/)`（非 `/room/` 时）→ `handleImage`
- `handleUpload`：
  - `room` 缺失 → 400；`room.slice(0, 32)`（与 `/room/` 一致）。
  - `Origin` 缺失或 host 不等 → 403。
  - `createImageClient(env)`，`!enabled` → 503 `{error:"图床未配置"}`。
  - 类型白名单 → 415；`Content-Length > 2MiB` 或 `arrayBuffer().byteLength > 2MiB` → 413。
  - `client.upload(bytes, type)` **包 try/catch**，异常 → 502 `{error: err.message}`。
  - 成功后 `env.CHAT_ROOM.getByName(room).trackImage(id)`；`!ok` → `ctx.waitUntil(client.remove(id))` + 429 `{error:"上传太频繁或图片过多"}`。
  - 成功 `{url: "/img/" + encodeURIComponent(id)}`。
- `handleImage`：GET only（否则 405）；`decodeURIComponent` 失败或长度 >512 → 404；`client.fetchFile(id)`；`!res.ok` 或 `Content-Type` 不以 `image/` 开头 → 404；成功透传 `Content-Type` + `Cache-Control: public, max-age=1800` + `X-Content-Type-Options: nosniff`。
- 所有错误响应 `Content-Type: application/json; charset=utf-8`。
- 测试文件里用 `afterEach(() => { fetchMock.assertNoPendingInterceptors(); })`，避免拦截器泄漏到下一个用例。

- [ ] **Step 5: 运行确认通过**

Run: `npx vitest run test/room.test.js`
Expected: 全部 PASS。

- [ ] **Step 6: 提交**

`feat: 新增 /upload 与 /img 代理路由`

---

### Task 5: 前端粘贴上传

**Files:**
- Modify: `src/worker.js`（`renderPage` 签名、CSS、内嵌脚本）
- Test: `test/room.test.js`

**Interfaces:**
- Consumes: `POST /upload` 契约（Task 4）。
- Produces: 页面内 `var imagesEnabled = <bool>;`；粘贴后插入 `![](/img/<id>)`。

- [ ] **Step 1: 写失败测试**

```js
it("页面按环境变量注入 imagesEnabled，并注册粘贴上传", async () => {
  const html = await (await SELF.fetch("https://example.com/")).text();
  expect(html).toContain("var imagesEnabled = true;");
  expect(html).toContain('addEventListener("paste"');
  expect(html).toContain("图片上传中…");
  expect(html).toMatch(/\.msg \.body img\s*\{/);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/room.test.js`
Expected: FAIL — 页面无 `imagesEnabled`。

- [ ] **Step 3: 实现**

- `export default { fetch }` 里改为 `renderPage(Boolean(env.KVAULT_BASE && env.KVAULT_TOKEN))`，`function renderPage(imagesEnabled)`，模板中 `var imagesEnabled = ${imagesEnabled ? "true" : "false"};`。
- 内嵌脚本新增（放在 `sendMessage` 附近）：
  - `compressImage(file, quality)` → Promise<Blob>：GIF 原样返回；`createImageBitmap` 失败时回退 `Image`+`URL.createObjectURL`；最长边缩到 1600px；`canvas.toBlob(..., "image/webp", quality)`。
  - `sendPastedImage(file)`：q=0.82 → 超 2 MiB 再 q=0.6 → 仍超则 `$("status").textContent = "图片太大（压缩后仍超过 2 MB）"`；上传期间置 `uploading=true` 让 `sendMessage` 直接返回；失败显示 `err.message`。
  - `insertAtCursor(text)`：按 `selectionStart/End` 插入并回填光标。
  - `$("text").addEventListener("paste", ...)`：`imagesEnabled` 为假直接 return；命中 `kind === "file" && type.startsWith("image/")` 时 `preventDefault()`。
- CSS：`.msg .body img { max-width: 100%; max-height: 360px; border-radius: 8px; display: block; margin: 4px 0; }`。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/room.test.js`
Expected: 全部 PASS。

- [ ] **Step 5: 实际页面验证**

Run: `npx wrangler dev`（`.dev.vars` 写入 `KVAULT_BASE`/`KVAULT_TOKEN` 的**假值**）
浏览器打开 → 进房 → 先粘贴一段纯文本，确认原样进入输入框（没被拦截）→ 再粘贴一张截图，观察 `#status` 依次出现“图片上传中…”与图床报错文案（假 Token 必然失败），确认压缩与请求链路被真实触发、页面不崩。

- [ ] **Step 6: 提交**

`feat: 输入框支持粘贴图片上传`

---

### Task 6: 文档与全量回归

**Files:**
- Modify: `README.md`（图片消息章节 + 环境变量说明 + 修正“不加载外部图片”一句）
- Modify: `CHANGELOG.md`

- [ ] **Step 1: 更新 README**

新增一节“可选：图片消息”，写明：需自建 K-Vault；`wrangler secret put KVAULT_BASE` / `KVAULT_TOKEN`；Token 只要 `upload`+`delete` 且限 `folderPath=chat`；2 MiB / 20 次每分钟 / 200 张上限；房间无人 30 分钟后图片一并删除。把原来“不加载外部图片”一句改为“只加载本房间托管的图片，不加载外部图片”。

- [ ] **Step 2: 更新 CHANGELOG**

按现有格式加一条：图片粘贴上传 + 房间级自动清理 + `/upload`、`/img` 路由 + 图床环境变量。

- [ ] **Step 3: 全量测试**

Run: `npm test`
Expected: 全部 PASS，无新增警告。

- [ ] **Step 4: 检查仓库无个人信息**

Run: `rg -n "k-vault|pages\.dev" wrangler.toml src public README.md CHANGELOG.md`
Expected: 无输出（`docs/` 下也不得出现真实域名）。

- [ ] **Step 5: 提交**

`docs: 补充图片消息说明与变更记录`

---

## 执行方式

Task 1→2 相互独立，可与 3 并行；Task 4 依赖 1、3；Task 5 依赖 4；Task 6 依赖全部。按顺序做最省心，任务间接口已在上方 `Interfaces` 锁定。
