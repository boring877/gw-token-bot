// Shared Robinhood Chain data access for the on-chain feeds. THREE sources,
// split by call type, because every free endpoint has a different weakness
// (all learned the hard way on 2026-08-15):
//   - eth_getLogs MUST go to the public RPC (or Blockscout) — Alchemy's free
//     tier caps getLogs at a 10-block range, useless for our windows.
//   - Everything else (blockNumber, eth_call, receipts, block lookups) goes
//     to Alchemy when the ALCHEMY_URL secret is set — generous free tier.
//   - Blockscout's REST logs API is the last-resort fallback for logs when
//     the public RPC 429s (it 429s Cloudflare workers a lot, but retries).

import {
  EXPLORER_URL,
  RH_RPC,
  SWAP_POLL_BLOCK_RANGE,
  TOKEN_DECIMALS,
} from "./config";

/** Blockscout's classic REST API base (the explorer we link to in embeds). */
const EXPLORER_API = `${EXPLORER_URL}/api`;

/**
 * Active URL for general JSON-RPC calls. Defaults to the public RPC; the
 * worker/DO set it to the ALCHEMY_URL secret at entry when configured.
 */
let generalRpcUrl = RH_RPC;

/** Point general RPC calls at Alchemy (no-op for falsy values). */
export function setGeneralRpcUrl(url: string | undefined | null): void {
  if (url && /^https:\/\/.+/.test(url)) generalRpcUrl = url;
}

/** Minimal EVM log shape we read from log queries. */
export interface EvmLog {
  address: string;
  blockNumber: string;
  transactionHash: string;
  logIndex: string;
  topics: string[];
  data: string;
  /** Blockscout-only convenience: unix seconds of the log's block. */
  timeStamp?: string;
}

