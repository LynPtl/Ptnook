# 斗地主跟牌哲学改动 + 取消选中按钮 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 跟牌提示改为"能压就亮（含要拆的）、优先不拆、同破坏度非炸优先、再取最小"；前端加「取消选中」按钮。

**Architecture:** Task 1 把 chooseHint 跟牌分支的旧规则 1/2 合并为单一排序（候选含炸弹/王炸，按 `[破坏度, 非炸优先, rank]` 字典序取最小）。Task 2 在前端出牌区加「取消选中」按钮清空高亮。规则 0、自由出规则 3、decompose、structureScore 不变。

**Tech Stack:** JavaScript、Vitest。零依赖。

## Global Constraints

- 只改 `src/ddz.js`（chooseHint 跟牌分支）与 `src/worker.js`（renderDdz playing 分支加按钮）。规则 0、自由出规则 3、decompose、structureScore、identifyPlay/beats/enumerateLegalPlays 不变。
- **跟牌新逻辑**（last 非空）：候选 = `enumerateLegalPlays(hand, last)`（含炸弹/王炸）；空 → 返回 null；否则取排序键 `[ structureScore(removeCardsArr(hand, play)), isBombOrRocket(play)?1:0, identifyPlay(play).rank ]` **字典序最小**的一手，返回 `sortCards(该手)`。
  - `isBombOrRocket(play)`：`const t = identifyPlay(play).type; return t === "bomb" || t === "rocket";`
  - 语义：能压就必然返回一手（不再因"要拆/要用炸"返回 null）；破坏度低者优先（不拆）；同破坏度普通牌优先于炸；再按 rank 最小。
- 规则 0（整手能压则全出）保持在跟牌逻辑之前，不变。
- **取消选中按钮**：出牌阶段（playing）且轮到自己时，出牌区加「取消选中」，点击 `ddz.selected = {}; renderHand();`，纯前端，不发消息。
- 现有 81 测试须通过；跟牌相关旧测试若期望随新逻辑改变，按新正确行为更新（不得弱化）。
- commit message 不得含 `Co-authored-by: TRAE CLI` 或任何 TRAE 署名（自动 `Change-Id:` 允许）。

## 文件结构

- `src/ddz.js`：Task 1 改 chooseHint 跟牌分支（现 line 355-383）。
- `test/ddz.test.js`：Task 1 单测。
- `src/worker.js`：Task 2 renderDdz playing 分支加按钮。

---

### Task 1: chooseHint 跟牌单一排序（能压就亮/优先不拆/非炸优先）

**Files:**
- Modify: `src/ddz.js`（chooseHint 的 `if (last && last.length > 0)` 分支，现 line 355-383）
- Test: `test/ddz.test.js`

**Interfaces:**
- Consumes: 已有 `enumerateLegalPlays`、`identifyPlay`、`structureScore`、`removeCardsArr`、`sortCards`。
- Produces: chooseHint 跟牌返回按新排序键选出的一手，或 null（真要不起）。

- [ ] **Step 1: 写失败测试（追加 `test/ddz.test.js`）**

在 `chooseHint` 相关 describe 附近追加：

```js
describe("chooseHint 跟牌新逻辑（能压就亮/优先不拆/非炸优先）", () => {
  it("有不拆的普通牌能压 → 出不拆的（破坏度优先）", () => {
    // 手: 6(孤张) + 8 9 10 J Q(顺子)；上家出 5 → 出 6，不拆顺子
    const hand = ["6", "8", "9", "10", "J", "Q"];
    expect(chooseHint(hand, ["5"])).toEqual(["6"]);
  });

  it("只有拆牌才能压 → 仍返回拆牌那手（能压就亮，不返回 null）", () => {
    // 手: 8 9 10 J Q(顺子)，无孤张；上家出 5 → 只能从顺子里拆一张压，应返回 8（最小能压且破坏度一致）
    const hand = ["8", "9", "10", "J", "Q"];
    const hint = chooseHint(hand, ["5"]);
    expect(hint).not.toBeNull();
    expect(hint).toEqual(["8"]);
  });

  it("同破坏度普通牌与炸弹都能压 → 出普通牌（非炸优先）", () => {
    // 手: 6(孤张) + 7 7 7 7(炸)；上家出 5 → 6 和炸都能压且都不拆(炸整出不算拆)，应出 6
    const hand = ["6", "7", "7", "7", "7"];
    expect(chooseHint(hand, ["5"])).toEqual(["6"]);
  });

  it("只有炸弹能压 → 亮炸弹", () => {
    // 手: 3 + 7 7 7 7；上家出对 A → 无普通牌能压对A，炸弹能压 → 出 7777
    const hand = ["3", "7", "7", "7", "7"];
    expect(chooseHint(hand, ["A", "A"])).toEqual(["7", "7", "7", "7"]);
  });

  it("真要不起 → null", () => {
    // 手: 3 4；上家出 2 → 压不过、整手也压不过 → null
    expect(chooseHint(["3", "4"], ["2"])).toBeNull();
  });

  it("规则0仍优先：整手能压则全出", () => {
    // 手: 一对 KK；上家出一对 5 → 全出 KK
    expect(chooseHint(["K", "K"], ["5", "5"])).toEqual(["K", "K"]);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/ddz.test.js`
