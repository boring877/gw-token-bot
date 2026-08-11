// Polls the GW/WETH Uniswap V3 pool for new Swap events and formats each as a
// Discord embed. Direction is decoded from the signed amount0/amount1 fields:
//   - amount0 (WETH) > 0 and amount1 (GW) < 0  ->  BUY  (someone bought GW with WETH)
//   - amount0 (WETH) < 0 and amount1 (GW) > 0  ->  SELL (someone sold GW for WETH)
// This classification was verified against a real swap on Blockscout.

import { SWAP_TOPIC0 } from "./abi";
import {
  EXPLORER_URL,
  POOL_ADDR,
  RH_RPC,
  SWAP_POLL_BLOCK_RANGE,
  SWAP_BURST_THRESHOLD,
  TOKEN_DECIMALS,
} from "./config";
import type { DiscordEmbed, DiscordMessagePayload } from "./discord-rest";

/** Direction of a trade from the $GW holder's perspective. */
export type SwapDirection = "buy" | "sell";

/** Decoded swap, ready for formatting. */
export interface DecodedSwap {
  /** Block number the swap occurred in. */
  blockNumber: number;
  /** Transaction hash (for the explorer link + footer). */
  txHash: string;
  /** Log index within the tx (for ordering when multiple swaps in one tx). */
  logIndex: number;
  /** Buy or sell from the $GW perspective. */
  direction: SwapDirection;
  /** Amount of WETH exchanged, human-readable (18 decimals). */
  wethAmount: number;
  /** Amount of $GW exchanged, human-readable (18 decimals). */
  gwAmount: number;
  /** Derived $GW price from sqrtPriceX96 (post-swap spot price). */
  gwPriceUsd: number | null;
  /** Unix seconds (from the block timestamp) — for the embed timestamp. */
  timestamp: number;
}

/** Result of one poll. */
export interface PollResult {
  /** New swaps found, oldest-first. */
  swaps: DecodedSwap[];
  /** New highest block to persist as the cursor. */
  latestBlock: number;
}

/** Minimal EVM log shape we read from eth_getLogs. */
interface EvmLog {
  blockNumber: string;
  transactionHash: string;
  logIndex: string;
  data: string;
}

/**
 * Persistent feed state — stored alongside gateway state in the DO.
 */
export interface FeedState {
  /** Highest block number we've already scanned. 0 = never polled. */
  lastBlock: number;
}

/** Make a JSON-RPC request to the Robinhood RPC. */
async function rpc(method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(RH_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(8_000),
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`rpc http ${res.status}`);
  const json = (await res.json()) as { result?: unknown; error?: unknown };
  if (json.error) throw new Error(`rpc error: ${JSON.stringify(json.error)}`);
  return json.result;
}

/** Decode a 32-byte hex word as a signed int256. */
function toSigned256(hexWord: string): bigint {
  const clean = hexWord.replace(/^0x/, "").padStart(64, "0").slice(0, 64);
  const bi = BigInt("0x" + clean);
  // Two's-complement sign flip if the top bit is set.
  return bi >= 1n << 255n ? bi - (1n << 256n) : bi;
}

/** Decode a 32-byte hex word as an unsigned uint160/uint128. */
function toUnsigned(hexWord: string): bigint {
  const clean = hexWord.replace(/^0x/, "").padStart(64, "0").slice(0, 64);
  return BigInt("0x" + clean);
}

/** Wei-scale a raw bigint amount to a human number (18 decimals). */
function toHuman(raw: bigint): number {
  // Use integer + fractional split to avoid Number precision loss on huge ints.
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const whole = abs / 10n ** BigInt(TOKEN_DECIMALS);
  const frac = abs % 10n ** BigInt(TOKEN_DECIMALS);
  const fracStr = frac.toString().padStart(TOKEN_DECIMALS, "0").slice(0, 6);
  const n = Number(`${whole}.${fracStr}`);
  return negative ? -n : n;
}

/**
 * Derive the $GW spot price (in ETH, not USD) from the post-swap sqrtPriceX96.
 * Returns null if the math overflows or the result is nonsensical.
 *
 * price_token1 (GW) in token0 (WETH) = (sqrtPriceX96 / 2^96)^2
 * Multiply by ETH USD price externally to get USD.
 */
function priceGwPerEth(sqrtPriceX96: bigint): number | null {
  try {
    // sqrtPriceX96^2 can overflow BigInt-safe Number conversion, so do it
    // via logs: log10(price) = 2*(log10(sqrtP) - log10(2^96))
    // But BigInt^2 stays exact; scale down before converting.
    const sq = sqrtPriceX96 * sqrtPriceX96; // 2^192 worst case, BigInt handles it
    const denom = 1n << 192n; // (2^96)^2
    // ratio = sq / denom as a JS number with limited precision (fine for display).
    // Multiply numerator by 1e18 first to preserve some fractional digits.
    const scaled = (sq * 10n ** 18n) / denom;
    const price = Number(scaled) / 1e18;
    if (!isFinite(price) || price <= 0) return null;
    return price; // GW per WETH — NOT USD. Caller must multiply by ETH USD.
  } catch {
    return null;
  }
}

