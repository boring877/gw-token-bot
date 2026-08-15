// Uniswap V3 pool ABI fragments + event topic hashes. Used by the swap feed
// (pool Swap logs) and the burn feed (token Transfer logs).

/**
 * keccak256("Swap(address,address,int256,int256,uint160,uint128,int24)")
 * Precomputed so we don't need a keccak dependency at runtime.
 */
export const SWAP_TOPIC0 =
  "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";

/**
 * keccak256("Transfer(address,address,uint256)") — the canonical ERC-20
 * Transfer event. Burns show up as Transfers whose `to` is a burn address.
 */
export const TRANSFER_TOPIC0 =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** The zero address as a 32-byte topic — Transfer FROM it = ERC-721 mint. */
export const ZERO_ADDRESS_TOPIC = "0x" + "0".repeat(64);

/**
 * Recipients (32-byte topic-encoded) treated as burns, matched as a topics
 * array in one eth_getLogs call:
 *   - 0x…dEaD — the ONLY mechanism $GW actually has (no burn() in the verified
 *     ABI; all 3 historical burns went here). The OGs NFT contract also burns
 *     its $GW mint payments here.
 *   - 0x0 — the classic burn target, none observed so far but cheap to match
 */
export const BURN_RECIPIENT_TOPICS = [
  "0x" + "0".repeat(60) + "dead",
  ZERO_ADDRESS_TOPIC,
];

/**
 * Canonical V3 pool Swap event ABI fragment, for reference and any future
 * ABI-encoding needs. We decode logs manually (see swapfeed.ts) rather than
 * pulling in viem/ethers, so this is documentation more than runtime code.
 */
export const SWAP_EVENT_ABI = [
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "address", name: "sender", type: "address" },
      { indexed: true, internalType: "address", name: "recipient", type: "address" },
      { indexed: false, internalType: "int256", name: "amount0", type: "int256" },
      { indexed: false, internalType: "int256", name: "amount1", type: "int256" },
      { indexed: false, internalType: "uint160", name: "sqrtPriceX96", type: "uint160" },
      { indexed: false, internalType: "uint128", name: "liquidity", type: "uint128" },
      { indexed: false, internalType: "int24", name: "tick", type: "int24" },
    ],
    name: "Swap",
    type: "event",
  },
] as const;
