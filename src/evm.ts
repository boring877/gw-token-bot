// Shared Robinhood Chain data access for the on-chain feeds. TWO sources with
// automatic failover, because both free endpoints rate-limit (learned the hard
// way — the public RPC 429s under sustained polling, and Blockscout's REST API
// 429s on bursts):
//   1. Blockscout's logs API — dedicated indexer, no key, returns per-log
//      timestamps; used FIRST for eth_getLogs-style queries.
//   2. The public JSON-RPC — used for receipts/eth_call, and as the fallback
//      when Blockscout is limiting us.

import {
  EXPLORER_URL,
  RH_RPC,
  SWAP_POLL_BLOCK_RANGE,
  TOKEN_DECIMALS,
} from "./config";

/** Blockscout's classic REST API base (the explorer we link to in embeds). */
const EXPLORER_API = `${EXPLORER_URL}/api`;

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

/** Make a JSON-RPC request to the Robinhood RPC. */
export async function rpc(
  method: string,
  params: unknown[],
): Promise<unknown> {
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
 * Tries Blockscout first, falls back to the public RPC. */
export async function fetchLatestBlock(): Promise<number> {
  try {
    const res = await fetch(
      `${EXPLORER_API}?module=block&action=eth_block_number`,
      { signal: AbortSignal.timeout(8_000) },
    );
    if (res.ok) {
      const json = (await res.json()) as { result?: string };
      if (json.result && json.result.startsWith("0x")) {
        return parseInt(json.result, 16);
      }
      throw new Error(`blockscout block_number: ${JSON.stringify(json).slice(0, 120)}`);
    }
    throw new Error(`blockscout http ${res.status}`);
  } catch (err) {
    console.warn("[chain] blockscout head failed:", err);
  }
  const latestHex = (await rpc("eth_blockNumber", [])) as string;
  return parseInt(latestHex, 16);
}

/**
 * Fetch logs for an RPC-style filter ({address, topics, from, to}), where a
 * topic slot may be null (wildcard) or an array of alternatives (OR).
 * Blockscout first (it has no OR-within-a-topic, so array slots fan out into
 * parallel requests), public-RPC eth_getLogs as fallback. Throws only when
 * BOTH sources fail — the gateway's 429 backoff handles that.
 */
export async function fetchLogs(filter: {
  address: string;
  topics: unknown[];
  from: number;
  to: number;
}): Promise<EvmLog[]> {
  try {
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
    return responses.flat();
  } catch (err) {
    // Blockscout failed/limited — log the reason, fall back to the public RPC.
    console.warn(
      `[chain] blockscout logs failed (${filter.address.slice(0, 10)}…):`,
      err,
    );
  }

  return (await rpc("eth_getLogs", [
    {
      address: filter.address,
      topics: filter.topics,
      fromBlock: "0x" + filter.from.toString(16),
      toBlock: "0x" + filter.to.toString(16),
    },
  ])) as EvmLog[];
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
