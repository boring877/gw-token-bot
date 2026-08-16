# CLAUDE.md — gw-token-bot (GachaWiki $GW Discord bot)

## What this is
A Discord bot for the GachaWiki $GW token. Live in production on Cloudflare Workers + a Durable Object. Two features, both shipped:
1. **Presence ticker** — cycles `$GW` price/24h/1h/MC/vol/liq every ~60s under the bot's name (mirrors `gacha-wiki/src/components/TokenBanner.astro`).
2. **On-chain swap feed** — polls `eth_getLogs` on the GW/WETH Uniswap V3 pool every ~10s, posts buy/sell embeds to `#gw-buys`.

- **Repo:** https://github.com/boring877/gw-token-bot
- **Production:** https://gacha-wiki-bot.elfhuyace.workers.dev
- **Cloudflare account:** elfhuyace@gmail.com
- **Local path:** `C:\Users\Borin\ZCodeProject\gacha-wiki-bot\` (folder name differs from repo — historical)

## Environment
- OS: Windows 11. Package manager is **Bun** — use `bun`/`bunx`, not `npm`. (`bun` lives at `/c/Users/Borin/.bun/bin/bun.exe` — not always on PATH in Git Bash.)
- Cloudflare CLI: `bunx wrangler`. Already authenticated as elfhuyace@gmail.com.
- GitHub CLI: `gh` at `/c/Program Files/GitHub CLI/gh.exe`. Authenticated as boring877.

## Critical rules (DO NOT violate)
- **Never commit `.dev.vars`** — it holds the Discord token + channel ID. Already gitignored; leave it that way.
- **Never paste secrets into chat.** If a token leaks, reset it in the Discord portal and re-run `wrangler secret put DISCORD_TOKEN`.
- ⚠️ **The current Discord token was pasted in chat during the 2026-08-11 build session.** Treat it as leaked. Rotate when convenient.
- Every new source file starts with a one-line comment describing what it does (matches the gacha-wiki repo convention).

## Architecture (key gotchas — learned the hard way)
- **The DO uses an OUTBOUND client WebSocket to Discord, NOT the Hibernation API.** `acceptWebSocket()` is inbound-only; this was originally mis-planned as hibernation-based. The DO stays alive for the whole gateway session (~85% of the free-tier daily GB-s budget).
- **Local dev (miniflare) does NOT auto-fire DO storage alarms** on a wall clock. The cron endpoint `/cdn-cgi/local/scheduled` exists but didn't reliably invoke `scheduled()`. To test the feed locally, temporarily add a debug fetch route that calls `tickSwapFeed()` directly, then remove it. In production, alarms fire normally.
- **Orphaned workerd/node processes lock the SQLite state files on Windows.** If `wrangler dev` behaves weirdly, kill all node/workerd processes (PowerShell or Task Manager), `rm -rf .wrangler/state`, then reboot.

## Contract details (verified on-chain 2026-08-11)
- $GW: `0x50bE7832849EFEdB15611799074FcC409522f27A` (18 decimals)
- WETH: `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` (18 decimals)
- Pool (UniswapV3Pool, fee 10000/1%): `0xa9fFaF245686212F7c6F73e7ccd1592e9A5B4923`
- Chain: Robinhood Chain id 4663. RPC: `https://rpc.mainnet.chain.robinhood.com`
- In the V3 `Swap` event: amount0 = WETH, amount1 = GW. BUY of GW = a0>0 & a1<0; SELL = a0<0 & a1>0.
- **Note:** the wiki's `swap.ts` factory getPool does NOT list this pool — it's a custom/pool-direct deployment, though Blockscout verifies it as standard UniswapV3Pool.

## Source-of-truth mirroring
`src/dexscreener.ts` formatters (`fmtPrice`/`fmtPct`/`fmtUsd`) are ported verbatim from `gacha-wiki/src/components/TokenBanner.astro`. If the banner's formatting ever changes, update the bot to match.

## Deploying changes
```bash
bunx wrangler deploy    # ships new code
bunx wrangler secret put DISCORD_TOKEN    # only if token changed
```
The cron trigger (`* * * * *`) wakes the DO every minute as a watchdog.

## Known gaps / future work
- The hardcoded buy-GIF URLs in `src/swapfeed.ts` (`BUY_GIFS`) were placeholders and mostly 404 (verified: 4 of 5 dead). Sells have no GIFs. To fix properly: get a free Tenor API key (their public API now requires one) and search live, OR have the user paste verified URLs.
- No `/price` slash command yet. No price alerts. No per-server channel config (currently one global `BUYS_CHANNEL_ID`).
- No minimum USD threshold on the feed (fine for now — pool volume is very low, ~1 swap per few hours).

## Session history
Built and deployed in a single session on 2026-08-11. Full context (design decisions, failed approaches, why Cloudflare was chosen over a VM, contract verification) is in the gachawiki project skill at `~/.agents/skills/gachawiki/SKILL.md` under "The $GW Discord bot".
