import "server-only";

import {
  createPublicClient,
  fallback,
  formatUnits,
  getAddress,
  http,
  isAddress,
  type PublicClient,
} from "viem";
import { mainnet } from "viem/chains";

import { ethereumRpcUrls } from "@/lib/env";
import { appError, err, ok, type AppError, type Result } from "@/lib/result";

/**
 * SCAN (on-chain) — read-only ERC-20 metadata.
 *
 * This module reads. It does not sign, does not connect a wallet, does not hold
 * a key, and has no write path. `viem`'s public client cannot send a
 * transaction — there is no account attached to it — so the absence of write
 * capability is structural, not just a convention.
 *
 * "Blockchain when it earns its place": here it earns its place as a data
 * source for token metadata and supply, nothing more.
 */

/** Minimal ERC-20 read surface. */
const erc20Abi = [
  {
    type: "function",
    name: "name",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
  {
    type: "function",
    name: "symbol",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }],
  },
  {
    type: "function",
    name: "totalSupply",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
] as const;

export type TokenInfo = {
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: string;
  totalSupplyRaw: string;
};

let client: PublicClient | undefined;

function publicClient(): PublicClient {
  if (!client) {
    client = createPublicClient({
      chain: mainnet,
      // Fail over between endpoints rather than depending on one staying up.
      // One of the commonly-recommended public endpoints was returning
      // Cloudflare 525s during development — with a single transport that
      // reads as "the on-chain feature is broken".
      transport: fallback(
        ethereumRpcUrls().map((url) =>
          http(url, { timeout: 8_000, retryCount: 1 }),
        ),
      ),
    });
  }
  return client;
}

/** Upstream errors can carry an entire HTML error page. Keep detail short. */
function briefly(cause: unknown, max = 200): string | undefined {
  if (!(cause instanceof Error)) return undefined;
  const firstLine = cause.message.split("\n").find((l) => l.trim().length > 0);
  if (!firstLine) return undefined;
  return firstLine.length > max ? `${firstLine.slice(0, max)}…` : firstLine;
}

/**
 * Read an ERC-20's metadata.
 *
 * Three failure modes are handled as expected conditions rather than crashes:
 * a malformed address, an address that holds no contract code, and a contract
 * that is not ERC-20 (and so has no `symbol()` to call).
 */
export async function readToken(
  address: string,
): Promise<Result<TokenInfo, AppError>> {
  if (!isAddress(address)) {
    return err(
      appError("invalid_input", `"${address}" is not a valid Ethereum address.`),
    );
  }

  const checksummed = getAddress(address);
  const rpc = publicClient();

  // An externally-owned account has no code. Checking first turns a confusing
  // multicall failure into a precise message.
  try {
    const code = await rpc.getCode({ address: checksummed });
    if (!code || code === "0x") {
      return err(
        appError(
          "invalid_input",
          "That address holds no contract code — it looks like a wallet, not a token.",
        ),
      );
    }
  } catch (cause) {
    return err(
      appError(
        "upstream_unavailable",
        "Could not reach any Ethereum RPC endpoint.",
        briefly(cause),
      ),
    );
  }

  try {
    const [name, symbol, decimals, totalSupply] = await Promise.all([
      rpc.readContract({ address: checksummed, abi: erc20Abi, functionName: "name" }),
      rpc.readContract({ address: checksummed, abi: erc20Abi, functionName: "symbol" }),
      rpc.readContract({ address: checksummed, abi: erc20Abi, functionName: "decimals" }),
      rpc.readContract({ address: checksummed, abi: erc20Abi, functionName: "totalSupply" }),
    ]);

    return ok({
      address: checksummed,
      name,
      symbol,
      decimals,
      totalSupply: formatUnits(totalSupply, decimals),
      totalSupplyRaw: totalSupply.toString(),
    });
  } catch (cause) {
    // A contract without the ERC-20 read surface reverts on these calls. That
    // is a user-input problem, not an outage, so it is reported as such.
    return err(
      appError(
        "invalid_input",
        "That contract does not expose the standard ERC-20 read functions.",
        briefly(cause),
      ),
    );
  }
}

/** A few well-known tokens, so the UI has something to demonstrate with. */
export const SAMPLE_TOKENS: ReadonlyArray<{ label: string; address: string }> = [
  { label: "USDC", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
  { label: "WETH", address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" },
  { label: "LINK", address: "0x514910771AF9Ca656af840dff83E8264EcF986CA" },
];
