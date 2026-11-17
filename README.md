# 即时聊天室

免登录、房间名即口令的即时纯文字聊天室。纯即时不存历史。部署在 Cloudflare Workers + Durable Objects。

## 本地运行

    npm install
    npm run dev

浏览器打开 wrangler 提示的本地地址，填房间名 + 昵称即可聊天。开多个窗口用同一房间名测试。

## 测试

    npm test

## 部署（免费）

1. 安装并登录：`npx wrangler login`
2. 一键部署：`npm run deploy`
3. 部署完成后得到 `https://chatroom.<你的子域>.workers.dev`，把地址发给朋友即可。

Workers 与 Durable Objects 的免费额度足够自己人小范围使用。

## 图片消息（可选）

需要自建一个 [K-Vault](https://github.com/katelya77/K-Vault) 图床（Telegram / R2 / S3 等后端均可）。
不配置时图片功能整体关闭，聊天与桌游不受影响。

1. 在 K-Vault 后台创建一个 API Token：勾选 `upload` + `delete`，
   可选策略 `folderPrefix = chat`、`maxFileSize = 2MB`。
2. 把地址与 Token 作为 secret 注入（**不要**写进 `wrangler.toml`，仓库是开源的）：

       npx wrangler secret put KVAULT_BASE    # 例如 https://your-kvault.pages.dev
       npx wrangler secret put KVAULT_TOKEN   # kvault_<id>_<secret>

3. 本地开发写 `.dev.vars`（已 gitignore）：

       KVAULT_BASE=https://your-kvault.pages.dev
       KVAULT_TOKEN=kvault_dev_token

上传限制：单张 ≤2 MB、每房间每分钟 20 次、账本最多 200 张。房间无人 30 分钟后，
历史与图片一起删除（调用 K-Vault 的 `DELETE /api/v1/file/:id`）；消息被 50 条窗口淘汰时也会立刻删图。
删除是 best-effort：图床不可用时最多重试 2 轮后放弃。

> 已知限制：K-Vault 对相同内容做 SHA-256 去重并返回同一个 file id，
> 两个房间发同一张图时，先散场的房间会把另一房间的图一起删掉。

## Docker 自托管（可选）

不想用 Cloudflare 账号时，可以在任意有 Docker 的机器（NAS / 内网 / VPS）上跑同一份代码：

    KVAULT_BASE=https://your-kvault.pages.dev KVAULT_TOKEN=kvault_xxx docker compose up -d

- 监听 `8080`，房间数据存在命名卷 `chat_data`（容器重建不丢历史）。
- `KVAULT_*` 也可以不传：图片功能自动关闭，聊天与桌游不受影响。
- 镜像内部运行的是 `wrangler dev`（miniflare + workerd），**这是 Cloudflare 的本地开发服务器**，
  不是生产级 Web 服务器：没有 TLS、单进程、没有优雅关机、没有多副本。
  适合内网或自己人小范围使用；要暴露到公网，请在前面套 Caddy/Nginx 做 TLS，并自行评估风险。
- 直接用 Dockerfile 手动起：

      docker build -t chatroom:local .
      docker run -d --name chatroom -p 8080:8080 \
        -e KVAULT_BASE=https://your-kvault.pages.dev -e KVAULT_TOKEN=kvault_xxx \
        -v chat_data:/data chatroom:local

## 用法

- 房间名就是口令：知道房间名的人填入即可进入同一房间。
- 昵称留空会显示为「访客」。
- 关闭页面即离开，其他人会看到离开提示与实时在线人数。
- 进房会看到该房间最近 50 条消息（每个房间独立，纯即时滚动，不做永久历史）。
- 消息显示发送时间（时:分）。
- 输入框支持多行：Enter 发送，Shift+Enter 换行。
- 消息支持轻量 Markdown：`**粗体**`、`*斜体*`、`` `行内代码` ``、`~~删除线~~`、以及 `http(s)://` 自动成链接；块级支持 `#` 标题、`-` / `1.` 列表、`>` 引用、`---` 分割线和 ` ``` ` 代码块（内部不解析、原样显示）。
  链接语法 `[文字](url)`、表格、嵌套列表不做（原样显示为文字）；只用系统自带字体与样式，不引第三方依赖、不加载外部图片（避免泄露 IP）。
- 图片：配置图床后，在输入框粘贴图片即可上传（压缩到最长边 1600px / WebP，≤2 MB），
  消息里插入 `![](/img/<id>)`，图片由本 Worker 代理显示（页面只与本域通信）。
  只有本域 `/img/` 的图片会渲染，外部图片链接仍按文字显示。图片随聊天生命周期一起删除：
  消息被 50 条窗口淘汰或房间无人 30 分钟时，服务端会调用图床接口删掉文件。
- 房间在无人 30 分钟后自动清除这 50 条缓存，避免同名房间被后来者看到旧消息。
- 切走窗口再切回（或重新进房）时，会在第一条未读消息前显示「以下是新消息」分隔线并自动定位（记录在本浏览器本地，按房间区分）。
- 斗地主：在聊天框输入 `/ddz` 发起，另外两人点【加入牌桌】，满 3 人开局。抢地主、出牌、结算与累计分都在聊天流里显示，自己的手牌显示在输入框上方，点牌选中后点【出牌】或【过】。散桌/退出会清零累计分，「再来一局」则保留累计分继续算账。
- 德州扑克：在聊天框输入 `/poker` 发起牌桌，另外 1~2 人点【加入牌桌】（2~3 人），点【下一手】开局。小盲 0.5bb、大盲 1bb，每人初始 50bb，No-Limit 玩法（过牌/跟注/下注/加注/弃牌/全下），完整主池+边池结算，摊牌 7 选 5 比大小。筹码输光可在手间点【buy-in】领 50bb 复活。自己的底牌只在自己视角显示，牌桌状态与进展全桌可见。一个房间同一时刻只跑一种桌游（斗地主或德州）。
