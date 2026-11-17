#!/bin/sh
# 容器入口：把运行时环境变量接进 wrangler 本地模式，再 exec 成 PID 1。
#
# 密钥不落镜像：KVAULT_* 只在启动时从环境变量写进 .dev.vars（600 权限），
# 仓库与镜像层里都不存在部署方信息。
set -eu

: "${PORT:=8080}"
: "${PERSIST_DIR:=/data}"
: "${APP_DIR:=/app}"

mkdir -p "$PERSIST_DIR"

if [ -n "${KVAULT_BASE:-}" ] && [ -n "${KVAULT_TOKEN:-}" ]; then
  old_umask=$(umask)
  umask 077
  {
    printf 'KVAULT_BASE=%s\n' "$KVAULT_BASE"
    printf 'KVAULT_TOKEN=%s\n' "$KVAULT_TOKEN"
  } > "$APP_DIR/.dev.vars"
  umask "$old_umask"
else
  # 缺任一变量就关掉图片功能，聊天本身不受影响。
  rm -f "$APP_DIR/.dev.vars"
fi

# --ip 0.0.0.0 是必须的：wrangler dev 默认只监听 127.0.0.1，容器外访问不到。
# --persist-to 把 Durable Object 的 SQLite 放到挂载卷，容器重建不丢房间状态。
exec npx wrangler dev \
  --ip 0.0.0.0 \
  --port "$PORT" \
  --persist-to "$PERSIST_DIR"
