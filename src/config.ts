// Constants for the GachaWiki $GW Discord bot — token identity, gateway opcodes, timing.

/** $GW ERC-20 token contract on Robinhood Chain. Mirrors TokenBanner.astro / circulating-supply.ts. */
export const GW_CA = "0x50bE7832849EFEdB15611799074FcC409522f27A";

/** DexScreener prefers the lowercase string 'robinhood' as chainId (NOT the chain number 4663). */
export const GW_CHAIN_ID = "robinhood";

/** DexScreener free-tier endpoint. ~60 req/min limit; we poll once per minute, well under cap. */
export const DEXSCREENER_URL = `https://api.dexscreener.com/latest/dex/tokens/${GW_CA}`;

/** Public swap page on the wiki — surfaced in the README/README only for now (v1 = presence only). */
export const SWAP_URL = "https://gachawiki.net/swap";

/**
 * Discord gateway endpoint. JSON encoding over v10 of the gateway protocol.
 * A fixed host works for the initial connection; RESUMED events may give a
 * session-specific resume_gateway_url which the gateway client stores and uses.
 */
export const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";

/** Discord gateway opcodes (send). See https://discord.com/developers/docs/topics/opcodes-and-status-codes */
export const OP = {
  /** Event dispatch (we receive READY, RESUMED). */
  DISPATCH: 0,
  /** Client heartbeat — sent on the negotiated interval. */
  HEARTBEAT: 1,
  /** Client IDENTIFY — open a fresh session after connecting. */
  IDENTIFY: 2,
  /** Client PRESENCE UPDATE — push a new activity. The whole point of v1. */
  PRESENCE_UPDATE: 3,
  /** Client RESUME — replay missed events on a reconnect using session_id + seq. */
  RESUME: 6,
} as const;

/** Discord gateway opcodes (receive). */
export const OP_RECV = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  HEARTBEAT_ACK: 11,
  HELLO: 10,
  RECONNECT: 7,
  INVALID_SESSION: 9,
} as const;

/** Discord gateway intents bitmask. v1 only *sets* presence, so we subscribe to no events. */
export const INTENTS = 0;

/**
 * How often to push a new stat to the presence. Slower than the banner's 3s
 * because (a) Discord rate-limits presence updates to ~5/60s per session, and
 * (b) the stat cycle is six items, so 60s = ~10s average dwell per stat.
 */
export const PRESENCE_INTERVAL_MS = 60_000;

/**
 * Discord allows only ~5 presence updates per 60s. We send at most 1/min, so
 * this is a safety guard — if you lower PRESENCE_INTERVAL_MS below ~12s, you
 * risk being rate-limited (HTTP 429 on the gateway, forcing a backoff).
 */
export const PRESENCE_MIN_INTERVAL_MS = 12_000;

/**
 * How long to cache a DexScreener response before re-fetching. Matches the
 * banner's 60s sessionStorage TTL so the bot and site show the same numbers.
 */
export const DEXSCREENER_TTL_MS = 60_000;

/** Cloudflare `fetch` timeout for DexScreener — fail fast, fall back to last-known stats. */
export const DEXSCREENER_TIMEOUT_MS = 5_000;

/** Hibernation alarm safety upper bound — never schedule an alarm further than this out. */
export const MAX_ALARM_DELAY_MS = 30_000;

// ---------------------------------------------------------------------------
// v2: on-chain swap feed (buys/sells posted to a Discord channel)
// ---------------------------------------------------------------------------

/** Robinhood Chain public RPC. Same one gacha-wiki/src/scripts/swap.ts uses. */
export const RH_RPC = "https://rpc.mainnet.chain.robinhood.com";

/** Robinhood Chain id. */
export const RH_CHAIN_ID = 4663;

/** Blockscout explorer (for tx/address links in embeds). */
export const EXPLORER_URL = "https://robinhoodchain.blockscout.com";

/**
 * Uniswap V3 GW/WETH pool. Verified on Blockscout as a genuine UniswapV3Pool
 * (Solidity 0.7.6). fee() = 10000 (1% tier). token0 = WETH, token1 = GW.
 * Note: the factory in swap.ts does NOT list this pool via getPool — it appears
 * to be a custom/pool-direct deployment, but the ABI is standard V3.
 */
export const POOL_ADDR = "0xa9fFaF245686212F7c6F73e7ccd1592e9A5B4923";

