// GatewayDO — a Durable Object that owns the persistent Discord gateway
// WebSocket connection (as an outbound CLIENT to Discord) and pushes presence
// updates on a timer.
//
// IMPORTANT: this uses a plain outbound WebSocket, NOT the Hibernation API.
// acceptWebSocket() only applies to inbound/server-side sockets; Discord's
// gateway is the server and we connect to it, so hibernation is not an option.
// The DO stays alive for as long as the outbound WS is open, which consumes
// wall-clock compute duration (~85% of the free-tier daily budget at 128MB).

import {
  BURN_MINT_POLL_INTERVAL_MS,
  GATEWAY_URL,
  INTENTS,
  MAX_ALARM_DELAY_MS,
  OP,
  OP_RECV,
  PRESENCE_INTERVAL_MS,
  SWAP_POLL_INTERVAL_MS,
} from "./config";
import { fetchLatestBlock } from "./evm";
import { fetchGwStats, type Stats } from "./dexscreener";
import { buildStatSlots, presenceForIndex } from "./presence";
import {
  formatBurstMessage,
  formatSwapMessage,
  isBurst,
  pollSwaps as pollSwapsFeed,
} from "./swapfeed";
import { formatBurnMessage, pollBurns } from "./burnfeed";
import { ogBalanceOf, fetchTotalSupply, formatMintMessage, pollMints } from "./nftfeed";
import { postChannelMessage } from "./discord-rest";
import {
  codeKey,
  memberKey,
  removeOgRole,
  walletKey,
  type VerifyCodeEntry,
  type WalletLink,
} from "./verify";

/**
 * Persistent state held in the DO's SQLite storage. Survives eviction — the
 * session_id + seq let us RESUME after a reconnect instead of re-IDENTIFYing.
 */
interface GatewayState {
  /** Discord session_id from READY — needed to RESUME across reconnects. */
  sessionId: string | null;
  /** Session-specific resume URL from READY, used on reconnect. */
  resumeUrl: string | null;
  /** Last sequence number received — sent with heartbeats and RESUME. */
  seq: number | null;
  /** Negotiated heartbeat interval (ms) from the HELLO payload. */
  heartbeatIntervalMs: number;
  /** Epoch ms when we should next send a heartbeat. */
  nextHeartbeat: number;
  /** Epoch ms when we should next refresh stats + push presence. */
  nextPresence: number;
  /** Epoch ms when we should next poll for new swaps. */
  nextSwapPoll: number;
  /** Epoch ms when we should next poll for burns. */
  nextBurnPoll: number;
  /** Epoch ms when we should next poll for OG mints. */
  nextMintPoll: number;
  /** Active 429 backoff (ms), 0 = none. Doubles per consecutive failure, 60s cap. */
  rpcBackoffMs: number;
  /** Current index into the stat cycle (0..5). */
  statIndex: number;
  /** Last-known stats (for fallback when DexScreener is unreachable). */
  lastStats: Stats | null;
  /** True once we've received READY or RESUMED for this session. */
  identified: boolean;
  /** --- Swap feed state --- **/
  /** Highest block scanned by the feed. 0 = never polled. */
  lastBlock: number;
  /** Cached ETH USD price (for converting WETH to USD in messages). */
  ethPriceUsd: number | null;
  /** Epoch ms when ethPriceUsd was refreshed. */
  ethPriceTs: number;
  /** --- Burn feed state --- **/
  /** Highest block scanned for $GW burns (Transfer-to-dead). 0 = never polled. */
  burnLastBlock: number;
  /** --- NFT mint feed state --- **/
  /** Highest block scanned for OG mints. 0 = never polled. */
  mintLastBlock: number;
}

/** Initial state for a fresh DO that has never connected. */
const FRESH_STATE: GatewayState = {
  sessionId: null,
  resumeUrl: null,
  seq: null,
  heartbeatIntervalMs: 0,
  nextHeartbeat: 0,
  nextPresence: 0,
  nextSwapPoll: 0,
  nextBurnPoll: 0,
  nextMintPoll: 0,
  rpcBackoffMs: 0,
  statIndex: 0,
  lastStats: null,
  identified: false,
  lastBlock: 0,
  ethPriceUsd: null,
  ethPriceTs: 0,
  burnLastBlock: 0,
  mintLastBlock: 0,
};

