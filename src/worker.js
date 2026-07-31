import { DurableObject } from "cloudflare:workers";

export class ChatRoom extends DurableObject {}

export default {
  async fetch(request, env, ctx) {
    return new Response("ok");
  },
};
