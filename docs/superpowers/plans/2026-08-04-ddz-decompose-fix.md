# 斗地主提示分解与自由出修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复提示 bug：decompose 贪心拆散对子/三条去凑坏顺子导致假孤张，自由出把 Q 当垃圾推荐。改为顺子/连对只用"纯料"，自由出无孤张时出最小成型组（排除炸/王/含2）。

**Architecture:** 两处改动都在 src/ddz.js。Task 1 给 decompose 的顺子/连对提取加"纯料"约束（顺子只用当层剩余恰好 1 张的点数、连对只用恰好 2 张的点数），不拆对/三条/炸。Task 2 改 chooseHint 自由出的成型组兜底：排除炸弹/王炸/含 2 的组取最小，别无选择才出被排除的。

**Tech Stack:** JavaScript、Vitest。零依赖。

## Global Constraints

- 只改 `src/ddz.js` 的 `decompose` 与 `chooseHint`。identifyPlay/beats/enumerateLegalPlays/pickHint/structureScore 不变。src/worker.js 不改。
- 提取顺序维持：王炸 → 炸弹 → 飞机 → 顺子 → 连对 → 三条 → 对 → 单。
- **顺子纯料**：提顺子时，只用"当层 pool 剩余张数**恰好 1**"的点数参与连（对子/三条/炸的点数不进顺子）。
- **连对纯料**：提连对时，只用"当层 pool 剩余张数**恰好 2**"的点数参与连（三条/炸的点数不借一对给连对）。
- 顺子仍需 ≥5 连、连对仍需 ≥3 连、均不含 2/王（值 <15），最长优先。
- **chooseHint 自由出（last 空）规则 3**：有真孤张 → 最小孤张；无孤张有孤对 → 最小孤对；全是成型组 → 取最小成型组但**排除 type 为 bomb/rocket 的组、以及 cards 含 "2" 的组**；若排除后无组可选，则在被排除集合里取最小兜底。
- 现有 74 测试须通过；依赖 decompose 的旧测试若期望随新规则改变，按新正确行为更新（不得弱化为无意义断言）。
- commit message 不得含 `Co-authored-by: TRAE CLI` 或任何 TRAE 署名（自动 `Change-Id:` 允许）。

## 文件结构

- `src/ddz.js`：Task 1 改 decompose 顺子/连对循环；Task 2 改 chooseHint 自由出成型组兜底。
- `test/ddz.test.js`：Task 1/2 单测。

---

### Task 1: decompose 顺子/连对纯料约束

**Files:**
- Modify: `src/ddz.js`（decompose 的顺子循环 line ~271、连对循环 line ~289）
- Test: `test/ddz.test.js`

**Interfaces:**
- Consumes: 已有 decompose 内部结构（cnt/removeCards/RANK_VALUE）。
- Produces: decompose 输出——顺子/连对不再拆散对/三条/炸；被拆出的假孤张消失。

- [ ] **Step 1: 写失败测试（追加 `test/ddz.test.js`）**

```js
describe("decompose 纯料约束（不拆对/三条凑顺子）", () => {
  it("三条不被顺子借走：QQQ 保留为三条", () => {
    // 8 9 10 J Q Q Q K A：Q 有三张，不应被顺子借走一张
    const d = decompose(["8", "9", "10", "J", "Q", "Q", "Q", "K", "A"]);
    expect(d.groups.some((g) => g.type === "triple" && g.cards.join() === "Q,Q,Q")).toBe(true);
    // Q 不应作为孤张出现在 singles
    expect(d.singles).not.toContain("Q");
  });

  it("bug 手牌：不产生假孤张 Q，QQQ 成三条", () => {
    const hand = ["6", "6", "6", "8", "9", "9", "10", "10", "J", "J", "Q", "Q", "Q", "K", "K", "A", "A", "2", "2", "x"];
    const d = decompose(hand);
    expect(d.singles).not.toContain("Q");
    expect(d.groups.some((g) => g.type === "triple" && g.cards.join() === "Q,Q,Q")).toBe(true);
    expect(d.groups.some((g) => g.type === "triple" && g.cards.join() === "6,6,6")).toBe(true);
  });

  it("对子不被顺子借走：只用单张料成顺", () => {
    // 3 4 5 6 7 7：7 有两张（对料），顺子只能用单张 3 4 5 6 + 一个7？
    // 纯料规则：7 出现2次 → 不进顺子 → 3-6 仅4连 <5 → 不成顺子 → 3 4 5 6 皆孤张，77 为孤对
    const d = decompose(["3", "4", "5", "6", "7", "7"]);
    expect(d.groups.some((g) => g.type === "straight")).toBe(false);
    expect(d.pairs.some((p) => p.join() === "7,7")).toBe(true);
    expect(d.singles).toEqual(["3", "4", "5", "6"]);
  });

  it("纯单张料仍能成顺子", () => {
    // 3 4 5 6 7 全单张 → 顺子
    const d = decompose(["3", "4", "5", "6", "7"]);
    expect(d.groups.some((g) => g.type === "straight" && g.cards.length === 5)).toBe(true);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/ddz.test.js`
