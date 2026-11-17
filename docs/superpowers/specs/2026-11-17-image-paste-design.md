# 聊天图片（粘贴上传 + 房间级自动删除）— 设计文档

日期：2026-11-17
项目：Ptnook 聊天室（Cloudflare Workers + Durable Objects，`src/worker.js` 单文件含 ChatRoom DO + 内嵌前端，零依赖零构建）
外部依赖：部署方自建的 K-Vault 图床（Telegram 后端）。**地址与 Token 一律由环境变量注入，仓库内不出现任何个人部署信息**——本项目开源，任何人 clone 后填自己的即可。

## 目标

在聊天输入框里**粘贴图片即可发送**。图片上传到用户自己的 K-Vault，聊天里显示缩略图。
图片**不长期占用图床**：房间无人 30 分钟后，随聊天历史一起被删除。

## 非目标

- 拖拽上传、文件选择器、图片画廊、多图九宫格（只做剪贴板粘贴，一次一张）。
- 图片级独立 TTL、定时清理任务（沿用现有"房间无人 30 分钟"这一个生命周期）。
- 服务端转码 / 缩略图生成（压缩在前端做）。
- 编辑或删除已发送的图片消息。

## 反向目标

- 绝不把 K-Vault 的 Token 下发到浏览器。
- 绝不把图片字节写进 Durable Object 存储（单个 value 上限 128 KiB，`history` 是一条 value）。
- 绝不渲染非本域图片——保持 README 里"不加载外部图片（避免泄露 IP）"的承诺。
- 绝不删除不在本房间账本里的 file id（防伪造消息触发跨房间误删）。

## 约束（已查证）

1. **K-Vault 没有文件级 TTL。** `expires_in` 只写 `metadata.shareExpiresAt`，到期是分享链接 410
   `FILE_LINK_EXPIRED`（`functions/file/[id].js:254`），Telegram 文件与 KV 记录都保留。删除必须由我们驱动。
2. **删除接口是 `DELETE /api/v1/file/:id`**，scope `delete`；内部对 Telegram 调 `deleteMessage`，
   **只在消息发出后 48 小时内有效**。本方案 30 分钟的窗口天然安全。
3. **CORS 未开放。** `/api/v1/upload` 预检返回 204 但没有 `Access-Control-Allow-Origin`
   （`API_CORS_ORIGINS` 未配）。浏览器不能直连，正好由 Worker 代理，Token 不出服务端。
4. **部署方当前只有 telegram 后端**（`/api/v1/capabilities` → `storages:["telegram"]`，上限 100 MB）。
5. **K-Vault 对 ≤25 MB、90 天内的相同内容做 SHA-256 去重**，会返回同一个 file id（见"风险"）。

## 方案选择

| 方案 | 结论 |
|---|---|
| A. Worker 代理上传/读取 + 房间闹钟删除 | **采用**。Token 不落地浏览器、不动 CORS、删除时机与现有语义一致 |
| B. 浏览器直连 K-Vault 上传 | 否决：需要放开 CORS 并把 Token 嵌进页面，等于公开图床 |
| C. 不进图床，图片直接塞消息/DO 存储 | 否决：`history` 是单条 value（128 KiB），WS 帧也不适合，且无法保留大图 |

方案 A 内部还定了两件事：读取经 `GET /img/:id` 代理（保持单一来源、可加缓存头、隐藏图床域名），
上传口只做**同源校验 + 每房间频率上限 + 2 MiB 上限**（不引入额外口令）。

## 设计

### 1. 路由（`src/worker.js` 的 default fetch）

| 路由 | 行为 |
|---|---|
| `POST /upload?room=<name>` | 校验 `Origin` 与请求同源、`Content-Type` 白名单、体积 ≤2 MiB → 以 `Bearer $KVAULT_TOKEN` 转发到 K-Vault `/api/v1/upload`（multipart：`file`、`folderPath=chat`）→ 拿 `file.id` → 调房间 DO 的 `trackImage(id)` 记账 → 返回 `{url:"/img/"+id}` |
| `GET /img/<id>` | 代理 `GET ${KVAULT_BASE}/file/<id>`；只放行 `image/*` 响应；成功加 `Cache-Control: public, max-age=1800` |

错误码：`400` 缺 room｜`403` 非同源｜`413` 超 2 MiB｜`415` 非白名单图片类型｜
`429` 房间上传过频或账本已满｜`502` 图床上传失败｜`503` 未配置 Token。

上传类型白名单：`image/png`、`image/jpeg`、`image/webp`、`image/gif`、`image/avif`。
**拒绝 SVG**（可内嵌脚本），也拒绝一切非 `image/*`。

`trackImage` 拒绝时（限流/满），立即对刚上传的 id 发一次 best-effort 删除再返回 429，避免孤儿。

### 2. Durable Object 账本

新增两个存储键（与 `history`/`ddz`/`holdem` 同级）：

- `imgs`：本房间当前存活的 K-Vault file id 数组，上限 200。
- `imgRate`：`{start, n}`，60 秒窗口内最多 20 次上传。

`trackImage(id)`：滑窗限流 → 查上限 → push → 落盘。返回 `{ok:true}` 或 `{ok:false, reason}`。

**删除有两个触发点，都只删账本里有的 id：**

1. `alarm()`（房间无人 30 分钟）：逐条 `DELETE /api/v1/file/:id`；有失败则保留失败项并
   `setAlarm(now + 5min)` 重试，最多 2 轮；随后清 `imgs`，再走现有的
   `history`/`ddz`/`holdem` 清理。