Expected: FAIL（当前"只有拆牌才能压"会走规则2返回 null 或行为不符；"同破坏度非炸优先"当前逻辑因排除炸也恰好返回6，但"只有拆牌"用例应失败）。

- [ ] **Step 3: 替换 chooseHint 跟牌分支**

把现有跟牌分支（line 355-383 的整段 `if (last && last.length > 0) { ... }`）替换为：

```js
  if (last && last.length > 0) {
    // 跟牌：能压就亮（含要拆的）。排序键 [破坏度, 非炸优先, rank] 字典序最小。
    const candidates = enumerateLegalPlays(hand, last);
    if (candidates.length === 0) return null;
    const isBombOrRocket = (play) => {
      const t = identifyPlay(play).type;
      return t === "bomb" || t === "rocket";
    };
    let best = null;
    let bestKey = null;
    for (const play of candidates) {
      const key = [
        structureScore(removeCardsArr(hand, play)),
        isBombOrRocket(play) ? 1 : 0,
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

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run`
Expected: PASS（现有 81 + 新增 6）。若跟牌相关旧测试因新逻辑期望改变而失败，按新正确行为更新其期望并在报告说明（不得弱化）。

- [ ] **Step 5: Commit**

```bash
git add src/ddz.js test/ddz.test.js
git commit -m "feat: 斗地主跟牌提示改为能压就亮、优先不拆、非炸优先"
```

---

### Task 2: 前端「取消选中」按钮

**Files:**
- Modify: `src/worker.js`（renderDdz 的 playing 分支）
- Test: 无（纯前端，静态 hook + 手动冒烟）

**Interfaces:**
- Consumes: 现有 `ddz.selected`、`renderHand`、`addBtn`。
- Produces: 出牌阶段轮到自己时多一个「取消选中」按钮。

- [ ] **Step 1: 在 playing 分支加按钮**

找到 renderDdz 的 playing 分支（现有「出牌」「提示」「过」处），改为：
```js
    } else if (state.phase === "playing") {
      if (state.current === me) {
        addBtn("出牌", playSelected);
        addBtn("提示", function () {
          var now = Date.now();
          if (now - lastHintAt < 800) return;
          lastHintAt = now;
          ddzSend("ddz_hint");
        });
        addBtn("取消选中", function () { ddz.selected = {}; renderHand(); });
        addBtn("过", function () { ddzSend("ddz_pass"); });
      }
    } else if (state.phase === "settled") {
```
（保持提示按钮的 800ms 节流不变；只在「提示」与「过」之间插入「取消选中」。）

- [ ] **Step 2: 运行全部测试确认未回归**

Run: `npx vitest run`
Expected: PASS（前端字符串改动不影响服务端测试，仍全绿）。

- [ ] **Step 3: 静态校验 hook**

Run:
```bash
grep -n 'addBtn("取消选中"' src/worker.js
```
Expected: 有匹配。交互式浏览器冒烟 NOT RUN（沙箱），如实记录。

- [ ] **Step 4: 本地冒烟（用户执行）**

`npx wrangler dev`：出牌阶段选几张牌 → 点【取消选中】→ 高亮全部清除；提示/出牌/过照常。

- [ ] **Step 5: Commit**

```bash
git add src/worker.js
git commit -m "feat: 斗地主出牌区加取消选中按钮"
```

---

## Self-Review

**Spec coverage:**
- 跟牌候选含炸/王、空→null、按 [破坏度,非炸优先,rank] 取最小 → Task 1。✓
- 能压就亮（要拆也亮，不返回 null）→ Task 1（候选非空必返回一手）+ "只有拆牌才能压"测试。✓
- 优先不拆（破坏度键）、同破坏度非炸优先、再最小 → Task 1 排序键三元组。✓
- 规则 0 一手走完不变 → Task 1 保留 line 349-353 之前逻辑，未动。✓
- 自由出规则 3 / decompose / structureScore 不变 → 仅改跟牌分支。✓
- 取消选中按钮清空 ddz.selected + renderHand，纯前端 → Task 2。✓
- 81 测试保持 + 新增跟牌用例 → Task 1。✓

**Placeholder scan:** 无 TODO/TBD；每步含完整代码。✓

**Type consistency:** `structureScore`/`removeCardsArr`/`identifyPlay` 均为现有函数，签名一致；chooseHint 跟牌返回 `sortCards(best)` 或 null 与既有一致；`ddz.selected`/`renderHand`/`addBtn`/`lastHintAt` 均为前端现有符号。✓

**已知风险/取舍（供 review triage）:**
- "只有拆牌才能压"测试用手牌 `8 9 10 J Q` 上家出 `5`，预期返回 `["8"]`：候选是 8/9/10/J/Q 各单张（均拆顺子、破坏度相同），按 rank 最小取 8。实现时若 structureScore 对这些的散牌数计算一致则成立；实现后以实际为准，若不为 `["8"]` 需核对 structureScore 行为（不弱化测试）。
- "同破坏度非炸优先"测试 `6 + 7777` 上家出 `5`：出 6（破坏度：剩 7777 一个炸=0散牌）vs 出 7777（剩 6 一个散牌=1）——实际破坏度可能不同（出炸后剩散牌更多），则非炸优先键未必被触发，但结果仍应是 6。实现后以实际为准；关键断言（返回 6、只有炸时返回炸、能压就亮）不弱化。