/** Decode one Swap log into a DecodedSwap. */
function decodeLog(log: EvmLog, blockTimestamp: number): DecodedSwap | null {
  try {
    const data = log.data.replace(/^0x/, "");
    // Non-indexed fields, each 32 bytes:
    //   amount0(int256), amount1(int256), sqrtPriceX96(uint160),
    //   liquidity(uint128), tick(int24)
    if (data.length < 64 * 5) return null;
    const amount0Raw = toSigned256(data.slice(0, 64));
    const amount1Raw = toSigned256(data.slice(64, 128));
    const sqrtPriceX96 = toUnsigned(data.slice(128, 192));

    const wethAmount = toHuman(amount0Raw); // token0 = WETH
    const gwAmount = toHuman(amount1Raw); // token1 = GW

    // Classify by sign. Verified against real swap on Blockscout:
    //   sell of GW -> WETH out (a0<0), GW in (a1>0)
    //   buy  of GW -> WETH in  (a0>0), GW out (a1<0)
    let direction: SwapDirection;
    if (amount0Raw > 0n && amount1Raw < 0n) direction = "buy";
    else if (amount0Raw < 0n && amount1Raw > 0n) direction = "sell";
    else return null; // flash or weird — skip

    const gwPerEth = priceGwPerEth(sqrtPriceX96);

    return {
      blockNumber: parseInt(log.blockNumber, 16),
      txHash: log.transactionHash,
      logIndex: parseInt(log.logIndex, 16),
      direction,
      // Amounts are reported as positive magnitudes (sign is conveyed by direction).
      wethAmount: Math.abs(wethAmount),
      gwAmount: Math.abs(gwAmount),
      // gwPriceUsd is actually gwPerEth here — caller converts using ETH price.
      gwPriceUsd: gwPerEth,
      timestamp: blockTimestamp,
    };
  } catch {
    return null;
  }
}

/** Fetch block timestamps for the blocks of any swaps we decoded. */
async function fetchBlockTimestamps(
  blockNumbers: number[],
): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  // Deduplicate + batch.
  const unique = [...new Set(blockNumbers)];
  await Promise.all(
    unique.map(async (bn) => {
      try {
        const block = (await rpc("eth_getBlockByNumber", [
          "0x" + bn.toString(16),
          false,
        ])) as { timestamp?: string } | null;
        if (block?.timestamp) out.set(bn, parseInt(block.timestamp, 16));
      } catch {
        // Leave missing — timestamp is cosmetic.
      }
    }),
  );
  return out;
}

/**
 * Poll for new Swap events since `lastBlock`. Returns decoded swaps + the new
 * cursor. Throws on RPC failure — caller decides whether to retry.
 */
export async function pollSwaps(state: FeedState): Promise<PollResult> {
  // First poll: start from latest - range so we don't scan all of history.
  const latestHex = (await rpc("eth_blockNumber", [])) as string;
  const latest = parseInt(latestHex, 16);

  let fromBlock: number;
  if (state.lastBlock === 0) {
    fromBlock = Math.max(0, latest - SWAP_POLL_BLOCK_RANGE);
  } else {
    fromBlock = state.lastBlock + 1;
  }

  // Clamp the range — some RPCs reject huge ranges.
  const toBlock = Math.min(latest, fromBlock + SWAP_POLL_BLOCK_RANGE);
  if (fromBlock > toBlock) {
    return { swaps: [], latestBlock: latest };
  }

  const logs = (await rpc("eth_getLogs", [
    {
      address: POOL_ADDR,
      topics: [SWAP_TOPIC0],
      fromBlock: "0x" + fromBlock.toString(16),
      toBlock: "0x" + toBlock.toString(16),
    },
  ])) as EvmLog[];

  if (!Array.isArray(logs) || logs.length === 0) {
    return { swaps: [], latestBlock: toBlock };
  }

  // Fetch block timestamps for all logs in one batch.
  const blockNums = logs.map((l) => parseInt(l.blockNumber, 16));
  const timestamps = await fetchBlockTimestamps(blockNums);

  const swaps: DecodedSwap[] = [];
  for (const log of logs) {
    const bn = parseInt(log.blockNumber, 16);
    const decoded = decodeLog(log, timestamps.get(bn) ?? 0);
    if (decoded) swaps.push(decoded);
  }

  // Oldest-first so they post in chronological order.
  swaps.sort((a, b) =>
    a.blockNumber !== b.blockNumber
      ? a.blockNumber - b.blockNumber
      : a.logIndex - b.logIndex,
  );

  return { swaps, latestBlock: toBlock };
}

// --------------------------------------------------------------------------
// Formatting
// --------------------------------------------------------------------------

/** Discord embed colors (RGB as a single int). */
const COLOR_BUY = 0x4caf50; // green
const COLOR_SELL = 0xff5252; // red

