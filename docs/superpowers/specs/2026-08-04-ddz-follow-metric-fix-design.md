# 斗地主跟牌度量修复（不拆 + 少浪费牌力）— 设计文档

日期：2026-08-04
项目：Ptnook 斗地主（master 分支，src/ddz.js 有 chooseHint/structureScore/decompose，88 测试）

## 背景（两个同源 bug）

跟牌提示出现两个不合理建议，根因同为 `structureScore` 度量缺陷：

1. **KKA 跟单 Q**：提示拆 KK 出单 K，而手里有单 A 可压且不拆对。
   - 现度量 `singles.length + pairs.length*2`：出 K→剩 K A（2 孤张）loose=2；出 A→剩 KK（1 对）loose=2。打平 → 按 rank K(13)<A(14) 选了拆对的 K。错。
2. **单王/火箭 跟单 2**：手有小王+大王，上家出单 2。单出小王即可压过 2（小王>2），却提示出火箭。
   - 出单小王→剩单大王 loose=1；出火箭→剩空 loose=0 → 火箭 loose 更低被选。错。

病根：度量**只看"剩余有多松散"，完全不惩罚"这一手浪费了多大的牌力"**，于是"打光/用大牌清空"被判为最优，鼓励拆对、用大王/炸/火箭去跟小牌。

修复方向（已确认）：跟牌选牌**同时权衡两点**——(1) 少拆成型牌组；(2) 少浪费牌力（能用小牌压就用小牌，别动大王/2/炸/火箭）。

## 一、structureScore 改为只数孤张（方案 A 的一半）

`structureScore(cards)` = `decompose(cards).singles.length`（只数孤张单牌；对/三条/顺子/连对/飞机/炸/火箭等成型组一律**不计惩罚**）。

- 去掉原 `pairs.length*2`：把"保留一个对子"当负担是错误的（对子是资产）。
- 对 KKA：出 A→剩 KK→singles=0；出 K→剩 KA→singles=2。→ 出 A 破坏度更低。✓
- 对削长顺子回归 case（4-9 六连 + 孤 J 跟单 3）：出 J→剩 6连顺→singles=0；出 4→剩 5连顺+…→singles≥1。→ 仍优选不拆。✓

但**只改这个不够**：火箭 case 里出单王剩 singles=1、出火箭剩 singles=0，火箭仍更低。必须叠加"牌力浪费"惩罚。

## 二、跟牌排序键加入"牌力浪费"（核心修复）

`chooseHint` 跟牌分支的排序键，从现有的
`[ structureScore(remaining), isBombOrRocket?1:0, identifyPlay.rank ]`
改为把"这一手用掉的牌力大小"纳入，且让炸/火箭天然靠后。新排序键（字典序最小优先）：

`[ splitDamage, powerCost, tieRank ]`

其中：
- **splitDamage** = `structureScore(removeCardsArr(hand, play))` = 出牌后剩余的孤张数（第一节定义）。越小越好——少拆牌。
- **powerCost** = 这一手打出的"牌力代价"，越小越好。定义为一个能让"普通小牌 < 大牌 < 炸弹 < 火箭"的可比数值：
  - 非炸普通牌型：`powerCost = identifyPlay(play).rank`（该手的比较主键点数，如单 6=6、对 K=13、单小王=16）。
  - 炸弹：`powerCost = 100 + rank`（远大于任何普通牌型，确保炸排在所有普通应手之后）。
  - 火箭：`powerCost = 300`（最大，排最后）。
  - （常数只需保证分层：普通牌 rank ≤17 < 炸 100+ < 火箭 300；实现时用清晰常量。）
- **tieRank** = `identifyPlay(play).rank`，最终并列时的稳定次序。

效果：
- **KKA 跟 Q**：出 A splitDamage=0、出 K splitDamage=2 → 出 A（splitDamage 先决）。✓
- **单王 vs 火箭 跟 2**：单小王 splitDamage=1、powerCost=16；火箭 splitDamage=0、powerCost=300。splitDamage 火箭更低(0<1)——**若 splitDamage 优先，仍会选火箭！**

**因此 splitDamage 与 powerCost 的优先级需要调整**：不能让"打光"无脑压过"省牌力"。正确排序应是**先看牌力代价、再看拆牌**，即键顺序为：

`[ powerCost, splitDamage, tieRank ]`

