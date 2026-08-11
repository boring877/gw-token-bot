// Uniswap V3 pool ABI fragments + the Swap event topic hash. Used by the swap
// feed to decode logs from the GW/WETH pool.

/**
 * keccak256("Swap(address,address,int256,int256,uint160,uint128,int24)")
 * Precomputed so we don't need a keccak dependency at runtime.
 */
export const SWAP_TOPIC0 =
  "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";

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
