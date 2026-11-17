import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
        // 测试用的图床配置：真实地址与 Token 只存在于部署方 secret 里，
        // 仓库里既不写死也不能缺失（缺了图片上传分支不可达）。
        miniflare: {
          bindings: { KVAULT_BASE: "https://kvault.test", KVAULT_TOKEN: "test-token" },
        },
      },
    },
  },
});
