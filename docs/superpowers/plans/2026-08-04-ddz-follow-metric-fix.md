# 斗地主跟牌度量修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复跟牌提示的度量缺陷：`structureScore` 把对子当负担、排序让"打光"无脑最优，导致 KKA 拆对出 K、王炸手用火箭跟单 2。改为只数孤张 + 牌力档优先。

**Architecture:** 两处改动都在 src/ddz.js，且必须一起落地（否则测试互相矛盾），故为单一任务。`structureScore` 改为只数孤张；`chooseHint` 跟牌排序键改为 `[powerTier, splitDamage, tieRank]`，新增 `powerTier(play)`。

**Tech Stack:** JavaScript、Vitest。零依赖。

## Global Constraints

- 只改 `src/ddz.js` 的 `structureScore` 与 `chooseHint` 跟牌分支（含新增 `powerTier` 辅助）。规则 0（一手走完）、自由出规则 3、decompose、removeCardsArr、identifyPlay/beats/enumerateLegalPlays 不变。
- `structureScore(cards)` = `decompose(cards).singles.length`（只数孤张单牌；对/三条/顺子/连对/飞机/炸/火箭等成型组不计惩罚）。去掉原 `+ pairs.length*2`。
- 跟牌排序键（字典序最小优先）：`[ powerTier(play), splitDamage, tieRank ]`
  - `powerTier(play)`：普通牌型=0、炸弹=1、火箭=2（`const t = identifyPlay(play).type; return t === "rocket" ? 2 : t === "bomb" ? 1 : 0;`）。
  - `splitDamage` = `structureScore(removeCardsArr(hand, play))`（出牌后剩余孤张数）。
  - `tieRank` = `identifyPlay(play).rank`。
- 候选 = `enumerateLegalPlays(hand, last)`（含炸/火箭）；空 → 返回 null。能压就亮：候选非空必返回一手。
- 现有 88 测试须通过；跟牌相关旧测试若期望随新键改变，按新正确行为更新（不得弱化）。之前"非炸优先 key[1]"测试语义被 powerTier 覆盖，应仍成立或按新键更新。
- commit message 不得含 `Co-authored-by: TRAE CLI` 或任何 TRAE 署名（自动 `Change-Id:` 允许）。

---

### Task 1: structureScore 只数孤张 + 跟牌排序键改 [powerTier, splitDamage, tieRank]

**Files:**
- Modify: `src/ddz.js`（`structureScore` line ~335-339；`chooseHint` 跟牌分支 line ~355-382）
- Test: `test/ddz.test.js`

**Interfaces:**
- Consumes: 已有 `decompose`、`removeCardsArr`、`enumerateLegalPlays`、`identifyPlay`、`sortCards`。
- Produces: 修正后的 chooseHint 跟牌行为。

- [ ] **Step 1: 写失败测试（追加 `test/ddz.test.js`）**

在 chooseHint 相关 describe 附近追加：

```js
describe("chooseHint 跟牌度量修复", () => {
  it("KKA 跟单Q：出 A 不拆对", () => {
    // 出 A→剩 KK(对,0孤张)；出 K→剩 KA(2孤张) → 应出 A
    expect(chooseHint(["K", "K", "A"], ["Q"])).toEqual(["A"]);
  });

  it("手有双王跟单2：出单小王，不出火箭（留大王）", () => {
    // 单小王(普通牌型 powerTier0)能压单2；火箭 powerTier2 → 应出单小王
    expect(chooseHint(["x", "X"], ["2"])).toEqual(["x"]);
  });

  it("削长顺子回归：6连+孤J 跟单3 → 出 J 不拆顺", () => {
    const hand = ["4", "5", "6", "7", "8", "9", "J"];
    expect(chooseHint(hand, ["3"])).toEqual(["J"]);
  });

  it("只有炸能压 → 出炸（能压就亮）", () => {
    // 手 3 + 7777；上家对A：无普通牌能压对A，炸能 → 出 7777
    expect(chooseHint(["3", "7", "7", "7", "7"], ["A", "A"])).toEqual(["7", "7", "7", "7"]);
  });

  it("真要不起 → null", () => {
    expect(chooseHint(["3", "4"], ["2"])).toBeNull();
  });

  it("规则0整手能压 → 全出", () => {
    expect(chooseHint(["K", "K"], ["5", "5"])).toEqual(["K", "K"]);
  });
});

describe("structureScore 只数孤张（通过 chooseHint 间接验证）", () => {
  it("保留对子不算破坏：跟单牌时优先保留成型对", () => {
    // 手 3 3 4：上家出 单2？压不过。换：上家出 单K，手 A A 3 → 出3?3压不过K；出单A(拆对)剩A3；出对? 对不压单。
    // 直接用 KKA 已覆盖；此处补一个：手 5 5 6，上家出 单4 → 出 6(孤张,剩55对) 而非拆对出5
    expect(chooseHint(["5", "5", "6"], ["4"])).toEqual(["6"]);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/ddz.test.js`
