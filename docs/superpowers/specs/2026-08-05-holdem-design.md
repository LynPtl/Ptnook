# 德州扑克（三人朋友局，支持 2~3 人动态）— 设计文档

日期：2026-08-05
项目：Ptnook 聊天室（Cloudflare Workers + Durable Objects，一房间一 DO；src/worker.js 含 ChatRoom DO + 内嵌 HTML 前端；已有斗地主 src/ddz.js 引擎 + DO 状态机可参照其模式）

## 目标

在聊天室里加一个德州扑克小游戏，供自己人玩。No-Limit 标准规则，筹码以 bb 计（非真钱、纯分数），输光可无限 buy-in 复活。与聊天并存。

## 已确认规则（需求结论）

- **人数**：座位固定最多 3 人；每手实际参与者 = 当前筹码>0 的人，因此可能是 2 人（单挑）或 3 人。支持 2 人与 3 人两套位置规则。
- **筹码单位**：bb。小盲 0.5bb / 大盲 1bb，固定不涨。开局每人 50bb。
- **buy-in 复活**：仅当某人筹码=0 且处于两手之间时，其座位显示【buy-in】按钮，点击领一份 50bb，无限次。筹码>0 时无 buy-in 按钮。
- **下注**：No-Limit 标准。动作 check/bet/call/raise/fold/all-in。最小加注量=上一个加注量（标准最小加注规则）；preflop 最小开注 1bb；上不封顶（可 all-in）。
- **边池**：完整实现主池 + 边池（按各人投入分层，谁能赢哪层按投入封顶）。三人局最多 2 层边池。
- **摊牌**：打到只剩一人（余者 fold）→ 直接收池、不亮牌；2+ 人到摊牌 → 亮底牌，7 选 5 比大小；平手平分（主池/边池分别结算，除不尽的零头按位置就近分配，见下）。
- **手间流转**：一手结束 → 展示结算 → 需活着的玩家（筹码>0）点【下一手】才开下一手。筹码=0 的人无【下一手】、只有【buy-in】。若活人先点了【下一手】，则这手只由当前筹码>0 者参与（2 或 3 人），筹码0未补者旁观；该手结束后回到手间，其 buy-in 按钮再次出现。
- **无终局无名次**：一直打。

## 位置与行动顺序（标准规则）

- **按钮(Button/D)**每手结束后在"当前参与者"中顺时针移一位。
- **3 人**：位置 = D / SB / BB。preflop 行动顺序 **D → SB → BB**（D 先，因 SB/BB 已下盲）；postflop **SB → BB → D**（D 最后，有位置）。
- **2 人（单挑）**：庄家(D)兼小盲(SB)，另一人 BB。preflop **D(SB) 先动**；postflop **BB 先动、D 后动**。
- 若某手开始时筹码>0 的人 < 2（只剩 1 人有钱），无法开局，停在"等待其他人 buy-in"状态。

## 一、架构与引擎分层（参照斗地主）

- 复用"一房间一 DO"。在 ChatRoom DO 内新增德州扑克游戏状态，与聊天、斗地主并存（三者独立；同一房间同一时刻是否允许斗地主与德州并行——见"非目标/约束"，默认不并行，一个房间同时只跑一种桌游）。
- **纯规则引擎抽成独立模块 `src/holdem.js`**（纯函数，不依赖 WebSocket/DO）：
  - 牌模型与发牌（52 张，无王）。
  - **牌力评估** `evaluateHand(sevenCards) → { rank, tiebreak }`：7 选 5 最大牌型，返回可比较的分值。牌型高低：高牌 < 一对 < 两对 < 三条 < 顺子 < 同花 < 葫芦 < 四条 < 同花顺（含皇家）。含 A2345 轮子顺（A 作低）。
  - **比牌** `compareHands(a, b)`：基于 evaluateHand 结果比大小，返回 >0/=0/<0。
  - **边池计算** `buildPots(contributions) → [{amount, eligible:[seat...]}]`：按各人总投入分层，产出主池+边池及各池有资格玩家。
  - **下注合法性/最小加注** 相关纯函数：给定当前下注状态，校验某动作是否合法、计算最小加注额。
  - 位置/行动顺序推导（2 人 vs 3 人）可做成纯函数便于测试。
- DO 只负责：座位/连接、持有牌局状态、调用 holdem.js 裁决、给每个连接单独下发"该玩家视角"（自己两张底牌私发；公共状态广播给在座玩家）。

## 二、牌与手牌表示

- 牌用 `rank+suit` 令牌，如 `As`(黑桃A)、`Td`(方块10)、`2c`(梅花2)。rank: 2-9,T,J,Q,K,A；suit: s/h/d/c。（实现时定死一种表示，evaluateHand 消费之。）
- 每人 2 张底牌（私有）；公共牌 5 张（翻牌 3 + 转牌 1 + 河牌 1）。摊牌时 7 选 5。

## 三、游戏状态（存 DO storage，断线/休眠可恢复）

大致字段：
- 阶段 `phase`：`waiting`（等开始/等 buy-in）/ `preflop` / `flop` / `turn` / `river` / `showdown` / `settled`。
- 座位：最多 3 席，每席 `{ nick, connId, stack(bb), inHand(bool), hasFolded, isAllIn, holeCards:[2], streetBet(本轮已下), totalBet(本手累计) }`。
- `buttonSeat`、每手根据参与者推导 SB/BB。
- `board`：公共牌数组（0/3/4/5 张）。
- `pot`：主池累计；`currentBet`：本轮当前最高下注；`minRaise`：当前最小加注量；`toAct`：当前该行动的座位；本轮已行动/需响应集合。
- `deck`：本手剩余牌堆（发牌用；私有，不下发）。
- `scores`/`stacks` 持久（跨手保留，等于各人筹码）。
- 手间标记：等待【下一手】、各人可否 buy-in。

