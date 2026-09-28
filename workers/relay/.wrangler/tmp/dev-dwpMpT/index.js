var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/index.ts
var MerchantRoom = class {
  static {
    __name(this, "MerchantRoom");
  }
  state;
  sessions;
  // Socket -> claimed stable device id (set on 'hello').
  sessionDevices;
  currentEpoch;
  rateLimits;
  pingInterval = null;
  constructor(state) {
    this.state = state;
    this.sessions = /* @__PURE__ */ new Set();
    this.sessionDevices = /* @__PURE__ */ new Map();
    this.currentEpoch = 1;
    this.rateLimits = /* @__PURE__ */ new Map();
  }
  async readDevices() {
    try {
      return await this.state.storage.get("devices") ?? {};
    } catch {
      return {};
    }
  }
  async writeDevices(devices) {
    try {
      await this.state.storage.put("devices", devices);
    } catch {
    }
  }
  closeSession(session) {
    this.sessions.delete(session);
    this.sessionDevices.delete(session);
    this.rateLimits.delete(session);
    try {
      session.close(4e3, "device-revoked");
    } catch {
    }
  }
  /** B-054: single forget path — send failures must drop all three maps. */
  forgetSession(session) {
    this.sessions.delete(session);
    this.sessionDevices.delete(session);
    this.rateLimits.delete(session);
  }
  ensureHeartbeat() {
    if (this.pingInterval || this.sessions.size === 0) return;
    this.pingInterval = setInterval(() => {
      if (this.sessions.size === 0) {
        if (this.pingInterval) {
          clearInterval(this.pingInterval);
          this.pingInterval = null;
        }
        return;
      }
      const pingMsg = JSON.stringify({ type: "ping", server_ts: Date.now() });
      for (const session of Array.from(this.sessions)) {
        try {
          session.send(pingMsg);
        } catch {
          this.forgetSession(session);
        }
      }
    }, 25e3);
  }
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/__devices" && request.method === "GET") {
      const devices = await this.readDevices();
      const list = Object.values(devices).map((d) => ({ deviceId: d.deviceId, deviceName: d.deviceName, platform: d.platform, firstSeen: d.firstSeen, lastSeen: d.lastSeen, revoked: d.revoked })).sort((a, b) => b.lastSeen - a.lastSeen);
      return new Response(JSON.stringify({ devices: list }), { headers: { "Content-Type": "application/json" } });
    }
    if (url.pathname === "/__revoke" && request.method === "POST") {
      const target = (url.searchParams.get("deviceId") || "").slice(0, 128);
      const revoked = url.searchParams.get("revoked") !== "false";
      if (!target) return new Response("Missing deviceId", { status: 400 });
      const devices = await this.readDevices();
      const now = Date.now();
      const prev = devices[target];
      devices[target] = {
        deviceId: target,
        deviceName: prev?.deviceName ?? "Appareil",
        platform: prev?.platform ?? "unknown",
        firstSeen: prev?.firstSeen ?? now,
        lastSeen: prev?.lastSeen ?? now,
        revoked,
        ...revoked ? { revokedAt: now } : {}
      };
      await this.writeDevices(devices);
      for (const [session, deviceId] of Array.from(this.sessionDevices)) {
        if (deviceId === target) {
          try {
            session.send(JSON.stringify({ type: "device-revoked", epoch: this.currentEpoch, deviceId: target, revoked }));
          } catch {
          }
          if (revoked) this.closeSession(session);
        }
      }
      if (!revoked) {
        const outbound = JSON.stringify({ type: "device-revoked", epoch: this.currentEpoch, deviceId: target, revoked: false });
        for (const session of this.sessions) {
          try {
            session.send(outbound);
          } catch {
          }
        }
      }
      return new Response(JSON.stringify({ deviceId: target, revoked }), { headers: { "Content-Type": "application/json" } });
    }
    const upgradeHeader = request.headers.get("Upgrade");
    if (!upgradeHeader || upgradeHeader !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }
    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);
    server.accept();
    this.sessions.add(server);
    this.ensureHeartbeat();
    server.addEventListener("message", (event) => {
      try {
        const raw = typeof event.data === "string" ? event.data : "";
        if (!raw) return;
        const msg = JSON.parse(raw);
        if (msg.type === "ping") {
          server.send(JSON.stringify({ type: "pong", epoch: this.currentEpoch, server_ts: Date.now() }));
          return;
        }
        if (msg.type === "hello") {
          const deviceId = String(msg.deviceId || "").slice(0, 128);
          if (!deviceId) return;
          void (async () => {
            const devices = await this.readDevices();
            const now = Date.now();
            const existing = devices[deviceId];
            if (existing?.revoked) {
              try {
                server.send(JSON.stringify({ type: "device-revoked", epoch: this.currentEpoch, deviceId }));
              } catch {
              }
              this.closeSession(server);
              return;
            }
            devices[deviceId] = {
              deviceId,
              deviceName: String(msg.deviceName || existing?.deviceName || "Appareil").slice(0, 80),
              platform: String(msg.platform || existing?.platform || "unknown").slice(0, 32),
              firstSeen: existing?.firstSeen ?? now,
              lastSeen: now,
              revoked: false
            };
            await this.writeDevices(devices);
            this.sessionDevices.set(server, deviceId);
            try {
              server.send(JSON.stringify({ type: "welcome", epoch: this.currentEpoch, deviceId, server_ts: now }));
            } catch {
            }
          })();
          return;
        }
        const senderDevice = this.sessionDevices.get(server);
        if (senderDevice) {
          void this.readDevices().then((devices) => {
            if (devices[senderDevice]?.revoked) this.closeSession(server);
          });
        }
        if (msg.type === "db:changed" || msg.type === "log_appended") {
          const now = Date.now();
          let timestamps = this.rateLimits.get(server);
          if (!timestamps) {
            timestamps = [];
            this.rateLimits.set(server, timestamps);
          }
          timestamps = timestamps.filter((t) => now - t < 1e3);
          if (timestamps.length >= 10) {
            return;
          }
          timestamps.push(now);
          this.rateLimits.set(server, timestamps);
          this.currentEpoch = Math.max(this.currentEpoch + 1, (msg.epoch || 0) + 1);
          const outbound = JSON.stringify({
            type: msg.type,
            epoch: this.currentEpoch,
            deviceId: msg.deviceId,
            table: msg.table,
            maxHlc: msg.maxHlc
          });
          for (const session of this.sessions) {
            if (session !== server) {
              try {
                session.send(outbound);
              } catch {
                this.forgetSession(session);
              }
            }
          }
        }
      } catch {
      }
    });
    const closeHandler = /* @__PURE__ */ __name(() => {
      this.forgetSession(server);
      if (this.sessions.size === 0 && this.pingInterval) {
        clearInterval(this.pingInterval);
        this.pingInterval = null;
      }
    }, "closeHandler");
    server.addEventListener("close", closeHandler);
    server.addEventListener("error", closeHandler);
    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }
};
var src_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] === "room" && parts[1]) {
      const merchantId = parts[1];
      const id = env.MERCHANT_ROOM.idFromName(merchantId);
      const room = env.MERCHANT_ROOM.get(id);
      if (parts[2] === "devices" && request.headers.get("Upgrade") !== "websocket") {
        const adminSecret = env.ADMIN_SECRET ?? "";
        if (!adminSecret) {
          return new Response(JSON.stringify({ error: "admin routes disabled" }), {
            status: 503,
            headers: { "Content-Type": "application/json" }
          });
        }
        const auth = request.headers.get("Authorization") || "";
        const presented = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
        if (presented !== adminSecret) {
          return new Response(JSON.stringify({ error: "unauthorized" }), {
            status: 401,
            headers: { "Content-Type": "application/json" }
          });
        }
        if (request.method === "GET" && parts.length === 3) {
          return room.fetch(new Request(new URL("/__devices", request.url), { method: "GET" }));
        }
        if ((request.method === "POST" || request.method === "PUT") && parts.length === 5 && parts[4] === "revoke") {
          const target = new URL("/__revoke", request.url);
          target.searchParams.set("deviceId", parts[3]);
          const body = await request.text().catch(() => "");
          target.searchParams.set("revoked", body.includes("false") ? "false" : "true");
          return room.fetch(new Request(target, { method: "POST" }));
        }
        return new Response("Not found", { status: 404 });
      }
      return room.fetch(request);
    }
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok", time: (/* @__PURE__ */ new Date()).toISOString() }), {
        headers: { "Content-Type": "application/json" }
      });
    }
    return new Response("MobiPOS Signal Relay - WebSocket required at /room/:merchantId", {
      status: 404
    });
  }
};

// ../../../../AppData/Local/npm-cache/_npx/d77349f55c2be1c0/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// ../../../../AppData/Local/npm-cache/_npx/d77349f55c2be1c0/node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    const body = JSON.stringify(error);
    const headers = {
      "Content-Type": "application/json",
      "MF-Experimental-Error-Stack": "true"
    };
    const encoded = encodeURIComponent(body);
    if (encoded.length <= 8192) {
      headers["MF-Experimental-Error-Stack-Payload"] = encoded;
    }
    return new Response(body, { status: 500, headers });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-7C09hS/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = src_default;

// ../../../../AppData/Local/npm-cache/_npx/d77349f55c2be1c0/node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-7C09hS/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  scheduledTime;
  cron;
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  MerchantRoom,
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=index.js.map
