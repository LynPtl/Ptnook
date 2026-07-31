# 聊天体验优化(第一梯队)— 设计文档

日期：2026-07-31
项目：Ptnook 聊天室(Cloudflare Workers + Durable Objects,单文件 src/worker.js 含 ChatRoom DO + 内嵌 HTML)

## 目标

在不改变技术栈、不破坏现有 12/12 测试与 XSS 安全的前提下,提升"自己人小群聊"的即时聊天体验。

## 范围(需求确认结论)

纳入本梯队:
1. 时间戳渲染(前端)
2. 多行输入(前端)
3. 滚动逻辑优化(前端)
4. 房间历史缓存 50 条 + 新人进房推送 + 空房 30 分钟清除(服务端)

明确排除(YAGNI / 单独处理):
- 左右气泡区分自己/别人(用户取消)
- 本地即时回显 optimistic echo(用户选择保持"等服务端广播回来再显示")
- Markdown 渲染(以后单独 brainstorm,重点做 XSS sanitizer 选型)
- 图片/文件、@提及、回复、reactions、永久全量历史(超出范围)

## 一、服务端:房间历史缓存

### 存储
- 每个房间 = 一个 ChatRoom Durable Object,历史存在该 DO 自己的 `ctx.storage`(SQLite 后端,免费计划可用),因此**每个房间各自独立的最近 50 条**,房间间完全隔离。
- 存 storage 而非纯内存的原因:DO 会休眠(hibernation)被驱逐,重部署也会重建;纯内存的历史会因此丢失,导致"进房看最近消息"不可靠。存 storage 后休眠/重部署都不丢。

### 历史列表
- key:`history`,value:数组 `[{nick, text, ts}, ...]`,只存 chat 消息(system/presence 不入历史)。
- 上限 50 条:追加新消息后若超过 50,丢弃最旧的(滚动窗口)。
- 这是"滚动 50 条上限",不是永久全量历史。

### 写入
- `webSocketMessage` 处理合法 chat 时:广播 chat 的同时,把 `{nick, text, ts}` 追加进 history 并裁剪到最近 50 条,写回 storage。

### 读取 / 推送
- 新连接在 `fetch` 建连后:**先单独给这个新连接**发一条 `{type:"history", items:[{nick,text,ts}, ...]}`(仅此连接,不广播),**再**广播 "加入了房间" 的 system 消息。
- 顺序保证新人看到:历史消息 → "自己进来了"。

### 消息协议新增
- server→client 新增:`{type:"history", items:[{nick, text, ts}, ...]}`(仅发给刚进房的连接)。
- 现有 `chat` / `system` / `presence` 不变;`ts` 已在传,前端开始使用。

## 二、服务端:空房历史清除(DO Alarm)

目的:房间名即口令、人人可进。若一拨人聊完离开,历史留存,后来用同名房间的人会看到上一拨的聊天记录 —— 隐私泄露。DO storage 不会因"无人连接"自动清空,必须主动清除。

机制(Cloudflare DO Alarm):
- **设定**:`webSocketClose` 中广播离开消息后,若 `remaining === 0`(房间空),`ctx.storage.setAlarm(Date.now() + 30 分钟)`。
- **取消**:`fetch` 建连时(有人进来),`ctx.storage.deleteAlarm()`,取消待定的清除。
- **执行**:`alarm()` 触发时,**二次确认** `ctx.getWebSockets().length === 0`(防"闹钟响瞬间有人进来"的竞态),确认仍空则 `ctx.storage.deleteAll()` 清除历史(及自身其它 storage)。
- 空置阈值:**30 分钟**。
- 成本:Alarm 在免费额度内。只清历史缓存;房间仍然"知道名字就能进",只是进去干净、看不到上一拨消息。

## 三、前端:时间戳渲染

- 每条 chat(含历史 items)在昵称旁显示时间,格式 `HH:MM`(本地时区,由 `ts` 格式化,补零)。
- system 消息不加时间。

## 四、前端:多行输入

- `#text` 由 `<input>` 改为 `<textarea>`(沿用现有样式,固定较矮高度,超出内容内部滚动)。
- 键盘:**Enter 发送**,**Shift+Enter 换行**;`maxlength` 2000 仍限制。
- 渲染:消息文本容器用 `white-space: pre-wrap` 保留换行/空格;仍用 `textContent`,不破坏 XSS 安全。

## 五、前端:滚动逻辑

- 贴底判断:`scrollTop + clientHeight >= scrollHeight - 40`(阈值 40px)。
- **进房渲染完历史后**:强制滚到底(用户"进来就在最下方")。
- **收到新消息(chat/system)时**:渲染前记录当前是否贴底 → 渲染后,若之前贴底才滚到底;否则不动(用户翻历史时不打扰)。
- 自己发消息:不做本地回显,服务端广播回来时用户通常已贴底,自然滚动;不特殊处理。

## 安全与约束(保持不变)

- 所有服务端提供的 nick/text 一律经 `textContent` 渲染,严禁 innerHTML 承载服务端数据(唯一允许:清空 `#messages` 时用空字符串字面量)。
- 昵称 ≤ 32、文本 ≤ 2000,服务端 sanitize(现有 messages.js 逻辑不变)。
- history items 里的 nick/text 也经 sanitize(写入时即为已 sanitize 的值),渲染同样走 textContent。

## 测试策略

- 服务端(vitest + workers pool,复用现有 test/room.test.js 风格):
  - 新连接先收到 `history`(初次进空房 items 为空数组),再收到 system 加入广播。
  - 发若干 chat 后,新进来的连接能在 history items 中看到这些消息且顺序正确。
  - history 上限:发送 > 50 条后,新连接收到的 items 长度为 50 且是最新的。
  - 空房清除:remaining 到 0 设 alarm;alarm 执行后 history 被清空(可通过再次进房收到空 history 验证);alarm 前有人进来则历史保留。
- 前端:纯浏览器逻辑(时间格式化、多行、滚动)以静态 hook 检查 + 手动冒烟为主(沙箱无法跑交互浏览器,如实标注 NOT RUN)。可将时间格式化抽成纯函数便于单测。

## 非目标提醒

不改部署方式(仍 `npm run deploy`)、不加依赖(保持零依赖)、不引入账号/登录、不做永久历史。
