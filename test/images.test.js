import { describe, it, expect } from "vitest";
import { createImageClient, extractImageIds, isAllowedImageType } from "../src/images.js";

const ENV = { KVAULT_BASE: "https://kv.test/", KVAULT_TOKEN: "tok" };

function fakeFetch(reply) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url: String(url), init });
    return reply(url, init);
  };
  f.calls = calls;
  return f;
}
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("isAllowedImageType", () => {
  it("只放行白名单图片类型，拒绝 svg 与文本", () => {
    expect(isAllowedImageType("image/webp")).toBe(true);
    expect(isAllowedImageType("IMAGE/PNG")).toBe(true);
    expect(isAllowedImageType("image/svg+xml")).toBe(false);
    expect(isAllowedImageType("text/html")).toBe(false);
  });
});

describe("extractImageIds", () => {
  it("抽出并解码本域图片 id", () => {
    expect(extractImageIds("看 ![](/img/img%3Aabc) 和 ![](/img/r2%3Ax)")).toEqual(["img:abc", "r2:x"]);
  });
  it("忽略外部图片与畸形转义", () => {
    expect(extractImageIds("![](https://e/x.png)")).toEqual([]);
    expect(extractImageIds("![](/img/%E0%A4%A)")).toEqual([]);
  });
});

describe("createImageClient", () => {
  it("缺任一环境变量时 enabled=false 且 upload 拒绝", async () => {
    const c = createImageClient({});
    expect(c.enabled).toBe(false);
    await expect(c.upload(new ArrayBuffer(1), "image/webp")).rejects.toThrow(/未配置/);
  });

  it("upload 拼对地址、带 Bearer、multipart 含 folderPath=chat", async () => {
    const f = fakeFetch(() => json({ success: true, file: { id: "img:abc" } }));
    const c = createImageClient(ENV, f);
    const r = await c.upload(new Uint8Array([1, 2, 3]).buffer, "image/webp");
    expect(r).toEqual({ id: "img:abc", url: "/img/img%3Aabc" });
    const call = f.calls[0];
    expect(call.url).toBe("https://kv.test/api/v1/upload");
    expect(call.init.headers.Authorization).toBe("Bearer tok");
    expect(call.init.body.get("folderPath")).toBe("chat");
    expect(call.init.body.get("file").name).toBe("image.webp");
  });

  it("upload 把上游错误映射成可读异常", async () => {
    const c1 = createImageClient(
      ENV,
      fakeFetch(() => json({ success: false, error: { message: "POLICY_DENIED" } }, 403))
    );
    await expect(c1.upload(new ArrayBuffer(1), "image/png")).rejects.toThrow("POLICY_DENIED");
    const c2 = createImageClient(ENV, fakeFetch(() => new Response("boom", { status: 500 })));
    await expect(c2.upload(new ArrayBuffer(1), "image/png")).rejects.toThrow(/500/);
  });

  it("remove：200 与 404 都算成功，5xx 失败", async () => {
    const mk = (status) => createImageClient(ENV, fakeFetch(() => new Response(null, { status })));
    expect(await mk(200).remove("img:abc")).toBe(true);
    expect(await mk(404).remove("img:abc")).toBe(true);
    expect(await mk(500).remove("img:abc")).toBe(false);
  });

  it("fetchFile 网络异常返回 null", async () => {
    const c = createImageClient(ENV, async () => {
      throw new Error("offline");
    });
    expect(await c.fetchFile("img:abc")).toBe(null);
  });
});
