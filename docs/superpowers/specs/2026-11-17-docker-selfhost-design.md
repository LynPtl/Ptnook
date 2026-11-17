# Docker 自托管 — 设计文档

日期：2026-11-17
项目：Ptnook 聊天室（Cloudflare Workers + Durable Objects，零依赖零构建）

## 目标

提供一条不依赖 Cloudflare 账号的本地部署路径：一个 Dockerfile + 一份 compose 文件，
在 NAS / 内网 / VPS 上跑起同一个代码库，数据落在挂载卷里。

## 非目标

- 不改写运行时（不把 DO 那层换成 Node/ws/SQLite）。
- 不追求生产级加固：不做 TLS、不做多副本、不做优雅关机。
- 不替代 Workers 部署；不引入第二套配置源。

## 反向目标

- 不能把 `KVAULT_*` 密钥写进镜像层或仓库。
- 不能让 Docker 路径与 Workers 路径的代码分叉（同一份 `src/` + `public/`）。

## 约束（已查证）

1. 应用依赖 Durable Objects、`cloudflare:workers` 导入、`[assets]` 静态资源、
   DO SQLite 存储与 `alarm()`。
2. 唯一能跑这套东西的非 Cloudflare 运行时是 `workerd`（wrangler 本地模式即 miniflare + workerd）。
3. 已实测：`wrangler dev` 在**没有 Cloudflare 凭据**时也能启动（`XDG_CONFIG_HOME` 指向空目录照常起服务），
   容器里无需登录；`/markdown.js` 静态资源、WebSocket、DO 均工作。
4. `workerd` 是 glibc 构建 → 基础镜像用 `node:22-bookworm-slim`，不能用 alpine。
5. 本机 Docker daemon 目前未运行 → 镜像构建与容器运行**无法在本次会话验证**。

## 方案选择

| 方案 | 结论 |
|---|---|
| A. `wrangler dev` 进容器（`--ip 0.0.0.0 --persist-to /data`） | **采用**。零代码分叉，一个 Dockerfile 即可；代价是跑在官方开发服务器上 |
| B. `workerd` + 手写 capnp 配置 | 否决：DO sqlite 存储与静态资源路由的 capnp 配置对版本敏感，维护成本高于收益 |
| C. 改成 Node 服务（ws + SQLite） | 否决：等于重写 DO 层，两套实现长期分叉，与"零依赖零构建"的定位冲突 |

## 设计

### 1. `Dockerfile`

- `FROM node:22-bookworm-slim`
- 只拷贝 `package*.json` 先 `npm ci`（`wrangler` 是 devDependency，不能 `--omit=dev`；
  `workerd` 的平台二进制随 npm 包安装）
- 再拷贝 `wrangler.toml`、`src/`、`public/`、`docker/entrypoint.sh`
- `ENV PORT=8080 PERSIST_DIR=/data WRANGLER_SEND_METRICS=false`
- `VOLUME /data`，`EXPOSE 8080`
- 启动：`docker/entrypoint.sh`
- 健康检查：`node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/').then(r=>process.exit(r.ok?0:1))"`

### 2. `docker/entrypoint.sh`

只做三件事，然后 `exec`（保证 PID 1 收到信号）：

1. 若 `KVAULT_BASE` 与 `KVAULT_TOKEN` 都非空，生成 `/app/.dev.vars`（`chmod 600`）；
   任一为空就不生成，图片功能按设计自动关闭。
2. 确保 `PERSIST_DIR` 存在且可写。
3. `exec npx wrangler dev --ip 0.0.0.0 --port "$PORT" --persist-to "$PERSIST_DIR"`（`CI=1`）。

选择 `.dev.vars` 而不是改 `wrangler.toml` 的理由：仓库里不能出现任何部署方信息，
且 `.dev.vars` 是 wrangler 本地模式的既有机制，不新增配置源。

### 3. `docker-compose.yml`

服务名 `chatroom`；`ports: ["8080:8080"]`；`environment` 透传 `KVAULT_BASE`/`KVAULT_TOKEN`；
`volumes: chat_data:/data`；`restart: unless-stopped`。

### 4. `.dockerignore`

`node_modules`、`.git`、`.wrangler`、`.dev.vars`、`.superpowers`、`docs`、`test`。

### 5. `README.md`

新增「Docker 自托管（可选）」一节：`docker compose up -d`、卷位置、`KVAULT_*` 环境变量，
并明确写出**它是 wrangler 开发服务器**：无 TLS、单进程、无优雅关机，适合内网/自己人使用，
对外请套反向代理并自行评估。

## 风险

- **不是生产服务器**：Cloudflare 把 wrangler dev / miniflare 定位为开发工具，无 SLA、无加固。
  镜像只是"能跑起来的最低成本方案"，不是"可以替代 Workers"的方案。
- **单实例**：DO 的 SQLite 存在单卷上，不能多副本共享；容器重启期间连接全断。
- **热重载**：wrangler dev 默认监听文件变化；容器内文件不变，影响可忽略。
- **镜像体积** ~500 MB（node + wrangler + workerd）。
- **构建需联网**：`npm ci` 要拉包，`workerd` 的平台二进制也在其中。
- **DO 闹钟**：30 分钟自动清理依赖 `alarm()`，miniflare 支持，但需要在容器里实测一次。

## 验证

1. `docker build -t chatroom .`
2. `docker run -d -p 8080:8080 -e KVAULT_BASE=... -e KVAULT_TOKEN=... -v chat_data:/data chatroom`
3. 浏览器进房 → 粘贴图片 → 消息里渲染出图；`docker restart` 后房间历史仍在（卷持久化生效）。
4. 若 Docker daemon 不可用：在宿主机上用同样的环境变量直接跑 `docker/entrypoint.sh`，
   证明「环境变量 → `.dev.vars` → Worker 绑定」这一段；镜像构建与容器运行标记为未验证。
