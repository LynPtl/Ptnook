# Docker 自托管 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 Dockerfile + compose 在任意有 Docker 的机器上跑起同一个聊天室，数据落在挂载卷里。

**Architecture:** 不重写运行时。镜像内用 `wrangler dev`（miniflare + workerd）承载同一份 `src/` + `public/`；entrypoint 把 `KVAULT_*` 环境变量写成 `.dev.vars`，再用 `--persist-to /data` 把 DO 的 SQLite 放到挂载卷。

**Tech Stack:** Docker、node:22-bookworm-slim、wrangler 4.x（本地模式）、workerd。

**Spec:** `docs/superpowers/specs/2026-11-17-docker-selfhost-design.md`

## Global Constraints

- 镜像里不得出现任何密钥：`KVAULT_*` 只在运行时由环境变量注入。
- 仓库不得新增部署方信息；`wrangler.toml` 不改。
- 基础镜像必须 glibc（`node:22-bookworm-slim`），不能用 alpine（workerd 是 glibc 构建）。
- 构建阶段不能设 `NODE_ENV=production`，否则 `npm ci` 会跳过 devDependencies（wrangler 在里面）。
- 与 Workers 部署共用同一份代码，不允许出现 `src/` 的副本或第二套入口逻辑。

## Review Focus

1. 没有 `KVAULT_*` 环境变量时容器仍能起、聊天与桌游正常，只有图片功能关闭。
2. `docker restart`（或删容器重建）后房间历史仍在——卷真的在持久化 DO 存储。
3. 容器里的服务监听 `0.0.0.0`，宿主机端口映射能访问（`wrangler dev` 默认只听 127.0.0.1）。
4. `.dev.vars` 权限是 600，且不会被打进镜像层（`.dockerignore`）。
5. 健康检查在首次冷启动（workerd 拉起约几秒）后不会误判为不健康。

---

### Task 1: 镜像与编排文件

**Files:**
- Create: `Dockerfile`
- Create: `docker/entrypoint.sh`
- Create: `.dockerignore`
- Create: `docker-compose.yml`

**Interfaces:**
- Consumes: 仓库现有的 `wrangler.toml`、`src/`、`public/`、`package*.json`。
- Produces: 镜像入口 `/usr/local/bin/entrypoint.sh`；环境变量 `PORT`（默认 8080）、`PERSIST_DIR`（默认 `/data`）、`KVAULT_BASE`、`KVAULT_TOKEN`。

- [ ] **Step 1: 写 `docker/entrypoint.sh`**

行为（顺序固定）：
1. `mkdir -p "$PERSIST_DIR"`。
2. `KVAULT_BASE` 与 `KVAULT_TOKEN` 都非空 → `umask 077` 写 `/app/.dev.vars`；否则 `rm -f` 它。
3. `exec npx wrangler dev --ip 0.0.0.0 --port "$PORT" --persist-to "$PERSIST_DIR"`。

- [ ] **Step 2: 写 `Dockerfile`**

`node:22-bookworm-slim` → `WORKDIR /app` → 拷 `package*.json` → `npm ci --include=dev --no-audit --no-fund`
→ 拷 `wrangler.toml`、`src/`、`public/`、entrypoint → `chmod +x`、`mkdir -p /data`、`chown node:node`
→ `USER node`、`VOLUME /data`、`EXPOSE 8080`、`HEALTHCHECK`（node fetch 首页）、`ENTRYPOINT`。

- [ ] **Step 3: 写 `.dockerignore` 与 `docker-compose.yml`**

`.dockerignore`：`node_modules`、`.git`、`.wrangler`、`.dev.vars`、`.superpowers`、`docs`、`test`、`.github`、`CHANGELOG.md`。

compose：`build: .`、`ports: ["8080:8080"]`、`environment` 透传两个 `KVAULT_*`、`volumes: chat_data:/data`、`restart: unless-stopped`。

- [ ] **Step 4: 宿主机验证 entrypoint 逻辑（不需要 Docker）**

Run: `KVAULT_BASE=https://example.test KVAULT_TOKEN=t PORT=8791 PERSIST_DIR=$(pwd)/.persist-test sh docker/entrypoint.sh`
Expected: 打印 `Ready on http://0.0.0.0:8791`；`/app` 对应路径下 `.dev.vars` 内容正确（本地跑时是仓库根目录）。
再跑一次不带 `KVAULT_*`：`.dev.vars` 不存在，首页仍返回 200。

- [ ] **Step 5: 构建并运行镜像**

Run: `docker build -t chatroom:local .` → `docker run -d --name chatroom-test -p 18080:8080 -e KVAULT_BASE=... -e KVAULT_TOKEN=... -v chat_test:/data chatroom:local`
Expected: 容器 `healthy`；`curl -s http://127.0.0.1:18080/ | grep imagesEnabled` → `true`。

- [ ] **Step 6: 提交**

`feat: 新增 Docker 自托管（Dockerfile + compose）`

---

### Task 2: 浏览器验收与持久化

**Files:** 无（只验证）

- [ ] **Step 1: 浏览器进房粘贴图片**

打开 `http://127.0.0.1:18080/`，进房，粘贴一张图 → 消息里渲染；`/img/...` 返回 `image/*`。

- [ ] **Step 2: 重启后历史仍在**

`docker restart chatroom-test` → 重新进同一房间 → 最近消息仍在（卷生效）。
再 `docker rm -f chatroom-test` 后用同一卷 `docker run` 起一次，历史仍应在。

- [ ] **Step 3: 清理**

`docker rm -f chatroom-test`、`docker volume rm chat_test`。

---

### Task 3: 文档

**Files:**
- Modify: `README.md`（新增「Docker 自托管（可选）」）
- Modify: `CHANGELOG.md`

- [ ] **Step 1: README**

写清 `docker compose up -d`、卷位置、`KVAULT_*`、端口，以及**它跑在 wrangler 开发服务器上**（无 TLS、单进程、无优雅关机，适合内网/自己人；对外请套反向代理）。

- [ ] **Step 2: CHANGELOG**

加一条：Docker 自托管（Dockerfile / entrypoint / compose），说明与 Workers 部署共用同一份代码。

- [ ] **Step 3: 全量测试**

Run: `npm test`
Expected: 257 passed（代码未改动，仅新增部署文件）。

- [ ] **Step 4: 提交**

`docs: 补充 Docker 自托管说明`
