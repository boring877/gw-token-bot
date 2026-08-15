// Polls the GachaWiki OGs ERC-721 contract for mint events (Transfer from the
// zero address) and formats each as a Discord embed showing the actual OG art,
// its verse traits, and how it was paid for — ETH, or $GW (which the contract
// burns to 0x…dEaD in the same tx; see burnfeed.ts for the burn-side post).
// Art + metadata come from the collection's Cloudflare Pages project
// (gachawiki-ogs.pages.dev), the same source the wiki's /nft page serves.

import {
  TRANSFER_TOPIC0,
  ZERO_ADDRESS_TOPIC,
  BURN_RECIPIENT_TOPICS,
} from "./abi";
import {
  EXPLORER_URL,
  GW_ADDR,
  NFT_ADDR,
  NFT_MAX_SUPPLY,
  NFT_METADATA_BASE,
} from "./config";
import type { DiscordEmbed, DiscordMessagePayload } from "./discord-rest";
import {
  fetchLogs,
  logWindow,
  resolveTimestamps,
  rpc,
  toHuman,
  type EvmLog,
} from "./evm";
import { fmtEth, fmtGw, shortHash } from "./swapfeed";

/** Traits we surface from the collection metadata (best-effort). */
interface NftMetadata {
  name: string | null;
  verse: string | null;
  japanese: string | null;
  kaomoji: string | null;
  rarity: string | null;
}

/** How a mint was paid for. $GW payments are burned by the contract. */
export type MintPayment =
  | { kind: "gw"; gwAmount: number }
  | { kind: "eth"; ethAmount: number }
  | { kind: "free" };

/**
 * All mints from one transaction (mint(uint256 qty) can batch several OGs in
 * a single tx — one embed per tx, not per token).
 */
export interface DecodedMint {
  /** Block number the mint occurred in. */
  blockNumber: number;
  /** Transaction hash (explorer link + footer). */
  txHash: string;
  /** Token ids minted by this tx, ascending. */
  tokenIds: number[];
  /** Address that minted (topic2 of the Transfer event). */
  minter: string;
  /** Payment side of the mint. */
  payment: MintPayment;
  /** Metadata of the FIRST token (the one whose art is shown). */
  meta: NftMetadata | null;
  /** Art URL of the first token (always derivable, no metadata fetch needed). */
  imageUrl: string;
  /** Unix seconds (from the block timestamp) — for the embed timestamp. */
  timestamp: number;
}

/** Result of one mint poll. */
export interface MintPollResult {
  /** New mints (one entry per tx), oldest-first. */
  mints: DecodedMint[];
  /** New highest block to persist as the mint cursor. */
  latestBlock: number;
}

/** current totalSupply() on the OG contract — for the embed footer. */
export async function fetchTotalSupply(): Promise<number | null> {
  try {
    const hex = (await rpc("eth_call", [
      { to: NFT_ADDR, data: "0x18160ddd" }, // totalSupply()
      "latest",
    ])) as string;
    return parseInt(hex, 16);
  } catch {
    return null;
  }
}

/** Fetch + parse the metadata JSON for one token id. Null on any failure. */
async function fetchMetadata(tokenId: number): Promise<NftMetadata | null> {
  try {
    const res = await fetch(`${NFT_METADATA_BASE}/metadata/${tokenId}`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      name?: string;
      attributes?: Array<{ trait_type?: string; value?: unknown }>;
    };
    const trait = (want: string): string | null => {
      const t = json.attributes?.find((a) => a.trait_type === want);
      return typeof t?.value === "string" ? t.value : null;
    };
    return {
      name: typeof json.name === "string" ? json.name : null,
      verse: trait("Verse"),
      japanese: trait("Japanese"),
      kaomoji: trait("Kaomoji"),
      rarity: trait("Rarity"),
    };
  } catch {
    return null;
  }
}

/**
 * Detect how a mint tx was paid: a $GW Transfer to a burn address in the
 * receipt means gwMint (the contract burns the GW it takes); tx value > 0
 * means an ETH mint; anything else is a team/admin mint.
 */
async function detectPayment(
  txHash: string,
): Promise<{ payment: MintPayment; minter: string | null }> {
  const receipt = (await rpc("eth_getTransactionReceipt", [txHash])) as {
    logs: EvmLog[];
  } | null;
  if (!receipt?.logs) return { payment: { kind: "free" }, minter: null };

  let payment: MintPayment = { kind: "free" };
  let minter: string | null = null;
  for (const log of receipt.logs) {
    if (
      log.address.toLowerCase() === GW_ADDR.toLowerCase() &&
      log.topics[0] === TRANSFER_TOPIC0 &&
      BURN_RECIPIENT_TOPICS.includes(log.topics[2] ?? "")
    ) {
      payment = { kind: "gw", gwAmount: toHuman(BigInt(log.data)) };
    }
  }
  if (payment.kind === "free") {
    const tx = (await rpc("eth_getTransactionByHash", [txHash])) as {
      value?: string;
    } | null;
    const value = tx?.value ? BigInt(tx.value) : 0n;
    if (value > 0n) payment = { kind: "eth", ethAmount: toHuman(value) };
  }
  // The mint Transfer's `to` (topic2) is the minter.
  const mintLog = receipt.logs.find(
    (l) =>
      l.address.toLowerCase() === NFT_ADDR.toLowerCase() &&
      l.topics[0] === TRANSFER_TOPIC0 &&
      l.topics[1] === ZERO_ADDRESS_TOPIC &&
      l.topics.length >= 3,
  );
  if (mintLog) minter = "0x" + mintLog.topics[2].slice(-40);
  return { payment, minter };
}

