const NICK_MAX = 32;
const TEXT_MAX = 2000;

export function sanitizeNick(raw) {
  const s = (typeof raw === "string" ? raw : "").trim();
  if (!s) return "访客";
  return s.slice(0, NICK_MAX);
}

export function sanitizeText(raw) {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s) return null;
  return s.slice(0, TEXT_MAX);
}

export function parseInbound(raw) {
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!obj || obj.type !== "chat") return null;
  const text = sanitizeText(obj.text);
  if (text === null) return null;
  return { text };
}

export function chatMsg(nick, text, ts) {
  return JSON.stringify({ type: "chat", nick, text, ts });
}

export function systemMsg(text, ts) {
  return JSON.stringify({ type: "system", text, ts });
}

export function presenceMsg(count) {
  return JSON.stringify({ type: "presence", count });
}

export function historyMsg(items) {
  return JSON.stringify({ type: "history", items });
}

export function firstUnreadIndex(items, lastReadTs) {
  if (!lastReadTs) return -1;
  for (let i = 0; i < items.length; i++) {
    if (items[i].ts > lastReadTs) return i;
  }
  return -1;
}
