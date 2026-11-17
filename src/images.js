// 自建 K-Vault 图床客户端。纯逻辑，fetch 可注入（测试用假实现）。
//
// 配置只从环境变量读：KVAULT_BASE / KVAULT_TOKEN。
// 仓库是开源的，任何地址与凭据都不得写进代码或 wrangler.toml，
// 生产用 `wrangler secret put`，本地写 .dev.vars。
//
// 未配置时 enabled=false：上传抛错、删除/读取直接失败，
// 聊天其余功能不受影响（与"图片是可选能力"的定位一致）。

export const ALLOWED_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/avif",
]);

const EXT_BY_TYPE = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
};

// 与 public/markdown.js 的图片规则共用同一字符类：
// 只认本域 /img/<encodeURIComponent(id)>，外部图片不进这里。
const IMG_REF = /!\[[^\]\n]{0,100}\]\(\/img\/([A-Za-z0-9_.%~-]{1,512})\)/g;

export function isAllowedImageType(type) {
  return ALLOWED_IMAGE_TYPES.has(String(type || "").toLowerCase().split(";")[0].trim());
}

// 从消息文本里抽本域图片 id（已解码）。畸形转义直接跳过，不让一条坏消息炸掉清理任务。
export function extractImageIds(text) {
  if (typeof text !== "string") return [];
  const out = [];
  IMG_REF.lastIndex = 0;
  let m;
  while ((m = IMG_REF.exec(text)) !== null) {
    try {
      out.push(decodeURIComponent(m[1]));
    } catch {}
  }
  return out;
}

function normalizeBase(raw) {
  const s = String(raw || "").trim();
  return s ? s.replace(/\/+$/, "") + "/" : "";
}

export function createImageClient(env = {}, fetchImpl = fetch) {
  const base = normalizeBase(env.KVAULT_BASE);
  const token = String(env.KVAULT_TOKEN || "").trim();
  const enabled = Boolean(base && token);
  const buildUrl = (path) => new URL(path, base).toString();
  const auth = { Authorization: "Bearer " + token };

  return {
    enabled,

    async upload(bytes, type) {
      if (!enabled) throw new Error("图床未配置");
      const t = String(type || "").toLowerCase();
      const form = new FormData();
      form.append("file", new File([bytes], "image." + (EXT_BY_TYPE[t] || "bin"), { type: t }));
      form.append("folderPath", "chat");
      // 不手写 Content-Type，交给运行时带上 multipart boundary。
      const res = await fetchImpl(buildUrl("api/v1/upload"), { method: "POST", headers: auth, body: form });
      let data = null;
      try {
        data = await res.json();
      } catch {}
      const id = data && data.success && data.file && data.file.id;
      if (!res.ok || !id) {
        const reason = data && data.error && data.error.message;
        throw new Error(reason || "图床上传失败 " + res.status);
      }
      return { id, url: "/img/" + encodeURIComponent(id) };
    },

    async remove(id) {
      if (!enabled) return false;
      try {
        const res = await fetchImpl(buildUrl("api/v1/file/" + encodeURIComponent(id)), {
          method: "DELETE",
          headers: auth,
        });
        // 404 = 已经没了，目标达成；5xx/网络错才算失败，交给 alarm 重试。
        return res.ok || res.status === 404;
      } catch {
        return false;
      }
    },

    async fetchFile(id) {
      if (!enabled) return null;
      try {
        return await fetchImpl(buildUrl("file/" + encodeURIComponent(id)), { method: "GET" });
      } catch {
        return null;
      }
    },
  };
}