/** WETH9 on Robinhood Chain (token0 in the pool). 18 decimals. */
export const WETH_ADDR = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";

/** $GW token (token1 in the pool). 18 decimals. */
export const GW_ADDR = GW_CA;

/** Both tokens are 18 decimals — simplifies amount formatting. */
export const TOKEN_DECIMALS = 18;

/**
 * Discord channel id where buy/sell messages are posted. Configured via the
 * BUYS_CHANNEL_ID env var (wrangler.toml [vars] + .dev.vars for local dev).
 * If unset/empty, the feed is disabled silently — presence still works.
 * (Kept out of code so channels can change without redeploying.)
 */

/**
 * How often to poll eth_getLogs for new Swap events. 10s gives near-real-time
 * feel without hammering the public RPC.
 */
export const SWAP_POLL_INTERVAL_MS = 10_000;

/**
 * Burn + OG-mint poll cadence. Rare events, but the cadence is sized for the
 * Alchemy-chunked fallback: 30s ≈ 120 new blocks ≈ 12 chunks = exactly the
 * per-lane chunk budget, so burn/mint keep pace with the chain even when the
 * public RPC (primary for getLogs) is rate-limiting us.
 */
export const BURN_MINT_POLL_INTERVAL_MS = 30_000;

/**
 * Maximum block range per feed poll window. Two constraints: some RPCs cap
 * getLogs ranges, and the Alchemy-chunked fallback scans 10 blocks per
 * request with a 100-chunk budget — so this must stay ≤ 1000. Robinhood L2
 * block time is ~0.25-0.3s, so 600 blocks ≈ 2.5-3 min of catch-up per poll.
 */
export const SWAP_POLL_BLOCK_RANGE = 600;

/**
 * If a single poll returns more than this many swaps, batch them into one
 * summary message instead of spamming the channel. Unlikely for $GW given
 * current volume (~1 swap per several hours) but a safety guard.
 */
export const SWAP_BURST_THRESHOLD = 10;

// ---------------------------------------------------------------------------
// v3: burn feed (Transfer-to-dead on the $GW token) + self-hosted GIFs
// ---------------------------------------------------------------------------

/**
 * Public URL of THIS worker. Our custom embed GIFs (generated by
 * tools/make_gifs.py, served from public/gifs/ via wrangler [assets]) are
 * referenced off this base — no third-party image host, no Tenor API key.
 */
export const ASSET_BASE_URL = "https://gacha-wiki-bot.elfhuyace.workers.dev";

/**
 * GachaWiki OGs NFT collection (from the wiki's /nft page) — ERC-721 on the
 * same Robinhood Chain, 1,000 supply, mintable with ETH or $GW. $GW mint
 * payments are burned by the contract (Transfer to 0x…dEaD in the mint tx).
 */
export const NFT_ADDR = "0x9C0f41ce4F8e72F866CC79Acd80386472c53B40B";

/**
 * Art + metadata host for the OGs collection (tokenURI base, a Cloudflare
 * Pages project): /metadata/<id> is JSON, /images/<id>.png is the art.
 */
export const NFT_METADATA_BASE = "https://gachawiki-ogs.pages.dev";

/** Collection max supply — for the "X/1,000 minted" embed footer. */
export const NFT_MAX_SUPPLY = 1000;

// ---------------------------------------------------------------------------
// v4: OG holder verification (OG Holder role gate)
// ---------------------------------------------------------------------------

/**
 * The wiki's verify page URL — linked in the /verify command's ephemeral
 * reply. The wiki's canonical domain is gachawiki.info (astro.config.mjs
 * `site`); gachawiki.net serves an unrelated app and must not be linked.
 */
export const WIKI_VERIFY_URL = "https://gachawiki.info/verify";

/**
 * EIP-191 message a holder signs to prove wallet ownership. MUST match the
 * message the wiki's verify page asks the wallet to sign, character for
 * character (the one-time code is appended).
 */
export const VERIFY_MESSAGE_PREFIX = "GachaWiki OG verification: ";

/** How long a /verify one-time code stays valid. */
export const VERIFY_CODE_TTL_MS = 15 * 60_000;

/**
 * Permanent server invite — used in mint embeds so minters who aren't in the
 * Discord yet can join and verify for the holder channels.
 */
export const DISCORD_INVITE = "https://discord.gg/YdWFddQKR8";
