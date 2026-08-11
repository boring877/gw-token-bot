# gacha-wiki-bot

Discord presence ticker for the **GachaWiki $GW token**. The bot stays online 24/7 on Cloudflare's free tier and cycles its activity text through the token's live stats every minute — price → 24h → 1h → MC → vol → liq — the same six slots the site's `TokenBanner` shows.

Data source: **DexScreener** (`api.dexscreener.com/latest/dex/tokens/<CA>`), identical to the wiki site, so the numbers always match.

## How it works

```
                ┌─────────────────────────────────────────────┐
                │  Cloudflare Worker (gacha-wiki-bot)         │
   fetch / ───►  │  routes to the singleton GatewayDO         │
   cron 1m ───►  │                                             │
                │  ┌───────────────────────────────────────┐  │
                │  │ GatewayDO (Durable Object, SQLite)    │  │
                │  │  • holds an OUTBOUND WS to Discord    │  │
                │  │  • heartbeat + presence driven by     │  │
                │  │    storage alarms                      │  │
                │  │  • fetches DexScreener, pushes OP 3   │  │
                │  └───────────────────────────────────────┘  │
                └───────────┬───────────────┬─────────────────┘
                            │ wss://        │ https://
                            ▼               ▼
                     Discord gateway   DexScreener API
```

- **Outbound client WebSocket**: the DO connects *to* Discord's gateway (Discord is the server). The connection stays open for as long as the bot is online.
- **Storage alarms** drive the two timers — heartbeat (~every 41s, per Discord's HELLO) and presence (~every 60s). Each alarm reschedules the next.
- **Cron watchdog** (every 1 min): if the WS ever drops and no alarm is pending, this wakes the DO to reconnect.
- **No privileged intents** — the bot only *sets* its own presence; it doesn't read anyone else's.

> ⚠️ **Free-tier note:** because the outbound WebSocket cannot use the Hibernation API (hibernation is inbound-only), the DO stays active 24/7 and consumes wall-clock compute. At 128MB this is roughly ~85% of the Workers Free plan's 13,000 GB-s/day budget. It fits, but with limited headroom — see "Free-tier budget" below.

## Token it tracks

- **Contract:** `0x50bE7832849EFEdB15611799074FcC409522f27A`
- **Chain:** Robinhood Chain (DexScreener `chainId === "robinhood"`)
- **Market cap** = DexScreener's `fdv` field (matches the site banner).

## Files

| File | Role |
|---|---|
| `src/index.ts` | Worker entry — routes `fetch` / `scheduled` to the DO. |
| `src/gateway.ts` | `GatewayDO` — gateway protocol, WS hibernation, presence loop. |
| `src/dexscreener.ts` | DexScreener fetch + formatters (`fmtPrice`/`fmtPct`/`fmtUsd`), ported from `TokenBanner.astro`. |
| `src/presence.ts` | Builds OP 3 PRESENCE UPDATE payloads, cycling the six stats. |
| `src/config.ts` | Constants — CA, gateway opcodes, intervals. |

---

## Setup

### 1. Create the Discord application

1. Go to the **[Discord Developer Portal](https://discord.com/developers/applications)** → **New Application**. Name it (e.g. "GachaWiki $GW").
2. Open the **Bot** tab → **Reset Token** → copy the token. This is your `DISCORD_TOKEN`.
3. **OAuth2 → URL Generator**: tick scope **`bot`**; under permissions tick **Send Messages** + **Read Message History** (not strictly required for v1 presence, but future-proofs v2 commands).
4. Open the generated URL and add the bot to your server.

> No privileged intents needed. Leave all three intent toggles off.

### 2. Local dev

```bash
cd gacha-wiki-bot
bun install
cp .dev.vars.example .dev.vars   # then edit .dev.vars and paste your bot token
bunx wrangler dev
```

You should see `[gateway] connecting`, `[gateway] sent IDENTIFY`, `[gateway] READY` in the console, and the bot will appear online in Discord with `$GW $...` as its activity. The presence text cycles every ~60s.

To bootstrap the connection locally, hit the worker once:

```bash
curl http://localhost:8787/
```

### 3. Deploy to Cloudflare

```bash
bunx wrangler login                              # one-time; pick the same account as the wiki if you want them together
bunx wrangler secret put DISCORD_TOKEN           # paste the bot token when prompted
bunx wrangler deploy                             # first deploy runs the DO migration
```

Then bootstrap the connection once:

```bash
curl https://gacha-wiki-bot.<your-subdomain>.workers.dev/
```

Watch the bot go online. The cron trigger keeps it alive.

---

## Free-tier budget

- **Durable Objects**: free on the Workers Free plan since April 2025 (SQLite backend required — we use it).
- **Compute duration**: 13,000 GB-s/day free. Holding the gateway WS open 24/7 at 128MB uses ~11,000 GB-s/day (~85% of budget). **It fits, but there's only ~4h of headroom for any other Workers/DO usage on the same account.** If you run other Workers that also use meaningful compute, this bot may push you over.
- **Cron triggers**: free, no daily limit on the free plan.
- **DexScreener**: free, ~60 req/min; we poll once per minute.

> If the budget headroom becomes a problem, the cleanest mitigation is upgrading to the $5/mo Workers Paid plan (10M requests + 400,000 GB-s/day included) — that eliminates the constraint entirely.

## Resilience

- DexScreener down → presence keeps last-known value, retries next cycle.
- WS dropped → the `close` listener schedules a reconnect alarm; the DO tries RESUME first using the stored `session_id` + `seq`, falling back to a fresh IDENTIFY.
- Cron watchdog backstops everything — even a fully-evicted DO is revived within 1 minute.

## Future (not in v1)

- `/price` slash command — fresh embed on demand.
- Channel ticker — one embed the bot re-edits each minute.
- Price alerts — mirror the `/swap` alerts feature (needs per-user storage).
