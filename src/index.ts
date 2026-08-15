// Worker entry point — routes incoming fetch() and scheduled() events.
//   GET  /               -> bootstrap the gateway DO (returns "ok")
//   POST /interactions   -> Discord slash commands (/verify, /check), Ed25519-verified
//   POST /verifylink     -> the wiki's verify page submits {code, address, signature}
// Re-exports the DO class so Wrangler can bind it.

import { GatewayDO } from "./gateway";
import { RH_RPC } from "./config";
import { setGeneralRpcUrl } from "./evm";
import {
  doStore,
  handleVerifyInteraction,
  handleVerifyLink,
} from "./verify";

export { GatewayDO };

/** Worker bindings: the DO binding name matches wrangler.toml + the secret. */
interface Env {
  GATEWAY: DurableObjectNamespace;
  DISCORD_TOKEN: string;
  /** Discord channel id for the buys/sells/burns feed. Optional — empty = disabled. */
  BUYS_CHANNEL_ID?: string;
  /** Guild whose members get the OG Holder role. */
  GUILD_ID: string;
  /** The OG Holder role id (created via Discord REST). */
  OG_ROLE_ID: string;
  /** Alchemy endpoint for general RPC calls (secret; free tier 10-block getLogs cap means logs stay on the public RPC). */
  ALCHEMY_URL?: string;
}

/** Stable id for the singleton DO instance. */
const SINGLETON_ID = "primary";

function getGatewayStub(env: Env): DurableObjectStub {
  const id = env.GATEWAY.idFromName(SINGLETON_ID);
  return env.GATEWAY.get(id);
}

// ---------------------------------------------------------------------------
// Ed25519 interaction-signature verification (Discord requirement)
// ---------------------------------------------------------------------------

/** Cached Ed25519 public key of our Discord application (per isolate). */
let cachedVerifyKey: CryptoKey | null = null;

/** Fetch the application's verify key via the bot token and import it. */
async function getVerifyKey(token: string): Promise<CryptoKey> {
  if (cachedVerifyKey) return cachedVerifyKey;
  const res = await fetch("https://discord.com/api/v10/oauth2/applications/@me", {
    headers: { Authorization: `Bot ${token}` },
  });
  if (!res.ok) throw new Error(`app fetch ${res.status}`);
  const app = (await res.json()) as { verify_key?: string };
  if (!app.verify_key) throw new Error("no verify_key");
  cachedVerifyKey = await crypto.subtle.importKey(
    "raw",
    hexToBytes(app.verify_key),
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  return cachedVerifyKey;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** True when the request carries a valid Discord Ed25519 signature. */
async function interactionIsAuthentic(
  request: Request,
  body: string,
  token: string,
): Promise<boolean> {
  const sig = request.headers.get("x-signature-ed25519");
  const ts = request.headers.get("x-signature-timestamp");
  if (!sig || !ts) return false;
  const key = await getVerifyKey(token);
  const data = new TextEncoder().encode(ts + body);
  return crypto.subtle.verify("Ed25519", key, hexToBytes(sig), data);
}

// ---------------------------------------------------------------------------
// CORS for the wiki's verify page
// ---------------------------------------------------------------------------

/** Allowed browser origins for /verifylink (site + local dev). */
const VERIFY_ALLOWED_ORIGINS = new Set([
  "https://gachawiki.net",
  "http://localhost:4321",
  "http://127.0.0.1:4321",
]);

function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("origin") ?? "";
  return {
    ...(VERIFY_ALLOWED_ORIGINS.has(origin)
      ? { "access-control-allow-origin": origin }
      : {}),
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
  };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    setGeneralRpcUrl(env.ALCHEMY_URL);
    const url = new URL(request.url);

    // Discord slash-command interactions.
    if (url.pathname === "/interactions" && request.method === "POST") {
      const body = await request.text();
      let authentic = false;
      try {
        authentic = await interactionIsAuthentic(request, body, env.DISCORD_TOKEN);
      } catch (err) {
        console.error("[interactions] verify key fetch failed:", err);
      }
      if (!authentic) {
        return new Response("invalid request signature", { status: 401 });
      }
      const interaction = JSON.parse(body) as Parameters<
        typeof handleVerifyInteraction
      >[2];
      const store = doStore(getGatewayStub(env));
      const reply = await handleVerifyInteraction(env, store, interaction);
      return Response.json(reply);
    }

    // The wiki's verify page submits signed codes here.
    if (url.pathname === "/verifylink" && request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }
    if (url.pathname === "/verifylink" && request.method === "POST") {
      let body: { code?: unknown; address?: unknown; signature?: unknown };
      try {
        body = (await request.json()) as typeof body;
      } catch {
        return Response.json({ ok: false, error: "bad_json" }, { status: 400 });
      }
      const outcome = await handleVerifyLink(
        {
          DISCORD_TOKEN: env.DISCORD_TOKEN,
          GUILD_ID: env.GUILD_ID,
          OG_ROLE_ID: env.OG_ROLE_ID,
          getStub: () => getGatewayStub(env),
        },
        body,
      );
      return Response.json(outcome.json, {
        status: outcome.status,
        headers: corsHeaders(request),
      });
    }

    // Chain-source health probe: general RPC (Alchemy when configured) and
    // the public RPC used for eth_getLogs.
    if (url.pathname === "/rpc-health") {
      const body = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_blockNumber",
        params: [],
      });
      const probe = async (target: string, label: string) => {
        try {
          const res = await fetch(target, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
            signal: AbortSignal.timeout(8_000),
          });
          return { label, status: res.status };
        } catch {
          return { label, status: 0 };
        }
      };
      const general = env.ALCHEMY_URL ?? RH_RPC;
      return Response.json({
        general: await probe(general, general.includes("g.alchemy.com") ? "alchemy" : "public"),
        logsRpc: await probe(RH_RPC, "public"),
      });
    }

    // Token-guarded admin: rewind feed cursors so the feeds replay missed
    // blocks through their normal path (used after an outage backfill).
    if (url.pathname === "/do/seed" && request.method === "POST") {
      if (request.headers.get("x-admin-token") !== env.DISCORD_TOKEN) {
        return new Response("forbidden", { status: 403 });
      }
      // Forward as POST — stub.fetch(string) would otherwise default to GET.
      return getGatewayStub(env).fetch(request.url, { method: "POST" });
    }

    // Default: bootstrap the DO's gateway connection (curl / works).
    const stub = getGatewayStub(env);
    return stub.fetch("https://do/bootstrap");
  },

  /**
   * Cron trigger (every 1 min). Wakes the DO so its alarm() can heartbeat and
   * push presence — and re-bootstraps the WebSocket if it ever dropped.
   */
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(getGatewayStub(env).fetch("https://do/watchdog"));
  },
} satisfies ExportedHandler<Env>;
