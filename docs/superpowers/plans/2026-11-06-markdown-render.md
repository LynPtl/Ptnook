# Markdown 渲染（块级 + 行内）— 实现计划

日期：2026-11-06
设计文档：`docs/superpowers/specs/2026-11-06-markdown-render-design.md`
项目现状：197 个测试全绿（`test/{messages,room,ddz,holdem,markdown}.test.js`），零依赖零构建。

## 实现约束（2026-11-06 第二期改写）

### 已废弃的约束：`toString()` 注入

第一期用 `Function.prototype.toString()` 把 `renderMd` 内联进页面，导致函数体
不得出现任何嵌套函数（esbuild keepNames 会插入 `__name(...)`，在内联脚本中
ReferenceError）。块级解析需要循环状态机与辅助函数，与该约束根本冲突。

**第一期代码已经处于临界点**：旧注释声称「replace 回调用的是裸 `function (…)`，故安全」，
但 esbuild 对匿名函数表达式同样生成 `__name`，该结论不成立。

### 现行约束：`[assets]` + ES module

- 渲染器唯一源：`public/markdown.js`，可自由使用辅助函数、递归、`Array.map`。
- `wrangler.toml` 新增 `[assets]`，`directory = "./public"`，`binding = "ASSETS"`。
- 前端：`<script type="module">` 内 `import { renderMd } from "/markdown.js";
- 服务端 **不再** import renderMd（前端不需要经由 Worker 传递）。

## 任务 1：RED — 写失败测试

在 `test/markdown.test.js` 新增：

- `describe("块级语法")`：h1-h6 / 七级 / `#标签` / ul / ol / 引用多行合并 / hr 三写法 /
  围栏内部不解析 / 围栏内 XSS / 未闭合围栏 / 段落包裹 / 空行不产生空段落 /
  块内内联标记 / 块内 href 严格相等 / 块内 XSS。
- `describe("自动链接 href 边界（回归）")`：裸链接、`**`、`~~`、`*` 四种 href 严格等于 URL；
  行内代码内不产出链接；链接后紧跟中文标点不吞入。

已旧用例中期望值不带 `<p>` 的，全部改为带段落包裹（块级语义变更）。

验证：`npx vitest run test/markdown.test.js` 应为 RED。

## 任务 2：GREEN — 实现 public/markdown.js

顺序（安全关键，不可调换）：

1. 剔除原文中的 `\u0000`（防伪造占位符）
2. 按行识别块级结构——**此阶段不转义**
   转义会把 `>` 变成 `&gt;`，使引用正则失效（已实测踩中）
3. 围栏整块抽走，内部只 `escapeHtml`
4. 行内容统一 `escapeHtml`
5. 行内代码抽为 `\u0000<序号>\u0000` 占位
6. `**` → strong，`*` → em，`~~` → del
   强调采用**两阶段**：先按「对称优先、由内到外」配对并用占位符保护，再回填。
   引入 CommonMark 左右分隔符判定（开标记右侧非空白、闭标记左侧非空白）。
   不跨手动换行（每个 `\n` 独立）。
7. 自动链接（见下）
8. 回填 code 占位

自动链接正则（两阶段）：
- 匹配阶段：`/(https?:\/\/[^\s<>`"，。；：！？、）】」』…]+)/gi`
  排除 `<` `>` `` ` `` `"` 避免吞入 `</strong>` 等闭合标签；
  排除全角标点避免贪婪匹配越过中文逗号吞入后续文字。
- 尾部清洗：剔离 `.,;:!?'*~_]` 与不成对右括号（URL 内部允许 `.` 与 `()`）。

验证：`test/markdown.test.js` 全绿。

## 任务 3：接线

- `wrangler.toml` 加 `[assets]`
- `src/worker.js`
  - 删除 `import { renderMd } from "./markdown.js"`
  - `<script>` → `<script type="module">`，开头 `import { renderMd } from "/markdown.js";`
  - 删除 `var renderMd = ${renderMd.toString()};`
  - 更新 `addChat` 的注释（白名单标签集合已扩展到块级）
- 删除 `src/markdown.js`
- 删除 `test/markdown.test.js` 中「注入自包含性」整段（保留其中与注入无关的行内代码回填用例）

验证：`npm test` 全量（预期 197 个用例全绿）。

## 任务 4：实测（已完成）

wrangler 4.116 本地实测结果：

| 项 | 结果 |
|---|---|
| `GET /` | 200 `text/html`，页面含 1 个 `script type="module"`，无 `toString` 注入代码 |
| `GET /markdown.js` | 200 `text/javascript; charset=utf-8`，7296 字节，原样未打包 |
| `/markdown.js` 缓存 | `public, max-age=0, must-revalidate` + ETag → 无旧版粘滞 |
| `GET /room/x` 非 ws | 426 Upgrade Required（DO 路由未受影响） |
| 下载 `/markdown.js` 后 import | 导出 `escapeHtml`/`renderMd`，块级与链接均正确 |

浏览器视觉效果仍需人工确认（沙箱无法交互）：粗体/斜体/代码/删除线/链接、
标题层级、列表符号、引用缩进、分割线、围栏代码块字体、多行换行保留。

## 非目标

不改协议/存储/广播；不加依赖；不加构建；不做图片、表格与完整 Markdown。

## 已知局限

- 强调**可以**跨段落内软换行（`*a\nb*` → `<em>`，与 CommonMark 一致）；
  分隔符要求标记紧邻非空白字符，故 `5 * 3\n2 * 4` 不误配。
  （注：本条最初写为「不跨换行」，与实现不符，已按实测修正。）
  故 `**a\n*b*` 中的 `**` 不会跨行闭合。
- 嵌套列表、表格、引用内嵌代码块均不支持。
- 强调解析未实现完整的 CommonMark delimiter stack + rule of 3，
  采用「对称优先、由内到外」的简化算法（经用户确认）。
  已覆盖的嵌套：`**a *b* c**`、`*a **b** c*`、`*a**b**c*`、`***a***`。