Expected: FAIL（现有 decompose 会把 Q 拆成孤张、会用对料凑顺子）。

- [ ] **Step 3: 修改 decompose 顺子/连对循环**

把顺子循环（现 line ~271-287）的 `avail` 过滤改为**只取剩余恰好 1 张**的点数：
```js
  // 4) 顺子（≥5 连续单张，不含 2/王），只用剩余恰好1张的点数（不拆对/三条/炸）
  for (;;) {
    const m = cnt();
    const avail = [...m.entries()].filter(([, k]) => k === 1).map(([c]) => RANK_VALUE[c]).filter((v) => v < 15).sort((a, b) => a - b);
    let best = [];
    for (let i = 0; i < avail.length; i++) {
      let run = [avail[i]];
      for (let j = i + 1; j < avail.length; j++) {
        if (avail[j] === run[run.length - 1] + 1) run.push(avail[j]);
        else break;
      }
      if (run.length > best.length) best = run;
    }
    if (best.length < 5) break;
    const cards = best.map((v) => Object.keys(RANK_VALUE).find((k) => RANK_VALUE[k] === v));
    groups.push({ type: "straight", cards });
    pool = removeCards(pool, cards);
  }
```
把连对循环（现 line ~289-309）的过滤从 `k >= 2` 改为 **`k === 2`**（只用恰好一对的料）：
```js
  // 5) 连对（≥3 连续对子，不含 2/王），只用剩余恰好2张的点数（不借三条/炸）
  for (;;) {
    const m = cnt();
    const pairRanks = [...m.entries()].filter(([, k]) => k === 2).map(([c]) => RANK_VALUE[c]).filter((v) => v < 15).sort((a, b) => a - b);
    let best = [];
    for (let i = 0; i < pairRanks.length; i++) {
      let run = [pairRanks[i]];
      for (let j = i + 1; j < pairRanks.length; j++) {
        if (pairRanks[j] === run[run.length - 1] + 1) run.push(pairRanks[j]);
        else break;
      }
      if (run.length > best.length) best = run;
    }
    if (best.length < 3) break;
    const cards = [];
    for (const v of best) {
      const c = Object.keys(RANK_VALUE).find((k) => RANK_VALUE[k] === v);
      cards.push(c, c);
    }
    groups.push({ type: "pair_straight", cards });
    pool = removeCards(pool, cards);
  }
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/ddz.test.js`
Expected: PASS。若已有旧 decompose 测试因新规则期望变化而失败，按新正确分解更新其期望（不得弱化）。

- [ ] **Step 5: 运行全部测试**

Run: `npx vitest run`
Expected: PASS（现有 74 + 新增；若旧 chooseHint/decompose 测试期望需随新分解更新，一并更新并说明）。

- [ ] **Step 6: Commit**

```bash
git add src/ddz.js test/ddz.test.js
git commit -m "fix: 斗地主 decompose 顺子/连对只用纯料，不拆对子三条凑坏顺子"
```

---

### Task 2: chooseHint 自由出成型组兜底排除炸/王/含2

**Files:**
- Modify: `src/ddz.js`（chooseHint 自由出分支的"取最小成型组"部分，现 line ~398-401）
- Test: `test/ddz.test.js`

**Interfaces:**
- Consumes: decompose（Task 1 已改）、identifyPlay、RANK_VALUE。
- Produces: 自由出无孤张时，出最小成型组但避开炸/王/含2的组。

- [ ] **Step 1: 写失败测试（追加 `test/ddz.test.js`）**

