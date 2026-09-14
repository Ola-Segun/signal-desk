"use client";

import { useState } from "react";

import type { AppError } from "@/lib/result";

/**
 * On-chain reads. Read-only, and the UI says so.
 *
 * There is no wallet connector here and no signing path — the server module
 * this calls uses a viem *public* client, which has no account attached and
 * therefore cannot send a transaction even if asked.
 */

type TokenInfo = {
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: string;
};

type ApiEnvelope<T> = { ok: true; data: T } | { ok: false; error: AppError };

const SAMPLES = [
  { label: "USDC", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
  { label: "WETH", address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" },
  { label: "LINK", address: "0x514910771AF9Ca656af840dff83E8264EcF986CA" },
];

export function TokenReader() {
  const [address, setAddress] = useState(SAMPLES[0]!.address);
  const [pending, setPending] = useState(false);
  const [token, setToken] = useState<TokenInfo | null>(null);
  const [error, setError] = useState<AppError | null>(null);

  async function read(target: string) {
    setPending(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/token?address=${encodeURIComponent(target)}`,
      );
      const payload = (await response.json()) as ApiEnvelope<TokenInfo>;
      if (!payload.ok) {
        setError(payload.error);
        setToken(null);
        return;
      }
      setToken(payload.data);
    } catch (cause) {
      setError({
        code: "upstream_unavailable",
        message: "The request failed before it reached the server.",
        detail: cause instanceof Error ? cause.message : undefined,
      });
      setToken(null);
    } finally {
      setPending(false);
    }
  }

  return (
    <section aria-labelledby="chain-heading" className="space-y-3">
      <h2
        id="chain-heading"
        className="text-sm font-semibold uppercase tracking-wide text-ink-300"
      >
        On-chain · read-only
      </h2>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void read(address);
        }}
        className="flex flex-wrap items-end gap-3 rounded-lg border border-desk-700 bg-desk-900 p-4"
      >
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <label htmlFor="token-address" className="text-xs text-ink-500">
            ERC-20 contract address (Ethereum mainnet)
          </label>
          <input
            id="token-address"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            spellCheck={false}
            className="numeric w-full rounded border border-desk-600 bg-desk-850 px-2 py-1.5 text-xs"
          />
        </div>
        <button
          type="submit"
          disabled={pending}
          className="rounded border border-desk-600 px-3 py-2 text-sm text-ink-300 hover:border-accent hover:text-ink-50 disabled:opacity-50"
        >
          {pending ? "Reading…" : "Read contract"}
        </button>
      </form>

      <div className="flex flex-wrap gap-2">
        <span className="text-xs text-ink-500">Try:</span>
        {SAMPLES.map((sample) => (
          <button
            key={sample.address}
            type="button"
            onClick={() => {
              setAddress(sample.address);
              void read(sample.address);
            }}
            className="rounded border border-desk-700 px-2 py-0.5 text-xs text-ink-300 hover:border-accent"
          >
            {sample.label}
          </button>
        ))}
      </div>

      <p aria-live="polite" className="min-h-[1rem] text-xs text-ink-500">
        {pending
          ? "Reading contract…"
          : error
            ? `Failed: ${error.message}`
            : token
              ? `Read ${token.symbol} successfully.`
              : ""}
      </p>

      {error && (
        <div role="alert" className="rounded-lg border border-down/50 bg-down/10 p-3 text-sm">
          <p className="text-down">{error.message}</p>
        </div>
      )}

      {token && (
        <dl className="grid gap-3 rounded-lg border border-desk-700 bg-desk-900 p-4 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-xs uppercase tracking-wide text-ink-500">Name</dt>
            <dd className="mt-0.5">{token.name}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-ink-500">Symbol</dt>
            <dd className="mt-0.5">{token.symbol}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-ink-500">Decimals</dt>
            <dd className="numeric mt-0.5">{token.decimals}</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-xs uppercase tracking-wide text-ink-500">Total supply</dt>
            <dd className="numeric mt-0.5 truncate" title={token.totalSupply}>
              {Number(token.totalSupply).toLocaleString("en-US", {
                maximumFractionDigits: 0,
              })}
            </dd>
          </div>
        </dl>
      )}
    </section>
  );
}
