import { DurableObject } from "cloudflare:workers";
import { sanitizeNick, parseInbound, chatMsg, systemMsg, presenceMsg } from "./messages.js";

export class ChatRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    // 从 hibernation 恢复：无需额外 sessions map，用 ctx.getWebSockets() 即可
  }

  async fetch(request) {
    const url = new URL(request.url);
    const nick = sanitizeNick(url.searchParams.get("nick"));

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ nick });

    const ts = Date.now();
    this.broadcast(systemMsg(`${nick} 加入了房间`, ts));
    this.broadcast(presenceMsg(this.ctx.getWebSockets().length));

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    if (typeof message !== "string") return;
    const parsed = parseInbound(message);
    if (!parsed) return;
    const att = ws.deserializeAttachment() || {};
    const nick = att.nick || "访客";
    this.broadcast(chatMsg(nick, parsed.text, Date.now()));
  }

  async webSocketClose(ws, code, reason, wasClean) {
    const att = ws.deserializeAttachment() || {};
    const nick = att.nick || "访客";
    try {
      ws.close(code, reason);
    } catch {}
    const ts = Date.now();
    const remaining = this.ctx.getWebSockets().filter((s) => s !== ws).length;
    this.broadcast(systemMsg(`${nick} 离开了房间`, ts));
    this.broadcast(presenceMsg(remaining));
  }

  broadcast(data) {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(data);
      } catch {}
    }
  }
}

export default {
  async fetch(request, env, ctx) {
    return new Response("ok");
  },
};