/** Curated celebratory GIFs for buys — picked at random, no API key needed. */
const BUY_GIFS = [
  "https://media.tenor.com/1nbB1OH8X9kAAAAC/to-the-moon-rocket.gif",
  "https://media.tenor.com/yQDA0NPQ8YwAAAAC/money-cash.gif",
  "https://media.tenor.com/x8v1oNUOmg4AAAAC/rain-money.gif",
  "https://media.tenor.com/5zhb6vJHx6kAAAAC/cheers-beer.gif",
  "https://media.tenor.com/3Z0XNY0Nmx4AAAAC/pump-it-lambo.gif",
];

/** Format an ETH amount with up to 6 decimals. */
function fmtEth(n: number): string {
  if (n >= 1) return n.toFixed(4);
  return n.toFixed(6);
}

/** Format a $GW amount with grouping + sensible decimals. */
function fmtGw(n: number): string {
  if (n >= 1000) return Math.floor(n).toLocaleString("en-US");
  if (n >= 1) return n.toFixed(2);
  return n.toFixed(4);
}

/** Shorten a tx hash for display: 0x1234…abcd. */
function shortHash(hash: string): string {
  if (hash.length < 12) return hash;
  return `${hash.slice(0, 6)}…${hash.slice(-4)}`;
}

/** Pick a random buy GIF. */
function randomBuyGif(): string {
  return BUY_GIFS[Math.floor(Math.random() * BUY_GIFS.length)];
}

/**
 * Build a Discord message for a single swap. Uses an embed for color + layout;
 * buys get a random celebratory GIF, sells get a plain red embed.
 *
 * @param swap The decoded swap.
 * @param ethPriceUsd Current ETH USD price, for converting WETH to USD. If null,
 *   USD figures are omitted.
 */
export function formatSwapMessage(
  swap: DecodedSwap,
  ethPriceUsd: number | null,
): DiscordMessagePayload {
  const isBuy = swap.direction === "buy";
  const usd = ethPriceUsd != null ? swap.wethAmount * ethPriceUsd : null;
  const verb = isBuy ? "BUY" : "SELL";
  const arrow = isBuy ? "🟢" : "🔴";
  const title = `${arrow} ${verb}${usd != null ? ` · $${usd.toFixed(2)}` : ""}`;

  // Body: "Bought 1,595,970 $GW for 0.006577 ETH ($10.82)" / "Sold …"
  const action = isBuy ? "Bought" : "Sold";
  const usdTag = usd != null ? ` ($${usd.toFixed(2)})` : "";
  const description = `${action} **${fmtGw(swap.gwAmount)} $GW** for **${fmtEth(
    swap.wethAmount,
  )} ETH**${usdTag}`;

  // Price footer: convert gwPerEth to USD if we have ETH price.
  let footerText = `Block ${swap.blockNumber} · tx ${shortHash(swap.txHash)}`;
  if (ethPriceUsd != null && swap.gwPriceUsd != null) {
    const gwUsd = swap.gwPriceUsd * ethPriceUsd;
    footerText = `$GW ≈ $${gwUsd.toFixed(6)} · ${footerText}`;
  }

  const embed: DiscordEmbed = {
    title,
    description,
    url: `${EXPLORER_URL}/tx/${swap.txHash}`,
    color: isBuy ? COLOR_BUY : COLOR_SELL,
    footer: { text: footerText },
  };
  if (swap.timestamp) {
    embed.timestamp = new Date(swap.timestamp * 1000).toISOString();
  }
  // Buy celebration GIF.
  if (isBuy) {
    embed.image = { url: randomBuyGif() };
  }

  return { embeds: [embed] };
}

/**
 * Build a single summary message when a poll returns many swaps (burst).
 * Avoids spamming the channel during high-volume windows.
 */
export function formatBurstMessage(
  swaps: DecodedSwap[],
  ethPriceUsd: number | null,
): DiscordMessagePayload {
  const buys = swaps.filter((s) => s.direction === "buy").length;
  const sells = swaps.length - buys;
  const totalWeth = swaps.reduce((sum, s) => sum + s.wethAmount, 0);
  const totalUsd = ethPriceUsd != null ? totalWeth * ethPriceUsd : null;
  const blocks = `${swaps[0].blockNumber}–${swaps[swaps.length - 1].blockNumber}`;

  const description =
    `**${swaps.length} swaps** in blocks ${blocks}\n` +
    `🟢 ${buys} buys · 🔴 ${sells} sells\n` +
    `Total volume: ${fmtEth(totalWeth)} ETH${
      totalUsd != null ? ` ($${totalUsd.toFixed(2)})` : ""
    }`;

  return {
    embeds: [
      {
        title: `📊 Swap burst · ${swaps.length} trades`,
        description,
        color: 0xffb74d, // amber
      },
    ],
  };
}

/** True if a poll's swaps should be collapsed into a burst message. */
export function isBurst(count: number): boolean {
  return count > SWAP_BURST_THRESHOLD;
}
