# 斗地主提示策略升级（A 档启发式）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「提示」从"能压过的最小一手"升级为 A 档启发式：残局一手走完、跟牌不拆成型牌组且留炸、自由出先清散牌，只看自己手牌。

**Architecture:** 新增两个纯函数放 src/ddz.js：`decompose(hand)` 贪心把手牌分解为成型牌组/孤对/孤张；`chooseHint(hand, last)` 按优先级规则选一手。DO 的 `ddz_hint` 分支改调 `chooseHint`。引擎其余不变。

**Tech Stack:** JavaScript、Cloudflare Workers、Durable Objects、Vitest。零依赖。

## Global Constraints

- 只改 `src/ddz.js`（加 decompose + chooseHint + 单测）与 `src/worker.js`（ddz_hint 分支改调 chooseHint）。现有 60 测试须全绿。
- 令牌与排序沿用现有：RANK_VALUE、sortCards、identifyPlay、beats、enumerateLegalPlays 不改。小王 "x"、大王 "X"。
- `decompose(hand)`：贪心提取顺序 **王炸/炸弹 → 飞机(≥2连三) → 顺子(≥5) → 连对(≥3) → 三条 → 对 → 单**，逐层从剩余牌最长优先提取。返回 `{ groups: [{type, cards}], pairs: [[c,c],...], singles: [c,...] }`：`groups` 是成型牌组（含炸弹/飞机/顺子/连对/三条），`pairs` 是剩下的孤对，`singles` 是剩下的孤张。纯函数。
- `chooseHint(hand, last)`：返回一手令牌数组或 null。按优先级：
  - **规则 0**：`identifyPlay(hand)` 非空且（last 空 或 `beats(hand,last)`）→ 返回整手 hand。
  - **跟牌（last 非空）**：候选 = `enumerateLegalPlays(hand, last)`。
    - **规则 1**：排除 bomb/rocket 后的候选中，选"破坏度最低、并列 rank 最小"的一手（破坏度定义见 Task 2）。有则返回。
    - **规则 2**：若规则 1 无非炸候选，候选中有炸弹 → 返回 rank 最小的炸弹；否则有 rocket → 返回 rocket；都无 → null。
  - **自由出（last 空）规则 3**：`decompose(hand)` 后依次取：最小孤张单牌 → 最小孤对 → 点数最小的成型组。不调用 enumerateLegalPlays（规避 O(2^n)）。
- DO ddz_hint：保留 phase/current 守卫；`const hint = chooseHint(hand, last);` → `!hint` 回 ddzErr「没有能压过的牌，只能过」，否则 `ws.send({type:"ddz_hint", cards: sortCards(hint)})`。
- commit message 不得含 `Co-authored-by: TRAE CLI` 或任何 TRAE 署名（自动 `Change-Id:` 允许）。

## 文件结构

- `src/ddz.js`：Task 1 加 `decompose`，Task 2 加 `chooseHint`。
- `test/ddz.test.js`：Task 1/2 单测。
- `src/worker.js` + `test/room.test.js`：Task 3 改 ddz_hint + DO 断言。

---

### Task 1: decompose(hand) 贪心手牌分解 + 单测

**Files:**
- Modify: `src/ddz.js`
- Test: `test/ddz.test.js`

**Interfaces:**
- Consumes: 已有 `RANK_VALUE`、`sortCards`、`identifyPlay`（同文件私有 `counts` 等可复用；如需可新增私有辅助）。
- Produces: `decompose(hand): { groups: Array<{type:string, cards:string[]}>, pairs: string[][], singles: string[] }`。
  - groups：成型牌组（bomb/rocket/plane/straight/pair_straight/triple）。
  - pairs：未进 groups 的孤对（每项 `[c,c]`）。
  - singles：未进任何组的孤张（升序）。

- [ ] **Step 1: 写失败测试（追加 `test/ddz.test.js`）**

顶部 import 追加 `decompose`。追加：

