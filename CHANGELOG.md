# 版本记录

本项目无既有 CHANGELOG，自本次起按版本记录功能变更。

## 2026-11-06 — 聊天消息支持最小内联 Markdown 渲染

### 新增
- `src/markdown.js`：最小内联 Markdown 渲染器，导出 `escapeHtml` 与 `renderMd`。
  支持 5 种语法：`**粗体**`、`*斜体*`、`` `行内代码` ``、`~~删除线~~`、`http(s)://` 自动链接。
  零依赖、零构建。
- `test/markdown.test.js`：32 个用例，含 9 条 XSS 反例与注入自包含性约束。
- `docs/superpowers/specs/2026-11-06-markdown-render-design.md`：设计文档。
- `docs/superpowers/plans/2026-11-06-markdown-render.md`：实现计划。

### 变更
- `src/worker.js`：`addChat` 由 `textContent` 改为 `innerHTML = renderMd(t)`；
  `renderPage()` 内以 `renderMd.toString()` 注入内嵌前端。
  这是全项目唯一允许用 HTML 承载服务端文本的位置，其余位置保持 `textContent`。

### 安全
- 采用「先整体转义，再仅对白名单标记套标签」策略，不引入通用 sanitizer。
- 输出标签固定为 `strong`/`em`/`code`/`del`/`a`，用户文本只出现在标签内容位置。
- 自动链接仅接受 `http`/`https`，`javascript:` 等伪协议不转链接；
  链接带 `rel="noopener noreferrer"`。
- 服务端协议、存储、广播零改动；历史缓存仍存原文，不留 HTML。

### 测试
- 全量 179 个用例通过（原 147 + 新增 32），既有测试无回归。

### 已知局限
- 不成对的孤立 `*` 可能被误配为斜体。例如
  `这里有 *号没闭合，还有 **两个星号` 会把中间片段包进 `<em>`。
  无安全影响，属显示层瑕疵，暂不修复（YAGNI）。
- 浏览器内视觉效果沙箱无法交互验证，已由人工冒烟确认。

### 非目标
- 不支持标题、列表、引用、表格、代码块（``` 围栏）。
- 不解析图片 `![]()` 与链接语法 `[文字](url)`，均按纯文本显示。
- 不提供渲染开关；不引入第三方依赖与构建步骤。