2. `appendHistory` 淘汰旧消息时：从被丢弃消息的文本里抽出 `/img/<id>`，
   **与该房间 `imgs` 求交集**后删除并移出账本。放在 `ctx.waitUntil` 里，不阻塞聊天写入。

第 2 条让"图片寿命 = 消息寿命"精确成立；第 1 条是兜底（崩溃、上传后立刻散场、消息还没被淘汰）。

### 3. 图片客户端（新模块 `src/images.js`）

纯逻辑抽成模块，便于单测（与 `ddz.js`/`holdem.js` 同一分层）：

```js
createImageClient(env, fetchImpl = fetch)   // -> { upload(bytes, type), remove(id), fetchFile(id) }
extractImageIds(text)                        // 从消息文本抽 /img/<id>
isAllowedImageType(type)
```

`fetchImpl` 可注入，测试用假实现，不依赖全局 fetch mock。
DO 构造时创建一份 `this.imageClient`；测试可在 `runInDurableObject` 里替换。

### 4. 前端

- `#text` 上监听 `paste`：命中 `clipboardData.items` 里的 `image/*` 时 `preventDefault()`，
  取 `getAsFile()` 压缩后上传。
- 服务端渲染页面时注入 `imagesEnabled`（`KVAULT_BASE` 与 `KVAULT_TOKEN` 都存在才为 `true`）；
  为 `false` 时不注册粘贴处理，粘贴回退为浏览器默认行为，不发任何请求。
- 压缩：`createImageBitmap` → canvas → 最长边 1600px、WebP q=0.82；仍 >2 MiB 则 q=0.6 再试一次，
  还超就拒绝并提示。GIF 不压缩（会丢动画），≤2 MiB 直接传。
- 上传期间 `#status` 显示"图片上传中…"，`sendMessage` 暂时不发。
- 成功后把 `![](/img/<id>)` **插入光标处**（不自动发送，允许先加一句说明）。
- 样式：`.msg .body img { max-width:100%; max-height:360px; border-radius:8px; display:block; }`

### 5. Markdown 渲染（`public/markdown.js`）

在行内代码占位、强调、删除线之后，自动链接之前，加一条**只认本域路径**的图片规则：

```
/!\[([^\]\n]{0,100})\]\((\/img\/[A-Za-z0-9_.%~-]{1,512})\)/g
```

- 输出 `<img src="..." alt="..." loading="lazy" referrerpolicy="no-referrer">`。
- `alt` 来自已转义文本，`src` 受字符类限制，均无注入面；仍然不引入属性级用户输入。
- `![](https://外部)` 保持原样文字——顺带挡住追踪像素。
- 白名单标签全集增加 `img`（属性只有常量 `src/alt/loading/referrerpolicy`）。

### 6. 配置（全部走环境变量，仓库零个人信息）

| 变量 | 形式 | 必填 | 说明 |
|---|---|---|---|
| `KVAULT_BASE` | secret（本地 `.dev.vars`） | 否 | 图床根地址，例如 `https://<你的地址>`。**用 secret 而不是 `[vars]`**，否则域名会跟着 `wrangler.toml` 提交进开源仓库 |
| `KVAULT_TOKEN` | secret | 否 | 形如 `kvault_<id>_<secret>`；只勾 `upload` + `delete`，policies 限 `folderPrefix: "chat"` 与 `maxFileSize: 2MB` |

- `wrangler.toml` 不新增任何 `[vars]`，仓库里搜不到任何图床地址。
- 本地开发写 `.dev.vars`（已在 `.gitignore`）；生产用 `npx wrangler secret put KVAULT_BASE` / `... KVAULT_TOKEN`。
- 两个变量任一缺失 → `/upload` 返回 503、`/img/*` 返回 404，页面不启用粘贴上传；聊天其余功能完全不受影响。
- 拼接一律 `new URL(path, base)`，容忍 base 末尾带不带 `/`；也便于换成自建 Docker 版 K-Vault。
- 只对接 K-Vault 的 v1 API（`POST /api/v1/upload`、`DELETE /api/v1/file/:id`、`GET /file/:id`），不承诺兼容其它图床。

## 风险

- **跨房间去重**：K-Vault 对相同字节返回同一个 id。两个房间发同一张图时，先散场的房间会把另一房间的图删掉。
  `imgs` 交集校验只能防"伪造消息触发删除"，防不了这种合法同 id。概率低，接受并在此记录。
- **删除是 best-effort**：Telegram 删除失败时 K-Vault 仍删 KV（图片变 404，Telegram 侧残留）。重试 2 轮后放弃。
- **图床不可用**：上传返回 502、旧图 404，聊天本身不受影响。
- **免费额度**：每张图一次 Worker 请求（代理）+ 一次图床请求；个人小范围可忽略。

## 验证

- `src/images.js` 单测：URL 构造、鉴权头、错误映射、`extractImageIds`、类型白名单。
- `test/room.test.js`：非同源 403、非图片 415、超限 413、成功返回 `/img/...` 且账本有 id、
  `/img/<id>` 透传 `image/*` 与 `Cache-Control`、非图片上游 404、`alarm()` 只删账本内的 id 且失败会重试、
  **未配置环境变量时 `createImageClient(env).enabled === false`（单测锚点）；`/upload` 的 503 与页面开关都由同一个判定驱动**。
- `test/markdown.test.js`：`![](/img/abc)` → `<img>`；`![](https://x/y.png)` 原样；
  `![](javascript:alert(1))` 原样；`<img src=x onerror=...>` 仍被转义。
- 手工：本地 `wrangler dev` + `.dev.vars` 粘贴一张截图 → 看图 → 关掉页面等 30 分钟（或直接调 `alarm()`）→ 图 404。
