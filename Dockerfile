# 自托管镜像：用 workerd（wrangler 本地模式）承载同一份 Workers 代码。
#
# 为什么不是 alpine：workerd 是 glibc 构建，musl 上跑不起来。
# 为什么不 --omit=dev：wrangler 在 devDependencies 里，运行时需要它。
FROM node:22-bookworm-slim

WORKDIR /app

ENV PORT=8080 \
    PERSIST_DIR=/data \
    CI=1 \
    WRANGLER_SEND_METRICS=false

# 先只拷依赖清单，让这层在源码变动时命中缓存。
COPY package.json package-lock.json ./
RUN npm ci --include=dev --no-audit --no-fund

# 运行时只需要 Worker 源码、静态资源和 wrangler 配置。
COPY wrangler.toml ./
COPY src ./src
COPY public ./public
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh

RUN chmod +x /usr/local/bin/entrypoint.sh \
 && mkdir -p /data \
 && chown -R node:node /app /data

USER node
VOLUME /data
EXPOSE 8080

# 冷启动要拉起 workerd，给足 start-period，避免刚起就被判死。
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
