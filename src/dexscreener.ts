// Fetches $GW token stats from DexScreener and formats them. Formatters are
// ported verbatim from gacha-wiki/src/components/TokenBanner.astro so the bot's
// presence text matches the site banner's chip exactly.

import {
  DEXSCREENER_TIMEOUT_MS,
  DEXSCREENER_URL,
  GW_CHAIN_ID,
} from "./config";

/** Raw numeric stats extracted from the DexScreener response. Null = unavailable. */
export interface Stats {
  /** Epoch ms when these stats were fetched. */
  ts: number;
  /** Spot price in USD. */
  price: number | null;
  /** 24h price change, percent. */
  change24h: number | null;
  /** 1h price change, percent. */
  change1h: number | null;
  /** Fully-diluted valuation in USD (the banner treats this as market cap). */
  mc: number | null;
  /** 24h volume in USD. */
  volume24h: number | null;
  /** Liquidity in USD. */
  liquidity: number | null;
}

/**
 * Format a USD price. Three tiers, matching TokenBanner.astro lines 260-264:
 *   >= 1       -> 4 decimals
 *   >= 0.0001  -> 6 decimals
 *   otherwise  -> 4 significant figures (sub-microcent stability)
 */
export function fmtPrice(usd: number): string {
  if (usd >= 1) return `$${usd.toFixed(4)}`;
  if (usd >= 0.0001) return `$${usd.toFixed(6)}`;
  return `$${usd.toPrecision(4)}`;
}

/**
 * Format a percentage change. Matches TokenBanner.astro lines 273-277:
 * explicit '+' sign for non-negative, one decimal, empty on null/NaN.
 */
export function fmtPct(p: number | null): string {
  if (p == null || !isFinite(p)) return "";
  const sign = p >= 0 ? "+" : "";
  return `${sign}${p.toFixed(1)}%`;
}

/**
 * Format a large USD amount with K/M suffix. Matches TokenBanner.astro lines
 * 266-271: M (2dp) -> K (1dp) -> whole dollars. No B tier.
 */
export function fmtUsd(usd: number | null): string {
  if (usd == null || !isFinite(usd)) return "";
  if (usd >= 1e6) return `$${(usd / 1e6).toFixed(2)}M`;
  if (usd >= 1e3) return `$${(usd / 1e3).toFixed(1)}K`;
  return `$${usd.toFixed(0)}`;
}

/** Shape of the DexScreener /latest/dex/tokens response we actually read. */
interface DexScreenerResponse {
  pairs?: Array<{
    chainId?: string;
    priceUsd?: string;
    fdv?: number;
    liquidity?: { usd?: number };
    volume?: { h24?: number };
    priceChange?: { h24?: number; h1?: number };
  }>;
}

/**
 * Fetch fresh $GW stats. Prefers the Robinhood Chain pair, falls back to the
 * first pair (same logic as TokenBanner.astro lines 357-360). Returns null on
 * any failure so the caller can fall back to last-known stats.
 *
 * @param fetchImpl Cloudflare's bound fetch (injected for testability).
 */
export async function fetchGwStats(
  fetchImpl: typeof fetch = fetch,
): Promise<Stats | null> {
  try {
    const res = await fetchImpl(DEXSCREENER_URL, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(DEXSCREENER_TIMEOUT_MS),
    });
    if (!res.ok) return null;

    const json = (await res.json()) as DexScreenerResponse;
    const pairs = json.pairs ?? [];
    // Prefer the Robinhood Chain pair; fall back to the first pair.
    const pair = pairs.find((p) => p.chainId === GW_CHAIN_ID) ?? pairs[0];
    if (!pair) return null;

    return {
      ts: Date.now(),
      price: pair.priceUsd ? parseFloat(pair.priceUsd) : null,
      change24h: pair.priceChange?.h24 ?? null,
      change1h: pair.priceChange?.h1 ?? null,
      // Market cap uses the `fdv` field, matching the banner.
      mc: pair.fdv ?? null,
      volume24h: pair.volume?.h24 ?? null,
      liquidity: pair.liquidity?.usd ?? null,
    };
  } catch {
    // Network error, timeout, or parse failure — caller falls back to last-known.
    return null;
  }
}