重新验证：
- **单王 vs 火箭 跟 2**：单小王 powerCost=16 < 火箭 powerCost=300 → 选单小王。✓（保留大王）
- **KKA 跟 Q**：出 A powerCost=14（单A的rank）、出 K powerCost=13（单K）→ powerCost 里 K(13)<A(14)，**会选 K！仍错。**

—— 说明单看 powerCost 也不对（K 比 A 点数小，但拆了对子）。KKA 要的是"别拆对"，火箭 case 要的是"别用超大牌力"。两个诉求在这两个 case 里指向不同的主键。

**结论：需要三者合成，且 splitDamage 与 powerCost 都要参与，顺序为 splitDamage 优先、但 powerCost 把"炸/火箭"这类超额牌力单独拉到最后。** 即回到：

`[ splitDamage, powerTier, tieRank ]`

- **splitDamage**：剩余孤张数（少拆优先）。
- **powerTier**：牌力档位——`0` 普通牌型、`1` 炸弹、`2` 火箭（只分档，不按点数）。让炸/火箭仅在"同等拆牌代价下"排到普通牌之后，但**不因为"打光"而被 splitDamage 奖励**。
- **tieRank**：`identifyPlay(play).rank`（同档同拆牌时取点数最小）。

再验证两个 case：
- **KKA 跟 Q**：出 A [0,0,14]、出 K [2,0,13] → 出 A（splitDamage 0<2）。✓
- **单王 vs 火箭 跟 2**：单小王 [1,0,16]、火箭 [0,2,300→用 rank 100]。splitDamage：火箭 0 < 单王 1 → **仍选火箭！** ✗

问题依旧：火箭"打光"使 splitDamage=0 永远最优。**根因是 splitDamage 用"剩余松散度"衡量，天然奖励打光**。要根治，splitDamage 必须**只在同牌力档内比较**，即 powerTier 必须**优先于** splitDamage：

`[ powerTier, splitDamage, tieRank ]`

- **单王 vs 火箭 跟 2**：单小王 powerTier=0、火箭 powerTier=2 → 选普通牌（单王）。✓
- **KKA 跟 Q**：出 A、出 K 都是普通牌 powerTier=0 → 比 splitDamage：出 A=0 < 出 K=2 → 出 A。✓
- **削长顺子 跟 3**：出 J、出 4 都 powerTier=0 → splitDamage：出 J=0 < 出 4≥1 → 出 J。✓
- **只有炸能压**（如手 3+7777 跟对 A）：唯一候选是炸 → powerTier=1 → 仍返回炸（能压就亮）。✓
- **非炸普通牌能压 vs 炸都能压且都不拆**：普通 powerTier=0 < 炸 1 → 普通优先。✓

**最终排序键（字典序最小优先）：`[ powerTier(普通0/炸1/火箭2), splitDamage=剩余孤张数, tieRank=rank ]`。** 这套同时满足：能压就亮（候选非空必返回）、优先普通牌不动炸火、同为普通牌时优先不拆、再取点数最小。

## 三、影响面

- src/ddz.js：
  - `structureScore` 改为 `decompose(cards).singles.length`。
  - `chooseHint` 跟牌排序键改为 `[powerTier, splitDamage, tieRank]`；新增 `powerTier(play)`（普通0/炸1/火箭2）。规则 0（一手走完）、自由出规则 3 不变。
- 现有 88 测试须通过；跟牌相关旧测试若期望随新键改变，按新正确行为更新（不得弱化）。
- 之前"非炸优先 key[1]"测试语义被 powerTier 覆盖（powerTier 已把非炸排在炸前），旧断言应仍成立或按新键更新。

## 四、测试策略

新增/更新单测（均确定性、纯函数）：
- KKA 跟单 Q → 出 `["A"]`（不拆对）。
- 手 `小王 大王` 跟单 2 → 出 `["x"]`（单小王，不出火箭；保留大王）。
- 手 `小王 大王` 跟单 2 的候选含火箭，但 powerTier 使单王优先。
- 削长顺子（4-9 六连 + J）跟单 3 → 出 `["J"]`（不拆顺）。
- 只有炸能压（3+7777 跟对 A）→ 出炸 `7777`（能压就亮）。
- 真要不起 → null。
- 规则 0 整手能压 → 全出。
- structureScore 单测：对子/三条/顺子不计惩罚，只数孤张（如 decompose 后 singles 数）。

## 五、非目标

- 不改自由出规则 3、规则 0、decompose 分解逻辑。
- 不做多步搜索/最优（仍启发式排序）。
- 不改部署、不加依赖；commit 不带 TRAE 署名。