/** Make a JSON-RPC request (to Alchemy when configured, else the public RPC). */
export async function rpc(
  method: string,
  params: unknown[],
): Promise<unknown> {
  const res = await fetch(generalRpcUrl, {
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
export function toSigned256(hexWord: string): bigint {
  const clean = hexWord.replace(/^0x/, "").padStart(64, "0").slice(0, 64);
  const bi = BigInt("0x" + clean);
  // Two's-complement sign flip if the top bit is set.
  return bi >= 1n << 255n ? bi - (1n << 256n) : bi;
}

/** Decode a 32-byte hex word as an unsigned uint160/uint128. */
export function toUnsigned(hexWord: string): bigint {
  const clean = hexWord.replace(/^0x/, "").padStart(64, "0").slice(0, 64);
  return BigInt("0x" + clean);
}

/** Wei-scale a raw bigint amount to a human number (18 decimals). */
export function toHuman(raw: bigint): number {
  // Use integer + fractional split to avoid Number precision loss on huge ints.
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const whole = abs / 10n ** BigInt(TOKEN_DECIMALS);
  const frac = abs % 10n ** BigInt(TOKEN_DECIMALS);
  const fracStr = frac.toString().padStart(TOKEN_DECIMALS, "0").slice(0, 6);
  const n = Number(`${whole}.${fracStr}`);
  return negative ? -n : n;
}

/** Current chain head. ONE call per feed tick, shared by all three feeds.
 * RPC first (Alchemy when configured), Blockscout as fallback. */
export async function fetchLatestBlock(): Promise<number> {
  try {
    const latestHex = (await rpc("eth_blockNumber", [])) as string;
    return parseInt(latestHex, 16);
  } catch (err) {
    console.warn("[chain] rpc head fetch failed:", err);
  }
  const res = await fetch(
    `${EXPLORER_API}?module=block&action=eth_block_number`,
    { signal: AbortSignal.timeout(8_000) },
  );
  if (!res.ok) throw new Error(`blockscout http ${res.status}`);
  const json = (await res.json()) as { result?: string };
  if (!json.result || !json.result.startsWith("0x")) {
    throw new Error(`blockscout block_number: ${JSON.stringify(json).slice(0, 120)}`);
  }
  return parseInt(json.result, 16);
}

/**
 * Fetch logs for an RPC-style filter ({address, topics, from, to}), where a
 * topic slot may be null (wildcard) or an array of alternatives (OR).
 * Public-RPC eth_getLogs first (no range cap; Alchemy free caps getLogs at
 * 10 blocks so it is deliberately NOT used here), Blockscout's logs API as
 * fallback (no OR-within-a-topic there, so array slots fan out into parallel
 * requests). Throws only when BOTH sources fail — the gateway's 429 backoff
 * handles that.
 */
export async function fetchLogs(
  filter: {
    address: string;
    topics: unknown[];
    from: number;
    to: number;
  },
  lane: LogLane,
): Promise<LogsResult> {
  try {
    const logs = (await rpcLogs("eth_getLogs", [
      {
        address: filter.address,
        topics: filter.topics,
        fromBlock: "0x" + filter.from.toString(16),
        toBlock: "0x" + filter.to.toString(16),
      },
    ])) as EvmLog[];
    return { logs, scannedTo: filter.to };
  } catch (err) {
    console.warn(
      `[chain] rpc logs failed (${filter.address.slice(0, 10)}…):`,
      err,
    );
  }

  // Fallback: Alchemy in 10-block chunks (its free tier caps getLogs range
  // at 10 blocks per request). Lane-budget-limited partial scans are fine —
  // scannedTo keeps cursors honest — so failures here mean Alchemy erred.
  try {
    return await fetchLogsChunked(filter, lane);
  } catch (err) {
    console.warn(
      `[chain] alchemy chunked logs failed (${filter.address.slice(0, 10)}…):`,
      err,
    );
  }

  // Expand OR-array topic slots into concrete per-request values.
  const slots: string[][] = [0, 1, 2, 3].map((i) => {
    const t = filter.topics[i];
    if (t == null) return [null as unknown as string];
    return Array.isArray(t) ? (t as string[]) : [t as string];
  });
  const combos: Array<Array<string | null>> = [[]];
  for (const vals of slots) {
    // Wildcard slots multiply nothing (single null); OR slots multiply out.
    const next: Array<Array<string | null>> = [];
    for (const base of combos) {
      for (const v of vals) next.push([...base, v]);
    }
    if (next.length > 8) break; // sanity cap
    combos.length = 0;
    combos.push(...next);
  }

  const responses = await Promise.all(
    combos.map(async (combo) => {
      const q = new URLSearchParams({
        module: "logs",
        action: "getLogs",
        address: filter.address,
        fromBlock: String(filter.from),
        toBlock: String(filter.to),
      });
      if (combo[0]) {
        q.set("topic0", combo[0]);
        if (combo[1]) q.set("topic0_1_opr", "and");
        if (combo[2]) q.set("topic0_2_opr", "and");
      }
      if (combo[1]) q.set("topic1", combo[1]);
      if (combo[2]) q.set("topic2", combo[2]);
      if (combo[3]) q.set("topic3", combo[3]);
      const res = await fetch(`${EXPLORER_API}?${q.toString()}`, {
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) throw new Error(`blockscout http ${res.status}`);
      const json = (await res.json()) as {
        status?: string;
        message?: string;
        result?: unknown;
      };
      // status 0 + "No logs found" is a legitimate empty result.
      if (json.status === "0" && json.message !== "No logs found") {
        throw new Error(`blockscout: ${json.message ?? "unknown"}`);
      }
      return Array.isArray(json.result) ? (json.result as EvmLog[]) : [];
    }),
  );
  return { logs: responses.flat(), scannedTo: filter.to };
}

/**
 * JSON-RPC call that ALWAYS targets the public RPC — for eth_getLogs, whose
 * free-tier Alchemy range cap (10 blocks) makes Alchemy unusable for logs.
 */
async function rpcLogs(method: string, params: unknown[]): Promise<unknown> {
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

/** Alchemy free-tier getLogs range cap (blocks per request). */
const ALCHEMY_LOG_CHUNK = 10;

/** Max chunks per fetchLogs — must cover SWAP_POLL_BLOCK_RANGE fully. */
const MAX_LOG_CHUNKS = 100;

/** Result of a log fetch: the logs plus the highest block FULLY scanned. */
export interface LogsResult {
  logs: EvmLog[];
  /**
   * Callers advance their cursor here, NOT to their window end — when the
   * chunked fallback is budget-limited it scans fewer blocks than asked, and
   * advancing past unscanned blocks would silently skip events.
   */
  scannedTo: number;
}

/**
 * Per-tick chunk budgets per feed lane. The Workers free tier caps ONE
 * invocation at ~50 subrequests total (heads, Discord posts, presence all
 * count), so chunked scanning gets a fixed share, reset each feed tick.
 * Sized against the real chain rate (~12 blocks/s): swaps get enough chunks
 * to keep pace even when fully chunked; burns/mints self-pace through their
 * backlogs during public-RPC flaps and clear fast once it serves full
 * windows again — slower, but never lossy. Combined worst tick stays under
 * the ~50-subrequest invocation cap.
 */
const chunkBudgets: Record<string, number> = { swap: 22, burn: 9, mint: 9 };

/** Which feed a log fetch belongs to (chunk-budget lane). */
export type LogLane = "swap" | "burn" | "mint";

/** Reset the per-tick chunk budgets (called at the start of each feed tick). */
export function resetLogChunkBudget(): void {
  chunkBudgets.swap = 22;
  chunkBudgets.burn = 9;
  chunkBudgets.mint = 9;
}

/**
 * Serve a log filter from the general RPC (Alchemy) in 10-block chunks,
 * batched to stay gentle on per-second throughput. May scan FEWER blocks
 * than the window (lane budget) — the returned scannedTo tells the caller
 * how far it got; the rest is picked up on later ticks. A fully-exhausted
 * lane returns a clean no-op (scannedTo = nothing new), NOT an error.
 */
async function fetchLogsChunked(
  filter: {
    address: string;
    topics: unknown[];
    from: number;
    to: number;
  },
  lane: LogLane,
): Promise<LogsResult> {
  const total = filter.to - filter.from + 1;
  const nChunks = Math.ceil(total / ALCHEMY_LOG_CHUNK);
  if (nChunks > MAX_LOG_CHUNKS) {
    throw new Error(`window ${total} blocks exceeds chunk budget`);
  }
  const usable = Math.min(nChunks, chunkBudgets[lane] ?? 0);
  if (usable <= 0) {
    // No budget this tick — clean no-op, no cursor movement.
    return { logs: [], scannedTo: filter.from - 1 };
  }
  chunkBudgets[lane] = (chunkBudgets[lane] ?? 0) - usable;

  const out: EvmLog[] = [];
  const BATCH = 8;
  for (let i = 0; i < usable; i += BATCH) {
    const batch = [...Array(Math.min(BATCH, usable - i)).keys()].map(
      async (j) => {
        const idx = i + j;
        const from = filter.from + idx * ALCHEMY_LOG_CHUNK;
        const to = Math.min(from + ALCHEMY_LOG_CHUNK - 1, filter.to);
        return (await rpc("eth_getLogs", [
          {
            address: filter.address,
            topics: filter.topics,
            fromBlock: "0x" + from.toString(16),
            toBlock: "0x" + to.toString(16),
          },
        ])) as EvmLog[];
      },
    );
    out.push(...(await Promise.all(batch)).flat());
  }
  return {
    logs: out,
    scannedTo: Math.min(
      filter.from + usable * ALCHEMY_LOG_CHUNK - 1,
      filter.to,
    ),
  };
}

/**
 * Compute the [fromBlock, toBlock] window for a feed cursor, given the
 * already-fetched chain head. First poll (lastBlock = 0) starts
 * SWAP_POLL_BLOCK_RANGE back so we never scan all of history; later polls
 * continue from lastBlock + 1, clamped to the range cap. Returns null when
 * the cursor is already at the head.
 */
export function logWindow(
  lastBlock: number,
  latest: number,
): { from: number; to: number } | null {
  const from =
    lastBlock === 0
      ? Math.max(0, latest - SWAP_POLL_BLOCK_RANGE)
      : lastBlock + 1;
  // Clamp the range — some RPCs reject huge ranges.
  const to = Math.min(latest, from + SWAP_POLL_BLOCK_RANGE);
  if (from > to) return null;
  return { from, to };
}

/** Fetch block timestamps for the blocks of any logs we decoded. */
export async function fetchBlockTimestamps(
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
 * Resolve a per-log timestamp getter: Blockscout logs carry `timeStamp`
 * already; RPC-sourced logs fall back to eth_getBlockByNumber lookups
 * (skipped entirely when every log already has one).
 */
export async function resolveTimestamps(
  logs: EvmLog[],
): Promise<(log: EvmLog) => number> {
  const missing = logs
    .filter((l) => !l.timeStamp)
    .map((l) => parseInt(l.blockNumber, 16));
  const map =
    missing.length > 0
      ? await fetchBlockTimestamps(missing)
      : new Map<number, number>();
  return (log) =>
    log.timeStamp
      ? parseInt(log.timeStamp, 16)
      : (map.get(parseInt(log.blockNumber, 16)) ?? 0);
}