```js
describe("chooseHint 自由出成型组选择", () => {
  it("bug 手牌自由出不再出 Q", () => {
    const hand = ["6", "6", "6", "8", "9", "9", "10", "10", "J", "J", "Q", "Q", "Q", "K", "K", "A", "A", "2", "2", "x"];
    const hint = chooseHint(hand, null);
    expect(hint).not.toEqual(["Q"]);
    // 应出真孤张（8 或 小王中最小者 = 8）
    expect(hint).toEqual(["8"]);
  });

  it("全成型组时出最小组，排除炸弹", () => {
    // 手: 5 5 5 5(炸) + 7 7 8 8 9 9(连对) → 无孤张无孤对；应出连对(最小组)，不出炸
    const hand = ["5", "5", "5", "5", "7", "7", "8", "8", "9", "9"];
    const hint = chooseHint(hand, null);
    // 连对 7-9 是最小成型组（非炸）→ 出它，而不是炸 5555
    expect(hint).toEqual(["7", "7", "8", "8", "9", "9"]);
  });

  it("含2的组被排除，优先出不含2的组", () => {
    // 手: 2 2 2(三条含2) + 3 3 3(三条) → 应出 333 而非 222（留2控场）
    const hand = ["3", "3", "3", "2", "2", "2"];
    const hint = chooseHint(hand, null);
    expect(hint).toEqual(["3", "3", "3"]);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/ddz.test.js`
Expected: FAIL（现自由出成型组兜底不排除炸/王/含2；bug 手牌经 Task1 后已不出 Q，但"排除炸/含2组"仍未实现，第2、3条会失败）。

- [ ] **Step 3: 修改 chooseHint 自由出成型组兜底**

把现有（line ~398-401）：
```js
  let best = d.groups[0];
  const minRankOf = (g) => Math.min(...g.cards.map((c) => RANK_VALUE[c]));
  for (const g of d.groups) if (minRankOf(g) < minRankOf(best)) best = g;
  return sortCards(best.cards);
```
改为（排除炸/王/含2的组，别无选择才用被排除的）：
```js
  const minRankOf = (g) => Math.min(...g.cards.map((c) => RANK_VALUE[c]));
  const isReserved = (g) => g.type === "bomb" || g.type === "rocket" || g.cards.includes("2");
  const preferred = d.groups.filter((g) => !isReserved(g));
  const pickFrom = preferred.length > 0 ? preferred : d.groups;
  let best = pickFrom[0];
  for (const g of pickFrom) if (minRankOf(g) < minRankOf(best)) best = g;
  return sortCards(best.cards);
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run`
Expected: PASS（现有 + 新增全绿）。

- [ ] **Step 5: 本地冒烟（用户执行）**

`npx wrangler dev`：用 bug 手牌开局自由出点提示，应不再建议出 Q（应出最小真孤张/最小对）；全对/三条的开局提示先出最小对、不先出炸和含2组。

- [ ] **Step 6: Commit**

```bash
git add src/ddz.js test/ddz.test.js
git commit -m "fix: 斗地主自由出无孤张时出最小成型组，排除炸弹王炸含2组"
```

---

## Self-Review

**Spec coverage:**
- 顺子只用剩余恰好1张的料 → Task 1 straight 循环 `k === 1`。✓
- 连对只用恰好2张的料 → Task 1 pair_straight 循环 `k === 2`。✓
- 提取顺序维持、顺子≥5/连对≥3/不含2王 → Task 1 保留原结构，仅改料过滤。✓
- 自由出有孤张→最小孤张、有孤对→最小孤对 → 现有逻辑不变（line 387-396）。✓
- 自由出全成型组→排除炸/王/含2取最小，别无选择才用 → Task 2。✓
- bug 手牌回归（不出 Q、QQQ 成三条）→ Task 1/2 测试。✓
- 74 测试保持，旧测试按新分解更新 → Task 1 Step 4/5 说明。✓
- worker.js/引擎其余不变 → 仅改 decompose/chooseHint。✓

**Placeholder scan:** 无 TODO/TBD；每步含完整代码。✓

**Type consistency:** decompose 返回 `{groups:[{type,cards}],pairs,singles}` 结构不变，Task 2 消费 `g.type`/`g.cards` 一致；chooseHint 返回令牌数组一致。✓

**已知取舍/风险（供 review triage）:**
- Task 1 的"对子不被顺子借走"测试（3 4 5 6 7 7）假设纯料规则下 7 不进顺子、3-6 不足 5 连 → 无顺子。这是新规则的**正确预期**，但也意味着"该拆对凑长顺"的高级打法不会被采纳（spec 明确接受此保守取舍）。
- 纯料约束可能让一些"本可成顺子"的手牌不再识别为顺子（当关键连接点是对/三条料时）——符合"不拆成组强牌"的设计意图，但可能有旧 decompose 测试需按新行为更新期望。
- "含2的组"用 `g.cards.includes("2")` 判断——三条 222、或（本引擎中）任何含2令牌的组；顺子/连对本就不含2（<15 约束），故主要作用于三条 222。