## 四、消息协议（JSON，与现有 chat/ddz_* 并存，前缀 `poker_`）

客户端→服务端：
- `{type:"poker_start"}`（发起牌桌，命令 /poker 触发）、`{type:"poker_join"}`、`{type:"poker_cancel"}`
- `{type:"poker_buyin"}`
- `{type:"poker_next"}`（下一手）
- 行动：`{type:"poker_action", action:"check|call|fold|allin"}`、`{type:"poker_action", action:"bet", amount}`、`{type:"poker_action", action:"raise", amount}`（amount 单位 bb；raise 的 amount 语义在 spec 实现时定死为"加注到的总额"或"加注增量"，二选一并统一——建议用"加注到的总额 raise-to"）
- `{type:"poker_disband"}`（散桌）

服务端→客户端：
- `{type:"poker_state", ...}`：公共牌桌状态，广播在座玩家。含：phase、board、pot（含边池结构）、每席公开信息（nick、stack、streetBet、位置标记 D/SB/BB、hasFolded、isAllIn、是否在座）、toAct、currentBet、minRaise、可用动作提示。
- `{type:"poker_hole", cards:[2]}`：仅发给本人的两张底牌。
- `{type:"poker_error", text}`：仅发给操作者（非法动作/未轮到等）。
- 关键节点（发牌、翻牌/转牌/河牌、某人动作、摊牌结果、结算）同时用现有 `system` 文案广播，便于消息流可读。

## 五、前端（常驻牌桌状态区 + 系统广播）

- 在聊天界面内叠加一个**牌桌状态区**（常驻，实时更新），显示：
  - 公共牌（翻/转/河）。
  - 底池（含边池分层，若有）。
  - 三个座位：昵称、筹码(bb)、本轮下注额、**位置标记 D/SB/BB**、状态（弃牌/all-in/行动中高亮）。
  - 当前轮到谁。
- 轮到自己时，显示动作按钮：check/call/bet/raise/fold/all-in（按当前合法性显隐；bet/raise 需输入额度，给最小额提示与快捷键如 1/2 池、全下）。
- 手间：活人显示【下一手】、筹码0者显示【buy-in】、发起阶段【加入牌桌】【取消】、结算后【散桌】。
- 底牌显示在自己视角（私有）；牌局进展辅以 system 广播滚在消息流。
- 牌面/昵称一律 `textContent`（不破坏 XSS）；牌用花色符号渲染（♠♥♦♣）由前端拼，数据来自服务端结构化令牌。
- 发起仍用命令 `/poker`；游戏内操作全走按钮。

## 六、平分零头规则

- 边池平分除不尽时，多出的最小单位（如 0.5bb 无法再分）按标准规则给"从庄家左手第一个赢家"（位置就近）。实现时定一个确定性规则并测试（避免筹码总量漂移）。

## 七、断线/超时/散桌

- 出牌**不限时**（沿用斗地主取向），断线**保留座位**、牌局暂停等重连；重连补发 poker_state + 自己底牌（参照斗地主 resumed 摘要）。
- 散桌（poker_disband）：任一在座玩家可散，清空整个德州状态，回到纯聊天（可选广播本桌各人筹码盈亏——待实现时定，默认简单广播散桌）。
- 空房 30 分钟由现有 alarm 兜底清除（alarm 里增加清 `holdem` 状态 key）。

## 八、测试策略

- `src/holdem.js` 纯函数（重点，充分单测）：
  - evaluateHand：每种牌型识别 + 边界（轮子顺 A2345、同花顺 vs 四条、踢脚比较、7选5 取最优）。
  - compareHands：各牌型间与同型踢脚比较、平手。
  - buildPots：无 all-in（单池）、一人 all-in（主池+边池）、多人不同额 all-in（多层边池）、封顶资格正确。
  - 最小加注/动作合法性：check 非法（面对下注）、raise 最小额、all-in 不足最小加注、preflop 开注下限等。
  - 位置推导：2 人与 3 人的 SB/BB/行动顺序。
- DO 层集成测试（vitest-pool-workers）：发起→加入→发牌下盲→一轮下注→翻牌…→摊牌结算主流程；非法动作被拒；buy-in 复活；动态 2/3 人；断线重连补发。
- 前端牌桌区/按钮：静态 hook + 手动冒烟（沙箱无法交互，如实标注 NOT RUN）。

## 九、范围拆分建议（供后续 writing-plans）

这是一个大功能，建议实现计划拆成多个子任务，顺序大致：
1. holdem.js 牌模型 + evaluateHand + compareHands（纯引擎，充分单测）。
2. holdem.js buildPots 边池 + 下注合法性/最小加注/位置推导（纯引擎）。
3. DO 状态机：发起/加入/发牌/盲注/一条街下注流转。
4. DO：多街推进（flop/turn/river）+ all-in + 摊牌 + 边池结算 + 手间/buy-in/下一手/动态人数。
5. DO：断线重连补发 + 散桌 + alarm 清理。
6. 前端牌桌状态区 + 动作按钮 + /poker + 渲染。
7. README。

## 十、非目标 / 约束

- 不做真钱、不做锦标赛盲注升级、不做超过 3 座、不做旁观下注、不做行动超时托管。
- 一个房间同一时刻只跑一种桌游（斗地主或德州，不并行）——发起时若已有另一种牌局进行则提示。
- 不改部署方式（仍 `npm run deploy`）、不加第三方依赖（自行实现牌力评估，不引扑克库）、commit 不带 TRAE 署名。
- 前端牌面 textContent 渲染，保持 XSS 安全。