/** ETH USD price cache TTL — refresh at most every 5 min. */
const ETH_PRICE_TTL_MS = 5 * 60_000;

/**
 * Fetch the current ETH USD price from Coingecko's simple price endpoint
 * (free, no key). Returns null on failure so callers degrade gracefully.
 */
async function fetchEthPriceUsd(): Promise<number | null> {
  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd",
      { signal: AbortSignal.timeout(5_000) },
    );
    if (!res.ok) return null;
    const json = (await res.json()) as {
      ethereum?: { usd?: number };
    };
    const p = json.ethereum?.usd;
    return typeof p === "number" ? p : null;
  } catch {
    return null;
  }
}

/** Discord gateway READY/RESUMED dispatch payload fields we read. */
interface ReadyPayload {
  session_id?: string;
  resume_gateway_url?: string;
}

interface DiscordMessage {
  op: number;
  s?: number;
  t?: string;
  d?: unknown;
}

interface GatewayEnv {
  DISCORD_TOKEN: string;
  /** Discord channel id for the buys/sells feed. Empty = feed disabled. */
  BUYS_CHANNEL_ID?: string;
  /** Guild for OG holder verification. */
  GUILD_ID?: string;
  /** OG Holder role id for verification. */
  OG_ROLE_ID?: string;
}

export class GatewayDO implements DurableObject {
  private state: DurableObjectState;
  private env: GatewayEnv;
  /** In-memory snapshot of persistent state, hydrated on first use. */
  private mem: GatewayState = { ...FRESH_STATE };
  private hydrated = false;
  /** The live outbound WebSocket to Discord, or null if not connected. */
  private ws: WebSocket | null = null;

  constructor(state: DurableObjectState, env: GatewayEnv) {
    this.state = state;
    this.env = env;
  }

  // --------------------------------------------------------------------------
  // Lifecycle: fetch (bootstrap) and alarm (heartbeat + presence + watchdog)
  // --------------------------------------------------------------------------

