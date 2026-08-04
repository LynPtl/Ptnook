# 斗地主「提示」按钮 — 设计文档

日期：2026-08-04
项目：Ptnook 聊天室斗地主（master 分支，src/worker.js 含 ChatRoom DO + 内联前端，src/ddz.js 引擎含 enumerateLegalPlays）

## 目标

轮到出牌的玩家点「提示」按钮，系统自动选出一手合法应牌并在手牌条高亮为当前选中，玩家确认后直接【出牌】（或再调整/再点提示）。降低"跟牌时要肉眼找哪些压得过"的负担。

## 关键决策（已确认）

- **计算放服务端（方案 A）**：复用引擎 `enumerateLegalPlays(hand, last)`。前端点「提示」发 `ddz_hint` 请求，服务端算好一手回 `ddz_hint {cards:[...]}`，前端高亮。理由：引擎在服务端权威、现成；前端是内联脚本无法 import ddz.js，避免镜像整套引擎（identifyPlay/beats 等）导致的双份维护与漂移。
- **选哪一手（方案 C）**：
  - 跟牌（lastPlay 非空）：给"最小的能压过上家"的一手。
  - 自由出（lastPlay 空）：给"最小的合法一手"（默认建议）。
  - 每次点给这一手，不做循环切换。
- **交互（方案 A）**：提示直接**覆盖**当前选中（写入 ddz.selected 并重渲染高亮），玩家可直接【出牌】，也可手动改或再点提示。
- **无牌可出反馈**：跟牌时若要不起（候选为空），回一条 `ddz_error`，前端提示 `⚠️ 没有能压过的牌，只能过`。

## 消息协议（新增）

- 客户端→服务端：`{type:"ddz_hint"}`（无参；服务端据发起者 nick 找其手牌与当前 lastPlay）。
- 服务端→客户端：
  - 有建议：`{type:"ddz_hint", cards:[令牌...]}`（仅发给请求者）。
  - 无牌可出：复用 `{type:"ddz_error", text:"没有能压过的牌，只能过"}`（仅发给请求者）。

## 服务端逻辑（handleDdz 内新增 ddz_hint 分支）

- 校验：phase 必须为 `playing`；nick 必须为 `g.current`（不是当前出牌者则回 ddz_error「还没轮到你」）。
- 取 `hand = g.hands[nick]`、`last = g.lastPlay ? g.lastPlay.cards : null`。
- `const plays = enumerateLegalPlays(hand, last);`
  - 为空 → 回 ddz_error「没有能压过的牌，只能过」。
  - 非空 → 选"最小的一手"：先按牌数升序、同牌数按牌型主 rank 升序挑第一手（"最小"定义见下），回 `{type:"ddz_hint", cards}`。
- "最小的一手"选择规则（确定性，可测）：
  - 在候选中，优先选**牌数最少**的一手（跟牌时同牌型牌数相同，此项主要影响自由出时倾向出单张/对子等小牌组）。
  - 牌数相同时，按该手的比较主键（identifyPlay 的 rank）升序取最小。
  - 抽成纯函数 `pickHint(plays)` 放 src/ddz.js 便于单测（输入候选二维数组，返回选中的一手）。

## 前端逻辑

- 出牌阶段且轮到自己时，在出牌按钮区加「提示」按钮（与「出牌」「过」并列）。
- 点「提示」→ `ddzSend("ddz_hint")`。
- 收到 `{type:"ddz_hint", cards}`：把 ddz.selected 重置为这手牌对应的手牌索引（按令牌匹配 ddz.hand 的位置，重复点数按出现次数依次匹配），调用 renderHand() 高亮；玩家可直接点【出牌】。
- 收到 `ddz_error`（含"只能过"）：现有 `addSystem("⚠️ "+text)` 已处理，无需改。
- 需保证：ddz.hand 与服务端手牌一致（已有 ddz_hand 同步机制），故索引匹配可靠。

## 影响面

- src/ddz.js：新增纯函数 `pickHint(plays)`（含单测）。引擎其余不变。
- src/worker.js：DO 加 `ddz_hint` 分支；前端 renderDdz 加「提示」按钮 + onmessage 加 `ddz_hint` 处理 + 一个"按令牌选中手牌索引"的辅助。
- 现有 54 测试须通过；新增 pickHint 单测、ddz_hint DO 行为（有建议/要不起）断言。

## 非目标

- 不做候选循环切换（方案 B 未采纳）。
- 不做 AI 强度评估/最优出牌（提示只给"最小合法一手"，非最优策略）。
- 不改部署、不加依赖、commit 不带 TRAE 署名。

## 测试策略

- `pickHint(plays)` 纯函数：给定候选数组，断言选出牌数最少、同数按 rank 最小的一手；空数组返回 null/undefined 的约定。
- DO ddz_hint：注入 game state（runInDurableObject）设定 current=某玩家、给定手牌与 lastPlay，断言回 ddz_hint.cards 合法且能压 last；lastPlay 设为超大牌使要不起，断言回 ddz_error「没有能压过的牌，只能过」。
- 前端高亮：静态 hook + 手动冒烟（沙箱无法交互，如实标注 NOT RUN）。