/**
 * Poll for new OG mints since `lastBlock`. `latest` is the already-fetched
 * chain head (shared across feeds). Returns per-tx mint groups + the new
 * cursor. Throws on RPC failure — caller decides whether to retry.
 */
export async function pollMints(
  lastBlock: number,
  latest: number,
): Promise<MintPollResult> {
  const window = logWindow(lastBlock, latest);
  if (!window) return { mints: [], latestBlock: latest };

  const logs = await fetchLogs({
    address: NFT_ADDR,
    topics: [TRANSFER_TOPIC0, ZERO_ADDRESS_TOPIC, null],
    from: window.from,
    to: window.to,
  });

  if (!Array.isArray(logs) || logs.length === 0) {
    return { mints: [], latestBlock: window.to };
  }

  const tsFor = await resolveTimestamps(logs);

  // Group by tx — one embed per mint transaction, not per token.
  const byTx = new Map<
    string,
    { blockNumber: number; tokenIds: number[]; ts: number }
  >();
  for (const log of logs) {
    const bn = parseInt(log.blockNumber, 16);
    const tokenId = parseInt(log.topics[3], 16);
    const entry = byTx.get(log.transactionHash) ?? {
      blockNumber: bn,
      tokenIds: [],
      ts: tsFor(log),
    };
    entry.tokenIds.push(tokenId);
    byTx.set(log.transactionHash, entry);
  }

  const mints: DecodedMint[] = [];
  for (const [txHash, group] of byTx) {
    group.tokenIds.sort((a, b) => a - b);
    const { payment, minter } = await detectPayment(txHash);
    if (!minter) continue; // mint log vanished (reorg?) — skip
    mints.push({
      blockNumber: group.blockNumber,
      txHash,
      tokenIds: group.tokenIds,
      minter,
      payment,
      meta: await fetchMetadata(group.tokenIds[0]),
      imageUrl: `${NFT_METADATA_BASE}/images/${group.tokenIds[0]}.png`,
      timestamp: group.ts,
    });
  }

  // Oldest-first so they post in chronological order.
  mints.sort((a, b) => a.blockNumber - b.blockNumber);

  return { mints, latestBlock: window.to };
}

// --------------------------------------------------------------------------
// Formatting
// --------------------------------------------------------------------------

/** Mint embed color — purple, the classic NFT accent. */
const COLOR_MINT = 0xa78bfa;

/** Token id as the collection displays it: #000, #042, #777… */
function padId(id: number): string {
  return String(id).padStart(3, "0");
}

/**
 * Build a Discord message for one mint tx. Shows the actual OG art, the
 * minter, the payment side (ETH, or $GW burned), and verse/rarity traits.
 *
 * @param mint The decoded mint group (one tx).
 * @param ethPriceUsd Current ETH USD price (for the ETH price hint). Nullable.
 * @param totalSupply Current totalSupply() for the footer. Nullable.
 */
export function formatMintMessage(
  mint: DecodedMint,
  ethPriceUsd: number | null,
  totalSupply: number | null,
): DiscordMessagePayload {
  const first = mint.tokenIds[0];
  const extra = mint.tokenIds.length - 1;
  const title =
    (mint.meta?.name ?? `GachaWiki OG #${padId(first)}`) +
    (extra > 0 ? ` +${extra} more` : "") +
    " minted!";

  const lines: string[] = [];
  lines.push(`Minter \`${shortHash(mint.minter)}\``);

  if (mint.payment.kind === "gw") {
    lines.push(`Paid **${fmtGw(mint.payment.gwAmount)} $GW** — burned 🔥`);
  } else if (mint.payment.kind === "eth") {
    const usd =
      ethPriceUsd != null
        ? ` (≈$${(mint.payment.ethAmount * ethPriceUsd).toFixed(2)})`
        : "";
    lines.push(`Paid **${fmtEth(mint.payment.ethAmount)} ETH**${usd}`);
  } else {
    lines.push(`Team mint (no payment)`);
  }

  if (extra > 0) {
    lines.push(
      `OGs #${mint.tokenIds.map(padId).join(", #")}`,
    );
  }

  if (mint.meta) {
    const verse =
      mint.meta.verse != null ? `"${mint.meta.verse}"` : null;
    const jp = [mint.meta.japanese, mint.meta.kaomoji]
      .filter((s): s is string => s != null)
      .join(" ");
    if (verse || jp) lines.push([verse, jp].filter(Boolean).join(" "));
    if (mint.meta.rarity) lines.push(`Rarity: **${mint.meta.rarity}**`);
  }

  let footer = `Block ${mint.blockNumber} · tx ${shortHash(mint.txHash)}`;
  if (totalSupply != null) {
    footer = `${totalSupply.toLocaleString("en-US")}/${NFT_MAX_SUPPLY.toLocaleString("en-US")} minted · ${footer}`;
  }

  const embed: DiscordEmbed = {
    title,
    description: lines.join("\n"),
    url: `${EXPLORER_URL}/tx/${mint.txHash}`,
    color: COLOR_MINT,
    image: { url: mint.imageUrl },
    footer: { text: footer },
  };
  if (mint.timestamp) {
    embed.timestamp = new Date(mint.timestamp * 1000).toISOString();
  }

  return { embeds: [embed] };
}
