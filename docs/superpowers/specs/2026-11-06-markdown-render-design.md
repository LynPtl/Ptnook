# Markdown 渲染（最小内联集）— 设计文档

日期：2026-11-06
项目：Ptnook 聊天室(Cloudflare Workers + Durable Objects,单文件 src/worker.js 含 ChatRoom DO + 内嵌 HTML,零依赖零构建)

## 目标

让聊天消息支持**最小内联 Markdown**（粗体/斜体/行内代码/删除线/自动链接），在**不引入依赖、不引入构建、不破坏 XSS 安全**的前提下完成。

本需求自 `2026-07-31-chat-experience-tier1-design.md` 起即被列为推迟项，原文："Markdown 渲染(以后单独 brainstorm,重点做 XSS sanitizer 选型)"。本文档即那次 brainstorm 的结论。

## 范围

纳入（仅行内语法，共 5 种）:
- `**文字**` → `<strong>`
- `*文字*` → `<em>`
- `` `文字` `` → `<code>`
- `~~文字~~` → `<del>`
- `https://...` / `http://...` → `<a>`（自动链接，仅 http/https）

排除（YAGNI / 明确不做）:
- 标题、列表、引用、表格、代码块（``` 围栏）、分割线。
- **图片 `![]()`：不解析，原样显示为文本**。理由：README 定位「仅纯文字消息」；外链图片可被用于追踪 IP（加载即泄露）。
- 链接语法 `[文字](url)`：不实现。`**` 内的 `[...](javascript:...)` 不会被转成链接，仅作纯文本处理。
- Markdown 渲染开关/用户偏好设置（不做开关，一律渲染）。
- 服务端改动（协议、存储、广播全部不动）。

## 一、架构选择：服务端 vs 前端

**结论：渲染放前端，函数放独立模块，纯函数、可单测。**

- 逻辑归属写成独立模块 `src/markdown.js`（纯函数，不依赖 WebSocket/DO/DOM），
  与 `ddz.js` / `holdem.js` 的分层一致（纯规则逻辑从 worker.js 抽离以便充分单测）。
- 该模块被 worker.js 内嵌前端 `<script>` 引用：`worker.js` 通过 ES module `import` 引入，
  前端脚本作为内嵌字符串无法 import —— 因此**在 worker.js 内以字符串拼接方式注入**：
  见"三、接线方式"，不引入打包器。
- 渲染时机：消息到达时（含历史 items），与现有 `addChat` 对齐。

选前端而非服务端的原因：
- 历史/重连/新消息三条路径都走同一个 `addChat`，只需改一处，无需改协议与存储。
- 服务端不落 HTML，`history` 里存的仍是原文，避免"存 HTML 又被二次渲染"的风险。
- 零协议改动 = 零兼容成本（旧客户端不会收到意外字段）。

## 二、安全模型（本设计核心）

### 为何不需要通用 sanitizer

语法锁死为「5 种行内 + 无图片 + 无 `[text](url)`」后，**输出标签是固定枚举**：
`strong` `em` `code` `del` `a`。用户输入**永远只出现在标签内容位置，或已被转义的引号内**，
从不进入属性名位置，也无法构造新的属性。

因此本设计**不采用"匹配危险模式再过滤"**（易漏、需维护黑名单），而采用
**"先整体转义，再仅对白名单标记套标签"**——只构造已知安全结构。

### 顺序即保证（安全关键）

```
1. escapeHtml(整段原文)        & < > " ' 全部实体化
2. 行内代码用占位符抽走         避免 code 内部被后续规则解析
3. 依次套 strong / em / del   此时输入已无任何 < > " '，无法注入
4. 自动链接                   仅 ^https?:// 通过，href 由常量模板拼接
5. 回填 code 占位符
```

### 转义表

| 字符 | 实体 |
|---|---|
| `&` | `&amp;` |
| `<` | `&lt;` |
| `>` | `&gt;` |
| `"` | `&quot;` |
| `'` | `&#39;` |

### 自动链接约束

