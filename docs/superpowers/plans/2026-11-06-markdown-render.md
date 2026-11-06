# Markdown 渲染（最小内联集）— 实现计划

日期：2026-11-06
设计文档：`docs/superpowers/specs/2026-11-06-markdown-render-design.md`
项目现状：147 个测试全绿（`test/{messages,room,ddz,holdem}.test.js`），零依赖零构建。

## 实现约束（实测得出，违反即静默失败）

`renderMd` 经 `Function.prototype.toString()` 注入内嵌前端。已实测：
若 `renderMd` 调用模块内的辅助函数（如 `escapeHtml`），注入后抛
`ReferenceError: escapeHtml is not defined`。

**因此 `renderMd` 必须是自包含单函数**：所有辅助逻辑（转义、URL 判定）以嵌套函数或内联形式写在 `renderMd` 体内。
`escapeHtml` 如需对外导出供测试，则**另写一份独立实现**，`renderMd` 内不复用（重复 5 行可接受，换取注入可靠性）。

## 任务 1：RED — 写失败测试

新建 `test/markdown.test.js`，先跑必红（模块不存在）。

覆盖：
- 5 种语法正例 + 混排
- 9 条 XSS 反例（见设计文档 §五）
- 边界：未闭合标记、`**` 嵌套、空串、超长（>2000）
- 回归：code 内 `<` 转义为 `&lt;` 不丢字符
- **注入自包含性**：断言 `renderMd.toString()` 中不含对 `escapeHtml(` 等外部标识符的调用

验证：`npx vitest run test/markdown.test.js` 应为 RED。

## 任务 2：GREEN — 实现 src/markdown.js

单文件，导出 `escapeHtml` 与 `renderMd`（`renderMd` 自包含）。

顺序（安全关键，不可调换）：
1. 剔除原文中的 `\u0000`（防伪造占位符）
2. `escapeHtml` 全量转义
3. 行内代码抽为 `\u0000<序号>\u0000` 占位
4. `**` → strong，`*` → em，`~~` → del（正则均带 `[^\n]`）
5. `^https?://` 自动链接，`href` 常量拼接 + `rel="noopener noreferrer"`
6. 回填 code 占位

验证：`test/markdown.test.js` 全绿。

## 任务 3：接线 worker.js

- 顶部 `import { renderMd } from "./markdown.js";`
- `renderPage()` 的内嵌 `<script>` 开处注入：`var renderMd = ${renderMd.toString()};`
- `addChat`（约 1417 行）：`b.textContent = t;` → `b.innerHTML = renderMd(t);`
  **必须加注释**说明这是全项目唯一允许 HTML 承载服务端数据之处及原因。
- 其余 textContent 位置一律不动。

验证：
- `npm test` 全量（应 ≥180 用例全绿，原 147 不受影响）
- `npx wrangler dev` 起服务，`curl /` 确认返回页面含注入的 `renderMd`
- 用 WebSocket 发含 `**粗体**` 与 `<script>` 的消息，确认广播原文未变（渲染是前端行为）

## 任务 4：手动冒烟（NOT RUN 部分如实标注）

沙箱无法交互验证浏览器视觉。需人工确认：
- 粗体/斜体/代码/删除线/链接渲染正确
- 多行消息换行仍保留（`pre-wrap`）
- `<script>alert(1)</script>` 显示为字面文本，不弹窗
- 贴底滚动、新消息分隔线未回归

## 非目标

不改协议/存储/广播；不加依赖；不加构建；不做图片与完整 Markdown。