  /**
   * Called by the Worker's fetch() handler. Also serves as the DO's internal
   * storage API for the verify flow (/do/code, /do/wallet) — see verify.ts.
   */
  async fetch(request: Request): Promise<Response> {
    await this.hydrate();
    const url = new URL(request.url);
    const path = url.pathname;

    // ---- verify-flow storage routes ----
    if (path === "/do/code") {
      const code = url.searchParams.get("code");
      if (request.method === "PUT") {
        const body = (await request.json()) as VerifyCodeEntry & { code?: string };
        if (!body.code) return new Response(null, { status: 400 });
        await this.state.storage.put(codeKey(body.code), {
          memberId: body.memberId,
          guildId: body.guildId,
          expires: body.expires,
        });
        return new Response(null, { status: 204 });
      }
      if (request.method === "DELETE") {
        if (code) await this.state.storage.delete(codeKey(code));
        return new Response(null, { status: 204 });
      }
      if (request.method === "GET" && code) {
        const entry = await this.state.storage.get<VerifyCodeEntry>(codeKey(code));
        return entry
          ? Response.json(entry)
          : new Response(null, { status: 204 });
      }
      return new Response(null, { status: 405 });
    }

    if (path === "/do/wallet") {
      const address = url.searchParams.get("address");
      const memberId = url.searchParams.get("memberId");
      if (request.method === "PUT") {
        const body = (await request.json()) as WalletLink & { address?: string };
        if (!body.address) return new Response(null, { status: 400 });
        const addr = body.address.toLowerCase();
        // Write both directions of the link (wallet -> member and back).
        await Promise.all([
          this.state.storage.put(walletKey(addr), {
            memberId: body.memberId,
            guildId: body.guildId,
            linkedAt: body.linkedAt,
          }),
          this.state.storage.put(memberKey(body.memberId), addr),
        ]);
        return new Response(null, { status: 204 });
      }
      if (request.method === "DELETE") {
        if (address) {
          const addr = address.toLowerCase();
          const link = await this.state.storage.get<WalletLink>(walletKey(addr));
          await this.state.storage.delete(walletKey(addr));
          if (link) await this.state.storage.delete(memberKey(link.memberId));
        }
        return new Response(null, { status: 204 });
      }
      if (request.method === "GET") {
        if (address) {
          const link = await this.state.storage.get<WalletLink>(
            walletKey(address.toLowerCase()),
          );
          return link ? Response.json(link) : new Response(null, { status: 204 });
        }
        if (memberId) {
          const addr = await this.state.storage.get<string>(memberKey(memberId));
          return addr
            ? Response.json({ address: addr })
            : new Response(null, { status: 204 });
        }
      }
      return new Response(null, { status: 405 });
    }

    // ---- default: bootstrap the gateway connection ----
    await this.ensureConnected();
    return new Response("ok\n", {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  /**
   * Fires on the storage alarm. Drives the heartbeat + presence cadence and
   * re-bootstraps the connection if it has dropped. Reschedules itself each
   * time. Also backed up by the Worker's 1-min cron trigger as a watchdog.
   */
  async alarm(): Promise<void> {
    await this.hydrate();

    // Re-bootstrap if the socket is gone or closing.
    if (!this.isSocketOpen()) {
      await this.ensureConnected();
      return;
    }

    const now = Date.now();

    // Heartbeat due?
    if (this.mem.heartbeatIntervalMs > 0 && now >= this.mem.nextHeartbeat) {
      await this.sendHeartbeat();
      this.mem.nextHeartbeat = now + this.mem.heartbeatIntervalMs;
    }

    // Presence update due?
    if (this.mem.identified && now >= this.mem.nextPresence) {
      await this.tickPresence();
      this.mem.nextPresence = now + PRESENCE_INTERVAL_MS;
    }

    // On-chain feed polls due? (only if a channel id is configured)
    const channelId = this.env.BUYS_CHANNEL_ID ?? "";
    const swapDue = now >= this.mem.nextSwapPoll;
    const burnDue = now >= this.mem.nextBurnPoll;
    const mintDue = now >= this.mem.nextMintPoll;
    if (this.mem.identified && channelId && (swapDue || burnDue || mintDue)) {
      // Advance the timers synchronously so a slow RPC can't cause a
      // double poll on the next alarm; 429 backoff inside tickFeeds can
      // push them out further.
      if (swapDue) this.mem.nextSwapPoll = now + SWAP_POLL_INTERVAL_MS;
      if (burnDue) this.mem.nextBurnPoll = now + BURN_MINT_POLL_INTERVAL_MS;
      if (mintDue) this.mem.nextMintPoll = now + BURN_MINT_POLL_INTERVAL_MS;
      // Run without awaiting so a slow RPC can't stall heartbeat/presence.
      void this.tickFeeds(channelId, { swaps: swapDue, burns: burnDue, mints: mintDue });
    }

    await this.persist();
    await this.scheduleNextAlarm();
  }

  // --------------------------------------------------------------------------
  // On-chain feeds — poll eth_getLogs, post new swaps + burns + OG mints.
  // --------------------------------------------------------------------------

  /**
   * One feed tick: refresh ETH price if stale, fetch the chain head ONCE,
   * then run whichever polls are due — swaps (10s cadence), burns and OG
   * mints (60s cadence). Each poll runs in its own try/catch so one feed
   * failing can't kill the others. Errors are logged and swallowed — a
   * failed poll never crashes the DO. A 429 from the public RPC engages an
   * exponential backoff on all feed timers.
   */
  private async tickFeeds(
    channelId: string,
    due: { swaps: boolean; burns: boolean; mints: boolean },
  ): Promise<void> {
    try {
      // Refresh ETH price if older than the TTL.
      if (
        this.mem.ethPriceUsd == null ||
        Date.now() - this.mem.ethPriceTs > ETH_PRICE_TTL_MS
      ) {
        const fresh = await fetchEthPriceUsd();
        if (fresh != null) {
          this.mem.ethPriceUsd = fresh;
          this.mem.ethPriceTs = Date.now();
        }
      }

      // ONE chain-head call per tick, shared by every due feed — the public
      // RPC 429s if each feed polls eth_blockNumber independently.
      let latest: number;
      try {
        latest = await fetchLatestBlock();
      } catch (err) {
        console.warn("[feed] chain head fetch failed:", err);
        if (this.is429(err)) this.applyRpcBackoff();
        return;
      }

      let saw429 = false;

      // Swaps.
      if (due.swaps) {
        try {
          const result = await pollSwapsFeed(
            { lastBlock: this.mem.lastBlock },
            latest,
          );
          // Advance the cursor even if we couldn't decode some logs.
          this.mem.lastBlock = result.latestBlock;

          if (result.swaps.length > 0) {
            if (isBurst(result.swaps.length)) {
              // Collapse a large batch into one summary message.
              const payload = formatBurstMessage(
                result.swaps,
                this.mem.ethPriceUsd,
              );
              await postChannelMessage(this.env.DISCORD_TOKEN, channelId, payload);
              console.log(
                `[feed] burst: ${result.swaps.length} swaps -> 1 summary message`,
              );
            } else {
              // Post each swap individually (chronological order).
              for (const swap of result.swaps) {
                const payload = formatSwapMessage(swap, this.mem.ethPriceUsd);
                try {
                  await postChannelMessage(
                    this.env.DISCORD_TOKEN,
                    channelId,
                    payload,
                  );
                } catch (err) {
                  // One failed post shouldn't abort the rest of the batch.
                  console.warn(`[feed] post failed for ${swap.txHash}:`, err);
                }
              }
              console.log(`[feed] posted ${result.swaps.length} swap(s)`);
            }
          }
        } catch (err) {
          console.warn("[feed] swap poll failed:", err);
          if (this.is429(err)) saw429 = true;
        }
      }

      // $GW burns (Transfer-to-dead).
      if (due.burns) {
        try {
          const burns = await pollBurns(this.mem.burnLastBlock, latest);
          this.mem.burnLastBlock = burns.latestBlock;
          for (const burn of burns.burns) {
            try {
              // USD valuation from the cached DexScreener spot price.
              const payload = formatBurnMessage(
                burn,
                this.mem.lastStats?.price ?? null,
              );
              await postChannelMessage(this.env.DISCORD_TOKEN, channelId, payload);
            } catch (err) {
              console.warn(`[feed] burn post failed for ${burn.txHash}:`, err);
            }
          }
          if (burns.burns.length > 0) {
            console.log(`[feed] posted ${burns.burns.length} burn(s)`);
          }
        } catch (err) {
          console.warn("[feed] burn poll failed:", err);
          if (this.is429(err)) saw429 = true;
        }
      }

      // OG NFT mints (+ transfer watching for role auto-revoke).
      if (due.mints) {
        try {
          const mints = await pollMints(this.mem.mintLastBlock, latest);
          this.mem.mintLastBlock = mints.latestBlock;
          if (mints.mints.length > 0) {
            const supply = await fetchTotalSupply();
            for (const mint of mints.mints) {
              try {
                const payload = formatMintMessage(
                  mint,
                  this.mem.ethPriceUsd,
                  supply,
                );
                await postChannelMessage(
                  this.env.DISCORD_TOKEN,
                  channelId,
                  payload,
                );
              } catch (err) {
                console.warn(`[feed] mint post failed for ${mint.txHash}:`, err);
              }
            }
            console.log(`[feed] posted ${mints.mints.length} mint(s)`);
          }
          // A linked wallet that MOVED an OG may no longer hold one — re-check
          // its balance and drop the role if it hit zero.
          await this.revokeIfEmptied(mints.transfers.map((t) => t.from));
        } catch (err) {
          console.warn("[feed] mint poll failed:", err);
          if (this.is429(err)) saw429 = true;
        }
      }

      if (saw429) {
        this.applyRpcBackoff();
      } else {
        this.mem.rpcBackoffMs = 0;
      }
    } catch (err) {
      console.warn("[feed] tick failed:", err);
    } finally {
      await this.persist();
    }
  }

  /** True when the error is the public RPC rate-limiting us (HTTP 429). */
  private is429(err: unknown): boolean {
    return String((err as Error | undefined)?.message ?? err).includes("429");
  }

  /**
   * Auto-revoke: for each sender of an OG transfer that has a verified
   * wallet link, re-check balanceOf — if they no longer hold any OG, remove
   * the OG Holder role and forget the link. Failures are logged, not thrown
   * (the next transfer re-triggers the check).
   */
  private async revokeIfEmptied(senders: string[]): Promise<void> {
    const guildId = this.env.GUILD_ID ?? "";
    const roleId = this.env.OG_ROLE_ID ?? "";
    if (!guildId || !roleId) return;

    // Deduplicate — batch mints can emit several transfers per sender.
    for (const sender of new Set(senders.map((s) => s.toLowerCase()))) {
      const link = await this.state.storage.get<WalletLink>(walletKey(sender));
      if (!link) continue; // not a verified holder — nothing to do
      try {
        const balance = await ogBalanceOf(sender);
        if (balance == null) continue; // RPC flaked — keep the role for now
        if (balance > 0n) continue; // still holds (moved one, has others)
        await removeOgRole(
          this.env.DISCORD_TOKEN,
          link.guildId,
          roleId,
          link.memberId,
        );
        await this.state.storage.delete(walletKey(sender));
        await this.state.storage.delete(memberKey(link.memberId));
        console.log(`[verify] auto-revoked ${sender} (member ${link.memberId})`);
      } catch (err) {
        console.warn(`[verify] revoke check failed for ${sender}:`, err);
      }
    }
  }

  /**
   * Exponential backoff when the public RPC rate-limits us: push all feed
   * timers out (15s → 30s → 60s cap) so we stop hammering it. Reset on the
   * next fully-successful tick.
   */
  private applyRpcBackoff(): void {
    const backoff = Math.min(
      60_000,
      Math.max(15_000, this.mem.rpcBackoffMs * 2 || 15_000),
    );
    this.mem.rpcBackoffMs = backoff;
    const until = Date.now() + backoff;
    this.mem.nextSwapPoll = Math.max(this.mem.nextSwapPoll, until);
    this.mem.nextBurnPoll = Math.max(this.mem.nextBurnPoll, until);
    this.mem.nextMintPoll = Math.max(this.mem.nextMintPoll, until);
    console.warn(`[feed] rpc 429 — backing off ${backoff / 1000}s`);
  }

  // --------------------------------------------------------------------------
  // Connection management (outbound client WebSocket — no hibernation)
  // --------------------------------------------------------------------------

  /**
   * Open a fresh outbound WebSocket to Discord and attach direct event
   * listeners. No-op if a live connection already exists. Closing the old
   * socket first on reconnect.
   */
  private async ensureConnected(): Promise<void> {
    if (this.isSocketOpen()) return;

    // Tear down a dead/closing socket reference if any.
    this.detachSocket();

    const url =
      this.mem.sessionId && this.mem.resumeUrl ? this.mem.resumeUrl : GATEWAY_URL;

    const ws = new WebSocket(url);
    // Attach listeners BEFORE we store the reference, so no events are missed.
    ws.addEventListener("open", () => {
      console.log(`[gateway] ws open -> ${url}`);
    });
    ws.addEventListener("message", (event: MessageEvent) => {
      void this.onMessage(event.data);
    });
    ws.addEventListener("close", (event: CloseEvent) => {
      console.log(`[gateway] ws close code=${event.code} reason=${event.reason}`);
      this.detachSocket();
      // The alarm loop (or cron watchdog) will reconnect on the next tick.
      void this.scheduleReconnect();
    });
    ws.addEventListener("error", (event: Event) => {
      console.error("[gateway] ws error", event);
      // The close event usually follows; don't detach here or we double-handle.
    });

    this.ws = ws;
    console.log(`[gateway] connecting to ${url}`);
  }

  /** True if we hold a WebSocket that is in the OPEN readyState. */
  private isSocketOpen(): boolean {
    return this.ws !== null && this.ws.readyState === 1; // OPEN
  }

  /** Drop the socket reference and detach listeners (idempotent). */
  private detachSocket(): void {
    if (this.ws) {
      try {
        this.ws.close(4000, "reconnect");
      } catch {
        // Already closed — ignore.
      }
      this.ws = null;
    }
  }

  /** Schedule an alarm shortly so the reconnect happens promptly. */
  private async scheduleReconnect(): Promise<void> {
    await this.state.storage.setAlarm(Date.now() + 3_000);
  }

  // --------------------------------------------------------------------------
  // Incoming message handler — the Discord gateway protocol.
  // --------------------------------------------------------------------------

  private async onMessage(raw: string | ArrayBuffer): Promise<void> {
    await this.hydrate();

    const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
    let msg: DiscordMessage;
    try {
      msg = JSON.parse(text) as DiscordMessage;
    } catch {
      return; // Malformed frame — ignore.
    }

    // Track the sequence number for heartbeats and RESUME.
    if (typeof msg.s === "number") this.mem.seq = msg.s;

    switch (msg.op) {
      case OP_RECV.HELLO:
        await this.onHello(msg.d as { heartbeat_interval?: number });
        break;
      case OP_RECV.DISPATCH:
        await this.onDispatch(msg);
        break;
      case OP_RECV.HEARTBEAT:
        // Server asking us to heartbeat immediately.
        await this.sendHeartbeat();
        break;
      case OP_RECV.HEARTBEAT_ACK:
        // Heartbeat acknowledged — nothing to do.
        break;
      case OP_RECV.RECONNECT:
        // Discord wants us to disconnect and resume. Tear down; alarm reconnects.
        console.log("[gateway] server requested RECONNECT");
        this.detachSocket();
        await this.scheduleReconnect();
        break;
      case OP_RECV.INVALID_SESSION:
        // d is boolean: true = may resume, false = must re-IDENTIFY fresh.
        await this.onInvalidSession(Boolean(msg.d));
        break;
    }
    await this.persist();
    await this.scheduleNextAlarm();
  }

  // --------------------------------------------------------------------------
  // Gateway protocol handlers
  // --------------------------------------------------------------------------

  private async onHello(d: { heartbeat_interval?: number }): Promise<void> {
    const interval = d?.heartbeat_interval ?? 41_250;
    this.mem.heartbeatIntervalMs = interval;
    // First heartbeat goes out after a jittered fraction of the interval,
    // per Discord's recommendation.
    const jitter = Math.random() * interval;
    this.mem.nextHeartbeat = Date.now() + jitter;
    await this.identifyOrResume();
  }

  private async onDispatch(msg: DiscordMessage): Promise<void> {
    if (msg.t === "READY") {
      const d = msg.d as ReadyPayload;
      this.mem.sessionId = d?.session_id ?? null;
      this.mem.resumeUrl = d?.resume_gateway_url ?? null;
      this.mem.identified = true;
      // Push presence immediately on READY so the bot shows stats without
      // waiting for the first 60s tick.
      await this.tickPresence();
      this.mem.nextPresence = Date.now() + PRESENCE_INTERVAL_MS;
      console.log("[gateway] READY");
    } else if (msg.t === "RESUMED") {
      this.mem.identified = true;
      console.log("[gateway] RESUMED");
    }
  }

  private async onInvalidSession(canResume: boolean): Promise<void> {
    if (!canResume) {
      // Discord says our session is invalid — discard it and re-IDENTIFY fresh.
      this.mem.sessionId = null;
      this.mem.seq = null;
    }
    this.detachSocket();
    await this.scheduleReconnect();
  }

  /** Send IDENTIFY (fresh) or RESUME (existing session) depending on state. */
  private async identifyOrResume(): Promise<void> {
    if (this.mem.sessionId != null && this.mem.seq != null) {
      await this.sendRaw({
        op: OP.RESUME,
        d: {
          token: this.env.DISCORD_TOKEN,
          session_id: this.mem.sessionId,
          seq: this.mem.seq,
        },
      });
      console.log("[gateway] sent RESUME");
    } else {
      await this.sendRaw({
        op: OP.IDENTIFY,
        d: {
          token: this.env.DISCORD_TOKEN,
          intents: INTENTS,
          properties: {
            os: "cloudflare",
            browser: "gacha-wiki-bot",
            device: "gacha-wiki-bot",
          },
        },
      });
      console.log("[gateway] sent IDENTIFY");
    }
  }

  private async sendHeartbeat(): Promise<void> {
    await this.sendRaw({ op: OP.HEARTBEAT, d: this.mem.seq });
  }

  // --------------------------------------------------------------------------
  // Presence loop — fetch stats, advance cycle, push OP 3.
  // --------------------------------------------------------------------------

  private async tickPresence(): Promise<void> {
    const fresh = await fetchGwStats();
    const stats = fresh ?? this.mem.lastStats;
    if (!stats) {
      // No data yet and DexScreener unreachable — nothing to show.
      console.log("[gateway] no stats available, skipping presence");
      return;
    }
    this.mem.lastStats = stats;

    const update = presenceForIndex(stats, this.mem.statIndex);
    if (update) {
      await this.sendRawText(update.payload);
      this.mem.statIndex += 1;
      const len = buildStatSlots(stats).length;
      if (this.mem.statIndex >= len) this.mem.statIndex = 0;
    }
  }

  // --------------------------------------------------------------------------
  // Send helpers
  // --------------------------------------------------------------------------

  /** Send a JSON object over the live WebSocket. */
  private async sendRaw(obj: unknown): Promise<void> {
    await this.sendRawText(JSON.stringify(obj));
  }

  /** Send a pre-serialized string over the live WebSocket. */
  private async sendRawText(text: string): Promise<void> {
    if (!this.isSocketOpen()) {
      console.warn("[gateway] no live socket; dropping send");
      return;
    }
    this.ws!.send(text);
  }

  // --------------------------------------------------------------------------
  // Persistence + alarms
  // --------------------------------------------------------------------------

  private async hydrate(): Promise<void> {
    if (this.hydrated) return;
    const stored =
      (await this.state.storage.get<GatewayState>("state")) ?? FRESH_STATE;
    this.mem = { ...FRESH_STATE, ...stored };
    this.hydrated = true;
  }

  private async persist(): Promise<void> {
    await this.state.storage.put("state", this.mem);
  }

  /**
   * Schedule the next alarm at the sooner of the heartbeat and presence
   * deadlines, clamped to a max so the DO can't oversleep.
   */
  private async scheduleNextAlarm(): Promise<void> {
    const now = Date.now();
    const candidates: number[] = [];
    if (this.mem.heartbeatIntervalMs > 0) candidates.push(this.mem.nextHeartbeat);
    if (this.mem.nextPresence > 0) candidates.push(this.mem.nextPresence);
    if (this.mem.nextSwapPoll > 0) candidates.push(this.mem.nextSwapPoll);
    if (this.mem.nextBurnPoll > 0) candidates.push(this.mem.nextBurnPoll);
    if (this.mem.nextMintPoll > 0) candidates.push(this.mem.nextMintPoll);
    let next = candidates.reduce<number>(
      (a, b) => (a && b ? Math.min(a, b) : a || b),
      0,
    );
    if (!next || next <= now) next = now + 5_000;
    next = Math.min(next, now + MAX_ALARM_DELAY_MS);
    await this.state.storage.setAlarm(next);
  }
}
