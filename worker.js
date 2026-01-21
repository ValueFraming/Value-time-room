/**
 * VALUE:time Virtueller Raum – MVP Worker
 * Endpoints:
 *  POST /room                    -> { roomId }
 *  POST /room/:roomId/invite     -> { token, expiresAt }
 *  GET  /room/:roomId/ws?...     -> WebSocket (token,name,role)
 *
 * Durable Object: RoomDO
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,HEAD,POST,OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
};

function resp(body, status = 200, extra = {}) {
  return new Response(body, { status, headers: { ...CORS, ...extra } });
}
function json(obj, status = 200) {
  return resp(JSON.stringify(obj), status, { "Content-Type": "application/json; charset=utf-8" });
}
function bad(msg, status = 400) {
  return json({ error: msg }, status);
}
function makeToken(bytes = 18) {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...a))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
function clampStr(s, max = 80) {
  return String(s ?? "").trim().slice(0, max);
}

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return resp("", 204);

    const url = new URL(req.url);
    const path = url.pathname;

    // POST /room -> { roomId }
    if (req.method === "POST" && path === "/room") {
      const roomId = crypto.randomUUID();
      const id = env.ROOMS.idFromName(roomId);
      const stub = env.ROOMS.get(id);
      await stub.fetch("https://do/init", { method: "POST" });
      return json({ roomId });
    }

    // POST /room/:roomId/invite -> { token, expiresAt }
    {
      const m = path.match(/^\/room\/([^/]+)\/invite$/);
      if (req.method === "POST" && m) {
        const roomId = decodeURIComponent(m[1]);
        const stub = env.ROOMS.get(env.ROOMS.idFromName(roomId));
        return stub.fetch("https://do/invite", { method: "POST" });
      }
    }

    // GET /room/:roomId/ws?token=...&name=...&role=...
    {
      const m = path.match(/^\/room\/([^/]+)\/ws$/);
      if (req.method === "GET" && m) {
        const roomId = decodeURIComponent(m[1]);
        const stub = env.ROOMS.get(env.ROOMS.idFromName(roomId));
        return stub.fetch(req);
      }
    }

    return bad("Not found", 404);
  },
};

export class RoomDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map(); // clientId -> { ws, name, role }
  }

  async fetch(req) {
    const url = new URL(req.url);

    // internal init
    if (req.method === "POST" && url.hostname === "do" && url.pathname === "/init") {
      const startedAt = Date.now();
      const room = {
        startedAt,
        focus: { type: "question", content: "", author: "", authorName: "", ts: startedAt },
        participants: [],
        timeline: [{ ts: startedAt, kind: "room_started", by: "" }],
      };
      await this.state.storage.put("room", room);
      await this.state.storage.put("invites", {});
      return new Response("ok");
    }

    // internal invite
    if (req.method === "POST" && url.hostname === "do" && url.pathname === "/invite") {
      const INVITE_TTL_MS = 15 * 60 * 1000; // 15 min
      const token = makeToken();
      const invites = (await this.state.storage.get("invites")) || {};
      invites[token] = { createdAt: Date.now(), ttlMs: INVITE_TTL_MS };
      await this.state.storage.put("invites", invites);

      return new Response(
        JSON.stringify({ token, expiresAt: Date.now() + INVITE_TTL_MS }),
        { headers: { "Content-Type": "application/json; charset=utf-8" } }
      );
    }

    // WebSocket
    if (url.pathname.endsWith("/ws")) {
      const token = clampStr(url.searchParams.get("token"), 200);
      const name = clampStr(url.searchParams.get("name") || "Gast", 40) || "Gast";
      const role = clampStr(url.searchParams.get("role") || "Gast", 20) || "Gast";

      if (!token) return new Response("Missing token", { status: 401 });

      const invites = (await this.state.storage.get("invites")) || {};
      const entry = invites[token];
      if (!entry) return new Response("Invalid invite", { status: 401 });

      const age = Date.now() - entry.createdAt;
      if (age > entry.ttlMs) {
        delete invites[token];
        await this.state.storage.put("invites", invites);
        return new Response("Invite expired", { status: 401 });
      }

      // One-time token (optional): uncomment to burn token at first use
      // delete invites[token];
      // await this.state.storage.put("invites", invites);

      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      server.accept();

      const clientId = crypto.randomUUID();
      this.sessions.set(clientId, { ws: server, name, role });

      await this._addParticipant({ id: clientId, name, role, joinedAt: Date.now() });

      // initial state
      server.send(JSON.stringify({ kind: "presence", payload: await this._publicState() }));
      await this._broadcast({ kind: "presence", payload: await this._publicState() });

      server.addEventListener("message", async (evt) => {
        let msg;
        try { msg = JSON.parse(evt.data); } catch { return; }
        if (!msg || !msg.kind) return;

        if (msg.kind === "set_focus") {
          const payload = msg.payload || {};
          const type = payload.type === "text" ? "text" : "question";
          const content = clampStr(payload.content || "", 4000);
          await this._setFocus(clientId, type, content);
          await this._broadcast({ kind: "focus", payload: await this._getFocus() });
          return;
        }

        if (msg.kind === "leave") {
          try { server.close(1000, "bye"); } catch {}
          return;
        }
      });

      server.addEventListener("close", async () => {
        this.sessions.delete(clientId);
        await this._removeParticipant(clientId);
        await this._broadcast({ kind: "presence", payload: await this._publicState() });
      });

      server.addEventListener("error", async () => {
        try { server.close(1011, "error"); } catch {}
      });

      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response("Not found", { status: 404 });
  }

  async _getRoom() {
    const room = await this.state.storage.get("room");
    if (room) return room;
    const startedAt = Date.now();
    const fresh = {
      startedAt,
      focus: { type: "question", content: "", author: "", authorName: "", ts: startedAt },
      participants: [],
      timeline: [{ ts: startedAt, kind: "room_started", by: "" }],
    };
    await this.state.storage.put("room", fresh);
    return fresh;
  }

  async _publicState() {
    const room = await this._getRoom();
    return { startedAt: room.startedAt, participants: room.participants, focus: room.focus };
  }

  async _getFocus() {
    const room = await this._getRoom();
    return room.focus;
  }

  async _addParticipant(p) {
    const room = await this._getRoom();
    room.participants.push(p);
    room.timeline.push({ ts: Date.now(), kind: "join", by: p.id });
    await this.state.storage.put("room", room);
  }

  async _removeParticipant(id) {
    const room = await this._getRoom();
    room.participants = room.participants.filter((x) => x.id !== id);
    room.timeline.push({ ts: Date.now(), kind: "leave", by: id });
    await this.state.storage.put("room", room);
  }

  async _setFocus(byId, type, content) {
    const room = await this._getRoom();
    const sender = this.sessions.get(byId);
    room.focus = { type, content, author: byId, authorName: sender?.name || "", ts: Date.now() };
    room.timeline.push({ ts: Date.now(), kind: "set_focus", by: byId });
    await this.state.storage.put("room", room);
  }

  async _broadcast(message) {
    const data = JSON.stringify(message);
    for (const [, s] of this.sessions) {
      try { s.ws.send(data); } catch {}
    }
  }
}