```js
describe("decompose", () => {
  it("提取顺子后剩散单", () => {
    // 3 4 5 6 7 顺子 + 9 孤张
    const d = decompose(["3", "4", "5", "6", "7", "9"]);
    expect(d.groups.some((g) => g.type === "straight" && g.cards.length === 5)).toBe(true);
    expect(d.singles).toContain("9");
  });
  it("对子与孤张区分", () => {
    // 8 8 对 + 5 孤张（无顺子/连对）
    const d = decompose(["8", "8", "5"]);
    expect(d.pairs.some((p) => p[0] === "8" && p[1] === "8")).toBe(true);
    expect(d.singles).toEqual(["5"]);
  });
  it("炸弹进 groups", () => {
    const d = decompose(["9", "9", "9", "9", "3"]);
    expect(d.groups.some((g) => g.type === "bomb")).toBe(true);
    expect(d.singles).toContain("3");
  });
  it("三条进 groups", () => {
    const d = decompose(["7", "7", "7", "4"]);
    expect(d.groups.some((g) => g.type === "triple")).toBe(true);
    expect(d.singles).toContain("4");
  });
  it("连对进 groups", () => {
    // 3 3 4 4 5 5 连对
    const d = decompose(["3", "3", "4", "4", "5", "5"]);
    expect(d.groups.some((g) => g.type === "pair_straight")).toBe(true);
    expect(d.pairs.length).toBe(0);
    expect(d.singles.length).toBe(0);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/ddz.test.js`
Expected: FAIL（`decompose is not a function`）。

- [ ] **Step 3: 实现（追加到 `src/ddz.js`）**

```js
// 贪心把手牌分解为成型牌组 / 孤对 / 孤张
export function decompose(hand) {
  let pool = sortCards(hand);
  const groups = [];

  const removeCards = (arr, cards) => {
    const p = arr.slice();
    for (const c of cards) { const i = p.indexOf(c); if (i >= 0) p.splice(i, 1); }
    return p;
  };
  const cnt = () => {
    const m = new Map();
    for (const c of pool) m.set(c, (m.get(c) || 0) + 1);
    return m;
  };

  // 1) 王炸
  if (pool.includes("x") && pool.includes("X")) {
    groups.push({ type: "rocket", cards: ["x", "X"] });
    pool = removeCards(pool, ["x", "X"]);
  }
  // 2) 炸弹
  for (;;) {
    const m = cnt();
    let bomb = null;
    for (const [c, k] of m) if (k === 4) { bomb = c; break; }
    if (!bomb) break;
    groups.push({ type: "bomb", cards: [bomb, bomb, bomb, bomb] });
    pool = removeCards(pool, [bomb, bomb, bomb, bomb]);
  }
  // 3) 飞机（≥2 连续三条），最长优先
  for (;;) {
    const m = cnt();
    const trips = [...m.entries()].filter(([, k]) => k >= 3).map(([c]) => RANK_VALUE[c]).sort((a, b) => a - b);
    let best = [];
    for (let i = 0; i < trips.length; i++) {
      let run = [trips[i]];
      for (let j = i + 1; j < trips.length; j++) {
        if (trips[j] === run[run.length - 1] + 1 && trips[j] < 15) run.push(trips[j]);
        else break;
      }
      if (run.length > best.length) best = run;
    }
    if (best.length < 2) break;
    const cards = [];
    for (const v of best) {
      const c = Object.keys(RANK_VALUE).find((k) => RANK_VALUE[k] === v);
      cards.push(c, c, c);
    }
    groups.push({ type: "plane", cards });
    pool = removeCards(pool, cards);
  }
  // 4) 顺子（≥5 连续单张，不含 2/王），最长优先
  for (;;) {
    const m = cnt();
    const avail = [...m.keys()].map((c) => RANK_VALUE[c]).filter((v) => v < 15).sort((a, b) => a - b);
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
  // 5) 连对（≥3 连续对子，不含 2/王），最长优先
  for (;;) {
    const m = cnt();
    const pairRanks = [...m.entries()].filter(([, k]) => k >= 2).map(([c]) => RANK_VALUE[c]).filter((v) => v < 15).sort((a, b) => a - b);
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
  // 6) 三条
  for (;;) {
    const m = cnt();
    let trip = null;
    for (const [c, k] of m) if (k === 3) { trip = c; break; }
    if (!trip) break;
    groups.push({ type: "triple", cards: [trip, trip, trip] });
    pool = removeCards(pool, [trip, trip, trip]);
  }
  // 7) 剩余对子（孤对）
  const pairs = [];
  for (;;) {
    const m = cnt();
    let pr = null;
    for (const [c, k] of m) if (k === 2) { pr = c; break; }
    if (!pr) break;
    pairs.push([pr, pr]);
    pool = removeCards(pool, [pr, pr]);
  }
  // 8) 剩余孤张
  const singles = sortCards(pool);
  return { groups, pairs, singles };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/ddz.test.js`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/ddz.js test/ddz.test.js
