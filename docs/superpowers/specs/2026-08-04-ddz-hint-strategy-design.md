# 斗地主提示策略升级（A 档启发式）— 设计文档

日期：2026-08-04
项目：Ptnook 聊天室斗地主（master 分支，src/ddz.js 引擎，src/worker.js DO 的 ddz_hint 分支现用 pickHint 选最小）

## 目标

把「提示」从"能压过的最小一手"升级为 A 档启发式策略：在规则内尽量打得好——不乱拆成型牌组、留住炸弹/大牌、自由出先清散牌、残局能一手走完就走完。只看自己手牌 +上家这一手，纯确定性、可单测、性能可控。

## 范围

- 新增纯函数 `chooseHint(hand, last)` 与辅助 `decompose(hand)`，放 src/ddz.js。
- DO 的 `ddz_hint` 分支改为调 `chooseHint`（替代直接 `pickHint`）。`pickHint` 可保留（不删，仍被测试引用）或不再被 ddz_hint 使用——实现时以 chooseHint 为准。
- 不改前端提示按钮/高亮、不改牌型引擎（identifyPlay/beats/enumerateLegalPlays 不变）。

不做：读对手信息（B 档）、多步搜索（B/C 档）、AI 托管。

## chooseHint(hand, last) 决策逻辑（按优先级，命中即返回）

只看自己手牌 hand（令牌数组）与上家这一手 last（令牌数组或 null）。返回一手令牌数组，或 null（要不起）。

### 规则 0（最高优先·一手走完）
- 若 `identifyPlay(hand)` 非空（整手是合法牌型），且（`last` 为空 或 `beats(hand, last)` 为真），→ 返回整手 `hand`（全出，临门一脚）。

### 跟牌（last 非空）
候选 = `enumerateLegalPlays(hand, last)`（所有能压过 last 的合法手）。

- **规则 1（不拆 + 最小，排除炸/火）**：从候选中排除 bomb / rocket，在剩余候选里选"破坏度最低、并列取 rank 最小"的一手：
  - 破坏度 = 出该手后，剩余手牌用 `decompose` 分解，相比出牌前是否拆散了本可成型的顺子(≥5)/连对(≥3)/三条/飞机。度量方式（可实现的近似）：比较"出牌前 decompose 的成型牌组数/散牌数"与"移除这手后 decompose 的结果"，倾向于让成型牌组保持完整、散牌不增多的选择。并列时按 `identifyPlay(play).rank` 升序。
  - 有结果 → 返回该手。
- **规则 2（非炸不可才炸）**：若规则 1 无非炸候选（候选里只有 bomb/rocket），则：候选中有普通炸弹 → 返回最小的炸弹（rank 最小）；否则若有 rocket → 返回 rocket。
- 候选为空 → 返回 null（DO 侧回 ddz_error「没有能压过的牌，只能过」）。

### 自由出（last 为空）
- **规则 3（先清散牌，留结构与大牌）**：用 `decompose(hand)` 分解，按以下优先级取一手：
  1. 最小的**孤张单牌**（不属于任何成型牌组的散单），取点数最小者。
  2. 若无孤张单牌，取最小的**孤对**（不属于连对的对子）。
  3. 若无散牌，取**点数最小的成型牌组**（顺子/连对/三条/飞机等中最小的一整组）。
  - 意图：先出散牌负担，保留顺子、炸弹、2/王等大牌到后面控场。
- 自由出不调用 enumerateLegalPlays（规避 O(2^n)）；仅用 decompose 的结果挑选。

## decompose(hand) 辅助（纯函数，规则 1/3 共用）

- 输入令牌数组，贪心分解为牌组，返回结构如 `{ groups: [{type, cards}], singles: [...], pairs: [...] }`（具体形状实现时定，需能区分：成型牌组、孤张单牌、孤对）。
- 贪心顺序：先提 **王炸/炸弹 → 飞机 → 顺子(≥5) → 连对(≥3) → 三条 → 对 → 单**，逐层从剩余牌中提取，最长优先。
- 是启发式（非最优分解），对 A 档足够；纯函数，可单测。

## DO 改动（src/worker.js ddz_hint 分支）

- 现分支：自由出短路取最小单张、跟牌用 `pickHint(enumerateLegalPlays(...))`。
- 改为：`const hint = chooseHint(g.hands[nick] || [], g.lastPlay ? g.lastPlay.cards : null);` 然后 `!hint → ddzErr("没有能压过的牌，只能过")`，否则 `ws.send({type:"ddz_hint", cards: sortCards(hint)})`。
- 保留 phase/current 守卫不变。保留自由出不做 O(2^n) 枚举（chooseHint 自由出走 decompose，天然满足）。

## 影响面

- src/ddz.js：新增 `decompose`、`chooseHint`（含单测）。identifyPlay/beats/enumerateLegalPlays/pickHint 不变。
- src/worker.js：ddz_hint 分支改调 chooseHint。
- 现有 60 测试须通过；新增 decompose、chooseHint 各规则的确定性单测。

## 测试策略

- `decompose(hand)`：构造含顺子+散单+对的手牌，断言分组正确（成型牌组、孤张、孤对识别）。
- `chooseHint`：
  - 规则 0：hand 恰为一个顺子，自由出 → 返回整手；跟牌且能压 → 返回整手。
  - 规则 1：上家出小单张，手里孤张能压 vs 拆顺子能压 → 返回孤张（不拆），并列取最小。
  - 规则 2：只有炸弹能压 → 返回最小炸弹；只有王炸 → 返回王炸。
  - 规则 3：自由出，有小孤张 → 返回最小孤张；无孤张有小对 → 返回小对；只剩成型组 → 返回最小组。
  - 要不起：跟牌无任何能压 → 返回 null。
- DO ddz_hint：runInDurableObject 注入 state，断言回传 cards 符合策略（沿用现有确定性测试方式）。
- 前端：不改，无需新测。

## 非目标

- 非理论最优（不做搜索/求解）；不读对手；不改部署、不加依赖；commit 不带 TRAE 署名。
