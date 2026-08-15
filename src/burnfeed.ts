// Polls the $GW token contract for Transfer events sent to burn addresses and
// formats each as a Discord embed. $GW has NO burn() function — its verified
// ABI (Blockscout) is a plain ERC-20 — so the only burn mechanism is a plain
// transfer to 0x…dEaD (all 3 historical burns) or 0x0 (classic, none yet).
// Both recipients are matched with a single topics array in one eth_getLogs.

import { TRANSFER_TOPIC0, BURN_RECIPIENT_TOPICS } from "./abi";
import { ASSET_BASE_URL, EXPLORER_URL, GW_ADDR } from "./config";
import type { DiscordEmbed, DiscordMessagePayload } from "./discord-rest";
import {
  fetchLogs,
  logWindow,
  resolveTimestamps,
  toHuman,
  type EvmLog,
} from "./evm";
import { fmtGw, shortHash } from "./swapfeed";

/** Decoded burn, ready for formatting. */
export interface DecodedBurn {
  /** Block number the burn occurred in. */
  blockNumber: number;
  /** Transaction hash (explorer link + footer). */
  txHash: string;
  /** Log index within the tx (for ordering). */
  logIndex: number;
  /** Address that burned (topic1 of the Transfer event). */
  from: string;
  /** Amount of $GW burned, human-readable (18 decimals). */
  gwAmount: number;
  /** Unix seconds (from the block timestamp) — for the embed timestamp. */
  timestamp: number;
}

/** Result of one burn poll. */
export interface BurnPollResult {
  /** New burns found, oldest-first. */
  burns: DecodedBurn[];
  /** New highest block to persist as the burn cursor. */
  latestBlock: number;
}

/** Decode one Transfer-to-dead log into a DecodedBurn. */
function decodeBurnLog(log: EvmLog, blockTimestamp: number): DecodedBurn | null {
  try {
    if (log.topics.length < 3) return null;
    const from = "0x" + log.topics[1].slice(-40);
    const gwAmount = toHuman(BigInt(log.data));
    if (gwAmount <= 0) return null;
    return {
      blockNumber: parseInt(log.blockNumber, 16),
      txHash: log.transactionHash,
      logIndex: parseInt(log.logIndex, 16),
      from,
      gwAmount,
      timestamp: blockTimestamp,
    };
  } catch {
    return null;
  }
}

/**
 * Poll for new burn events since `lastBlock`. `latest` is the already-fetched
 * chain head (shared across feeds). Returns decoded burns + the new cursor.
 * Throws on RPC failure — caller decides whether to retry.
 */
export async function pollBurns(
  lastBlock: number,
  latest: number,
): Promise<BurnPollResult> {
  const window = logWindow(lastBlock, latest);
  if (!window) return { burns: [], latestBlock: latest };

  const logs = await fetchLogs({
    address: GW_ADDR,
    topics: [TRANSFER_TOPIC0, null, BURN_RECIPIENT_TOPICS],
    from: window.from,
    to: window.to,
  });

  if (!Array.isArray(logs) || logs.length === 0) {
    return { burns: [], latestBlock: window.to };
  }

  const tsFor = await resolveTimestamps(logs);

  const burns: DecodedBurn[] = [];
  for (const log of logs) {
    const decoded = decodeBurnLog(log, tsFor(log));
    if (decoded) burns.push(decoded);
  }

  // Oldest-first so they post in chronological order.
  burns.sort((a, b) =>
    a.blockNumber !== b.blockNumber
      ? a.blockNumber - b.blockNumber
      : a.logIndex - b.logIndex,
  );

  return { burns, latestBlock: window.to };
}

/** Burn embed color — orange. */
const COLOR_BURN = 0xff6d00;

/** Our self-hosted burn GIF, served by this worker as a static asset. */
const BURN_GIF_URL = `${ASSET_BASE_URL}/gifs/burn.gif`;

/** Format a burn USD value sensibly across magnitudes (dust → large). */
function fmtBurnUsd(usd: number): string {
  if (usd >= 1e6) return `$${(usd / 1e6).toFixed(2)}M`;
  if (usd >= 1e3) return `$${(usd / 1e3).toFixed(1)}K`;
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(4)}`;
}

/**
 * Build a Discord message for a single burn. Orange embed + custom flame GIF;
 * USD valuation uses the current $GW price (DexScreener cache), if available.
 */
export function formatBurnMessage(
  burn: DecodedBurn,
  gwPriceUsd: number | null,
): DiscordMessagePayload {
  const usd = gwPriceUsd != null ? burn.gwAmount * gwPriceUsd : null;
  const title = `🔥 BURN${usd != null ? ` · ${fmtBurnUsd(usd)}` : ""}`;

  const description =
    `Burned **${fmtGw(burn.gwAmount)} $GW**` +
    `${usd != null ? ` (${fmtBurnUsd(usd)})` : ""}\n` +
    `From \`${shortHash(burn.from)}\``;

  const embed: DiscordEmbed = {
    title,
    description,
    url: `${EXPLORER_URL}/tx/${burn.txHash}`,
    color: COLOR_BURN,
    image: { url: BURN_GIF_URL },
    footer: { text: `Block ${burn.blockNumber} · tx ${shortHash(burn.txHash)}` },
  };
  if (burn.timestamp) {
    embed.timestamp = new Date(burn.timestamp * 1000).toISOString();
  }

  return { embeds: [embed] };
}