git commit -m "feat: 斗地主 decompose 贪心手牌分解"
```

---

### Task 2: chooseHint(hand, last) 启发式提示选择 + 单测

**Files:**
- Modify: `src/ddz.js`
- Test: `test/ddz.test.js`

**Interfaces:**
- Consumes: `decompose`（Task 1）、`identifyPlay`、`beats`、`enumerateLegalPlays`、`sortCards`、`RANK_VALUE`。
- Produces: `chooseHint(hand, last): string[] | null`。

- [ ] **Step 1: 写失败测试（追加 `test/ddz.test.js`）**

顶部 import 追加 `chooseHint`。追加：

```js
describe("chooseHint", () => {
  it("规则0：能一手走完就全出（自由出，整手是顺子）", () => {
    const hand = ["3", "4", "5", "6", "7"];
    expect(chooseHint(hand, null)).toEqual(["3", "4", "5", "6", "7"]);
  });
  it("规则0：跟牌能一手压过就全出", () => {
    // 手里就一对 KK，上家出一对 5 → 全出 KK
    expect(chooseHint(["K", "K"], ["5", "5"])).toEqual(["K", "K"]);
  });
  it("规则1：跟单张时用孤张而非拆顺子", () => {
    // 手: 6(孤张) + 8 9 10 J Q(顺子)；上家出 5 → 应出 6，不拆顺子
    const hand = ["6", "8", "9", "10", "J", "Q"];
    expect(chooseHint(hand, ["5"])).toEqual(["6"]);
  });
  it("规则2：只有炸弹能压才出炸", () => {
    // 手: 三个... 用四张 7 作炸；上家出对 A，手里没有更大的对 → 出炸弹 7777
    const hand = ["7", "7", "7", "7", "3"];
    expect(chooseHint(hand, ["A", "A"])).toEqual(["7", "7", "7", "7"]);
  });
  it("要不起返回 null", () => {
    // 手: 3 4，上家出 2 → 压不过，且非整手可压 → null
    expect(chooseHint(["3", "4"], ["2"])).toBeNull();
  });
  it("规则3：自由出先出最小孤张", () => {
    // 手: 3(孤张) + 8 8(对) + 9 9 9(三条)；自由出 → 出 3
    const hand = ["3", "8", "8", "9", "9", "9"];
    expect(chooseHint(hand, null)).toEqual(["3"]);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/ddz.test.js`
Expected: FAIL（`chooseHint is not a function`）。

- [ ] **Step 3: 实现（追加到 `src/ddz.js`）**

```js
// 破坏度：出 play 后，剩余手牌的“成型牌组数”减少越多越差；散张增多也算破坏
function structureScore(cards) {
  const d = decompose(cards);
  // 成型牌组数（顺子/连对/飞机/三条/炸弹/火箭），越多越好；散张越少越好
  return { groups: d.groups.length, loose: d.pairs.length + d.singles.length };
}
function removeCardsArr(hand, cards) {
  const p = hand.slice();
  for (const c of cards) { const i = p.indexOf(c); if (i >= 0) p.splice(i, 1); }
  return p;
}

export function chooseHint(hand, last) {
  if (!hand || hand.length === 0) return null;

  // 规则 0：能一手走完
  const whole = identifyPlay(hand);
  if (whole && (!last || last.length === 0 || beats(hand, last))) {
    return sortCards(hand);
  }

  if (last && last.length > 0) {
    // 跟牌
    const candidates = enumerateLegalPlays(hand, last);
    if (candidates.length === 0) return null;
    const nonBomb = candidates.filter((c) => {
      const t = identifyPlay(c).type;
      return t !== "bomb" && t !== "rocket";
    });
    if (nonBomb.length > 0) {
      // 规则 1：破坏度最低、并列 rank 最小
      const base = structureScore(hand).groups;
      let best = null, bestLoss = Infinity, bestRank = Infinity;
      for (const play of nonBomb) {
        const after = structureScore(removeCardsArr(hand, play));
        const loss = base - after.groups; // 拆掉成型组数（越小越好）
        const rank = identifyPlay(play).rank;
        if (loss < bestLoss || (loss === bestLoss && rank < bestRank)) {
          best = play; bestLoss = loss; bestRank = rank;
        }
      }
      return sortCards(best);
    }
    // 规则 2：只有炸弹/火箭能压
    const bombs = candidates.filter((c) => identifyPlay(c).type === "bomb");
    if (bombs.length > 0) {
      bombs.sort((a, b) => identifyPlay(a).rank - identifyPlay(b).rank);
      return sortCards(bombs[0]);
    }
    const rocket = candidates.find((c) => identifyPlay(c).type === "rocket");
    return rocket ? sortCards(rocket) : null;
  }

  // 自由出 规则 3：先清散牌
  const d = decompose(hand);
  if (d.singles.length > 0) {
    // 最小孤张（singles 已升序）
    return [d.singles[0]];
  }
  if (d.pairs.length > 0) {
    // 最小孤对
    let best = d.pairs[0];
    for (const p of d.pairs) if (RANK_VALUE[p[0]] < RANK_VALUE[best[0]]) best = p;
    return best.slice();
  }
  // 只剩成型组：取点数最小的一组
  let best = d.groups[0];
  const minRankOf = (g) => Math.min(...g.cards.map((c) => RANK_VALUE[c]));
  for (const g of d.groups) if (minRankOf(g) < minRankOf(best)) best = g;
  return sortCards(best.cards);
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run`
Expected: PASS（现有 60 + decompose + chooseHint 全绿）。

- [ ] **Step 5: Commit**

```bash
git add src/ddz.js test/ddz.test.js
git commit -m "feat: 斗地主 chooseHint 启发式提示选择"
```

---

### Task 3: DO ddz_hint 改调 chooseHint

**Files:**
- Modify: `src/worker.js`（import 追加 `chooseHint`；ddz_hint 分支改用 chooseHint）
- Test: `test/room.test.js`（更新/新增 ddz_hint 断言）

**Interfaces:**
- Consumes: `src/ddz.js` 的 `chooseHint`。
- Produces: ddz_hint 回传按启发式策略选出的一手。

- [ ] **Step 1: 改 import 与 ddz_hint 分支**

`src/worker.js` 顶部 import 追加 `chooseHint`：
```js
import { makeDeck, deal, sortCards, resolveBids, identifyPlay, beats, computeScores, enumerateLegalPlays, pickHint, chooseHint } from "./ddz.js";
```

把现有 ddz_hint 分支（phase/current 守卫之后）改为：
```js
    if (msg.type === "ddz_hint") {
      if (g.phase !== "playing") { this.ddzErr(ws, "现在不能提示"); return; }
      if (nick !== g.current) { this.ddzErr(ws, "还没轮到你"); return; }
      const hand = g.hands[nick] || [];
      const last = g.lastPlay ? g.lastPlay.cards : null;
      const hint = chooseHint(hand, last);
      if (!hint) { this.ddzErr(ws, "没有能压过的牌，只能过"); return; }
      try { ws.send(JSON.stringify({ type: "ddz_hint", cards: sortCards(hint) })); } catch {}
      return;
    }
```
（`pickHint`/`enumerateLegalPlays` 若不再被 worker.js 直接使用，import 中可保留不删——不影响；实际提示逻辑改由 chooseHint 承担。）

- [ ] **Step 2: 更新 ddz_hint 的 DO 测试（`test/room.test.js`）**

现有两条 ddz_hint 测试（跟单张→建议、要不起→ddz_error）在新策略下应仍成立：跟单张 `["5"]`、手 `["3","6","6","9"]` → chooseHint 规则1 应给 `["6"]`（孤张，不拆）；要不起用例不变。若现有断言的期望牌与 chooseHint 输出不一致，按 chooseHint 的正确行为更新期望（不得弱化为无意义断言）。新增一条自由出提示断言：
```js
  it("提示：自由出时建议最小孤张", async () => {
    const room = "hint-lead";
    const a = await openWSCollect(room, "A");
    a.ws.send(JSON.stringify({ type: "ddz_start" }));
    await new Promise((r) => setTimeout(r, 50));
    const b = await openWSCollect(room, "B");
    b.ws.send(JSON.stringify({ type: "ddz_join" }));
    await new Promise((r) => setTimeout(r, 40));
    const c = await openWSCollect(room, "C");
    c.ws.send(JSON.stringify({ type: "ddz_join" }));
    await new Promise((r) => setTimeout(r, 100));
    const id = env.CHAT_ROOM.idFromName(room);
    const stub = env.CHAT_ROOM.get(id);
    await runInDurableObject(stub, async (instance, state) => {
      const g = await state.storage.get("ddz");
      g.phase = "playing"; g.current = "A";
      g.hands["A"] = ["3", "8", "8", "9", "9", "9"];
      g.lastPlay = null; // 自由出
      await state.storage.put("ddz", g);
    });
    a.msgs.length = 0;
    a.ws.send(JSON.stringify({ type: "ddz_hint" }));
    await new Promise((r) => setTimeout(r, 80));
    const hint = a.msgs.filter((m) => m.type === "ddz_hint").pop();
    expect(hint.cards).toEqual(["3"]);
    a.ws.close(); b.ws.close(); c.ws.close();
  });
```

- [ ] **Step 3: 运行全部测试确认通过**

Run: `npx vitest run`
Expected: PASS（现有 + 新增；如更新了旧 ddz_hint 期望，确认更新后通过）。

- [ ] **Step 4: 静态校验**

Run:
```bash
grep -n "chooseHint" src/worker.js
```
Expected: import 与 ddz_hint 分支各有匹配。交互式浏览器冒烟 NOT RUN（沙箱），如实记录。

- [ ] **Step 5: 本地冒烟（用户执行）**

`npx wrangler dev`：出牌阶段点提示，验证——跟小单张时不拆顺子/对子；只有炸能压时才提示炸；自由出先出小散牌；残局能一手走完直接提示全出。

- [ ] **Step 6: Commit**

```bash
git add src/worker.js test/room.test.js
git commit -m "feat: 斗地主 ddz_hint 改用启发式 chooseHint"
```

---

## Self-Review

**Spec coverage:**
- decompose 贪心分解（王炸/炸弹→飞机→顺子→连对→三条→对→单，区分成型组/孤对/孤张）→ Task 1。✓
- chooseHint 规则 0 一手走完最高优先 → Task 2。✓
- 跟牌规则 1 不拆 + 最小、排除炸火 → Task 2 structureScore + nonBomb 过滤。✓
- 跟牌规则 2 非炸不可才炸（先炸弹后火箭）→ Task 2。✓
- 自由出规则 3 先清孤张→孤对→最小成型组 → Task 2。✓
- 自由出不枚举（规避 O(2^n)）→ Task 2 走 decompose，不调 enumerateLegalPlays。✓
- DO ddz_hint 改调 chooseHint、守卫保留、要不起 ddz_error → Task 3。✓
- 引擎 identifyPlay/beats/enumerateLegalPlays 不变 → 仅新增函数。✓
- 60 测试保持 + 新增 decompose/chooseHint/DO 断言 → Task 1/2/3。✓

**Placeholder scan:** 无 TODO/TBD；每步含完整代码。✓

**Type consistency:** `decompose` 返回 `{groups,pairs,singles}` 在 Task 2 chooseHint 中按此结构消费一致；`chooseHint(hand,last)` 签名在 Task 2 定义、Task 3 import 调用一致；均返回令牌数组或 null，DO 侧 `!hint` 判空一致。✓

**已知取舍（记录，供最终 review triage）:**
- `decompose` 是贪心分解、非全局最优（例如某些牌可拆成顺子也可留作对子，贪心按固定顺序取），A 档可接受。
- 规则 1 的"破坏度"用 `decompose(hand).groups 数 - 出牌后 groups 数` 近似，不是精确的手数最优；对 A 档足够，复杂残局可能非最优。
- `Object.keys(RANK_VALUE).find(...)` 反查令牌在热路径多次调用，性能对单手规模无碍（手牌 ≤20），但可读性一般；如 review 认为值得可抽 `valueToRank` 映射。