Expected: FAIL（KKA 现出 K；双王现出火箭；`5 5 6` 现可能拆对——因旧度量 pairs*2）。

- [ ] **Step 3: 改 structureScore**

把 `src/ddz.js` 的 `structureScore`（line ~335-339）改为：
```js
function structureScore(cards) {
  const d = decompose(cards);
  // 只数孤张单牌：成型牌组（对/三条/顺子/连对/飞机/炸/火箭）是资产，不计惩罚
  return d.singles.length;
}
```

- [ ] **Step 4: 改 chooseHint 跟牌排序键**

把跟牌分支（line ~355-382）替换为：
```js
  if (last && last.length > 0) {
    // 跟牌：能压就亮。排序键 [powerTier(普通0/炸1/火箭2), splitDamage=剩余孤张数, tieRank] 字典序最小。
    // 先按牌力档（普通牌优先于炸/火箭，避免用大牌力跟小牌），再按少拆牌，再按点数最小。
    const candidates = enumerateLegalPlays(hand, last);
    if (candidates.length === 0) return null;
    const powerTier = (play) => {
      const t = identifyPlay(play).type;
      return t === "rocket" ? 2 : t === "bomb" ? 1 : 0;
    };
    let best = null;
    let bestKey = null;
    for (const play of candidates) {
      const key = [
        powerTier(play),
        structureScore(removeCardsArr(hand, play)),
        identifyPlay(play).rank,
      ];
      if (
        bestKey === null ||
        key[0] < bestKey[0] ||
        (key[0] === bestKey[0] && key[1] < bestKey[1]) ||
        (key[0] === bestKey[0] && key[1] === bestKey[1] && key[2] < bestKey[2])
      ) {
        best = play;
        bestKey = key;
      }
    }
    return sortCards(best);
  }
```

- [ ] **Step 5: 运行确认通过**

Run: `npx vitest run`
Expected: PASS（现有 88 + 新增）。若旧跟牌测试期望随新键变化，按新正确行为更新并在报告说明（不得弱化）。特别检查之前的"非炸优先 key[1] 判别测试"（手 3+7777 跟单5 → 出单7）：powerTier 下单7=0 < 炸7777=1 → 仍出单7 ✓。

- [ ] **Step 6: Commit**

```bash
git add src/ddz.js test/ddz.test.js
git commit -m "fix: 斗地主跟牌度量只数孤张，牌力档优先避免拆对/用火箭跟小牌"
```

---

## Self-Review

**Spec coverage:**
- structureScore 只数孤张、成型组不计 → Task 1 Step 3。✓
- 排序键 [powerTier, splitDamage, tieRank] → Task 1 Step 4。✓
- powerTier 普通0/炸1/火箭2 → Step 4 powerTier 函数。✓
- KKA 出 A、双王跟2 出小王、削顺出 J、只有炸出炸、要不起 null、规则0 全出 → Step 1 测试。✓
- 规则0/自由出/decompose 不变 → 仅改 structureScore + 跟牌分支。✓
- 88 测试保持 + 旧 key[1] 测试仍成立 → Step 5 说明。✓

**Placeholder scan:** 无 TODO/TBD；每步含完整代码。✓

**Type consistency:** `structureScore` 签名不变（仍 `(cards)→number`），仅返回值口径变；`powerTier(play)` 新增、在同分支使用一致；排序键三元组比较逻辑与原三元素结构一致（仅换语义）。✓

**已知风险（供 review triage）:**
- `5 5 6` 跟单 4 → 期望出 `["6"]`：出 6→剩 55(对,0孤张) splitDamage=0；出 5(拆对)→剩 5 6(2孤张) splitDamage=2；powerTier 同为0 → 出 6 ✓。实现后以实跑为准，若不符需核对 decompose 对 `5 6` 的分解（应为两孤张）。
- 双王 `x X` 跟单 2 期望 `["x"]`：候选应含单 x、单 X、火箭 xX。单 x powerTier0/splitDamage(剩X=1孤张)/rank16；单 X powerTier0/splitDamage1/rank17；火箭 powerTier2。→ 单 x 与单 X 同 powerTier0 同 splitDamage1，按 rank 16<17 → 出 x ✓。实现后以实跑为准。