- 仅接受 `^https?://`（大小写不敏感）；`javascript:` / `data:` / `vbscript:` 一律不转链接。
- `<a>` 的属性 `href` / `target` / `rel` 由**字面量常量**拼接，用户文本无法控制。
- 必须带 `rel="noopener noreferrer"`，否则 `target="_blank"` 可经 `window.opener` 反向控制原页面。
- 链接 URL 本身已经过步骤 1 转义，`&` 会变成 `&amp;`，符合 HTML 属性语义，可正确解析。
- 链接 URL 的匹配终止于空白字符（`[^\s]`），因此 `"` 无法闭合属性（且 `"` 已实体化为 `&quot;`）。

### 行内代码的占位符策略

用不可见字符 `\u0000<序号>\u0000` 占位。用户原文中的 `\u0000` 在步骤 1 不转义，
故实现时需**先剔除原文中的 `\u0000`**，防止伪造占位符造成注入或错位。

## 三、接线方式（唯一突破 textContent 之处）

现状 `src/worker.js` 第 1417 行：

```js
b.textContent = t;
```

改为：

```js
b.innerHTML = renderMd(t);
```

**这是全项目唯一允许承载服务端数据走 HTML 的位置**，必须在代码处写注释说明理由，
防止后人按"一律 textContent"的旧约定误改回。

其余所有位置（nick、system 消息、牌面、底牌、按钮文案）**保持 textContent 不变**。

内联注入方式：worker.js 已是 ES module，顶部 `import { renderMd } from "./markdown.js";`，
在生成 HTML 的内嵌 `<script>` 中，通过模板字符串把函数源码以内联方式提供
（实现时选用最简可行的一种，优先 `renderMd.toString()` 注入，避免重复维护两份实现）。

## 四、与现有行为的兼容

- **多行输入**：`.body` 已有 `white-space: pre-wrap`，`innerHTML` 不与之冲突，换行照常保留。
  所有正则均带 `[^\n]`，跨行不会被误匹配（行内代码不跨行）。
- **`/ddz`、`/poker` 命令**：在 `sendMessage` 中先行拦截并 `return`，不经过渲染，无影响。
- **滚动/贴底、新消息分隔线、未读定位**：均不依赖 `.body` 的文本节点结构，不受影响。
- **历史缓存 50 条**：存原文，不改。
- **XSS 现状不回退**：nick、system 仍 textContent。

## 五、测试策略

新增 `test/markdown.test.js`（vitest，与现有 4 个测试文件同风格）：

1. **语法正例**：5 种语法各自单独与混排。
2. **XSS 反例（必须具备）**：
   - `<script>alert(1)</script>` → 全实体化
   - `<img src=x onerror=alert(1)>` → 全实体化
   - `**<script>**` → strong 包裹下仍为转义文本
   - `<a href="javascript:alert(1)">a</a>` → 全实体化
   - `</div><svg onload=alert(1)>` → 全实体化
   - `` `<script>` `` → code 内仍为转义文本
   - `javascript:alert(1)` 与 `[x](javascript:alert(1))` → 不生成 `<a>`
   - 属性逃逸 `" onmouseover="alert(1)` → 引号实体化
   - 伪造占位符 `\u00001\u0000` → 不产生注入
3. **边界**：未闭合 `*`、`**` 嵌套、`*` 紧邻非空格、超长文本、空字符串。
4. **回归**：`<` 在 code 内显示为 `&lt;` 且不丢字符。
5. **幂等/原文不变**：渲染不修改 `messages.js` 的 `sanitizeText` 行为，`test/messages.test.js` 保持全绿。

前端渲染结果（真实浏览器内视觉）沙箱无法交互验证，如实标注 **NOT RUN**，以手动冒烟补充。

## 六、非目标提醒

- 不改部署方式（仍 `npm run deploy`）、不加第三方依赖、不引入构建步骤。
- 不做完整 Markdown、不做图片、不做开关。
- 服务端协议/存储/广播零改动，`test/room.test.js` 等既有测试必须保持全绿（当前 147 个用例）。
