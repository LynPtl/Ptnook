import { DurableObject } from "cloudflare:workers";

export class TrpgStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS records (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  }
  read(key) {
    const row = this.sql.exec("SELECT value FROM records WHERE key = ?", key).toArray()[0];
    return row ? JSON.parse(row.value) : null;
  }
  write(key, value) { this.sql.exec("INSERT INTO records(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, JSON.stringify(value)); }
  remove(key) { this.sql.exec("DELETE FROM records WHERE key = ?", key); }
}

export class HttpError extends Error {
  constructor(status, message) { super(`[TRPG:${status}]${message}`); this.status = status; }
}

export function insist(value, status, message) {
  if (!value) throw new HttpError(status, message);
}

export function token() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, "0")).join("");
}

export async function digest(value) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), b => b.toString(16).padStart(2, "0")).join("");
}

export function equalHash(a, b) {
  return crypto.subtle.timingSafeEqual(new TextEncoder().encode(a), new TextEncoder().encode(b || "0".repeat(64)));
}

export async function boundedJson(source, limit = 32768) {
  insist(Number(source.headers.get("content-length") || 0) <= limit, 413, "内容超过大小限制");
  insist(source.body, 400, "请提交 JSON 内容");
  const reader = source.body.getReader();
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new HttpError(413, "内容超过大小限制"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder().decode(result)); } catch { throw new HttpError(400, "JSON 格式不正确"); }
}
