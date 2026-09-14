"use client";

import { useCallback, useState } from "react";

import type { Ticker } from "@/lib/market/binance";
import type { AppError } from "@/lib/result";
import { TickerGrid } from "./ticker-grid";

/**
 * Stages 2-4 of the desk: score, size, route.
 *
 * One request per user action. The full pipeline runs server-side via
 * `POST /api/route`; this component's job is to collect the inputs, show what
 * came back, and stay honest while it waits.
 */

type ScoreComponents = {
  momentum: number;
  volatility: number;
  participation: number;
};

type ScoreBlock = {
  composite: {
    score: number;
    direction: "long" | "short" | "flat";
    llmUnavailableReason: string | null;
    technical: {
      rsi: number;
      volatility: number;
      volumeRatio: number;
      components: ScoreComponents;
    };
    llm: {
      conviction: number;
      rationale: string;
      risks: string[];
      confidence: string;
    } | null;
  };
};

type NoTradeResponse = {
  outcome: "no_trade";
  score: ScoreBlock;
  reason: string;
};

type RoutedResponse = {
  outcome: "routed";
  run: {
    id: string;
    symbol: string;
    side: "buy" | "sell";
    compositeScore: number;
    technicalScore: number;
    llmConviction: number | null;
    llmDirection: string | null;
    llmRationale: string | null;
    quantity: number;
    notional: number;
    riskAmount: number;
    entryPrice: number;
    stopLoss: number;
    venue: string;
    venueReason: string;
    effectivePrice: number;
    slippageBps: number;
    feeBps: number;
    simulated: boolean;
  };
  score: ScoreBlock;
  size: {
    quantity: number;
    notional: number;
    riskAmount: number;
    perUnitRisk: number;
    baseQuantity: number;
    volAdjustment: number;
  };
  decision: {
    considered: Array<{
      venue: { id: string; name: string; feeBps: number };
      effectivePrice: number;
      totalCost: number;
      slippageBps: number;
    }>;
    reason: string;
  };
  persistence: "postgres" | "memory";
};

type RouteResponse = RoutedResponse | NoTradeResponse;

type ApiEnvelope<T> = { ok: true; data: T } | { ok: false; error: AppError };

export function PipelineRunner({ universe }: { universe: Ticker[] }) {
  const [selected, setSelected] = useState<string | null>(
    universe[0]?.symbol ?? null,
  );
  const [equity, setEquity] = useState(10_000);
  const [riskPct, setRiskPct] = useState(1);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<RouteResponse | null>(null);
  const [error, setError] = useState<AppError | null>(null);

  const run = useCallback(async () => {
    if (!selected) return;
    setPending(true);
    setError(null);

    try {
      const response = await fetch("/api/route", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol: selected,
          accountEquity: equity,
          riskPct,
        }),
      });
      const payload = (await response.json()) as ApiEnvelope<RouteResponse>;

      if (!payload.ok) {
        setError(payload.error);
        setResult(null);
        return;
      }
      setResult(payload.data);
    } catch (cause) {
      setError({
        code: "upstream_unavailable",
        message: "The request failed before it reached the server.",
        detail: cause instanceof Error ? cause.message : undefined,
      });
      setResult(null);
    } finally {
      setPending(false);
    }
  }, [selected, equity, riskPct]);

  return (
    <div className="space-y-8">
      <TickerGrid initial={universe} onSelect={setSelected} selected={selected} />

      <section aria-labelledby="params-heading" className="space-y-3">
        <h2
          id="params-heading"
          className="text-sm font-semibold uppercase tracking-wide text-ink-300"
        >
          2 · Risk budget
        </h2>

        <div className="flex flex-wrap items-end gap-4 rounded-lg border border-desk-700 bg-desk-900 p-4">
          <div className="flex flex-col gap-1">
            <label htmlFor="equity" className="text-xs text-ink-500">
              Account equity (USD)
            </label>
            <input
              id="equity"
              type="number"
              min={1}
              step={100}
              value={equity}
              onChange={(e) => setEquity(Number(e.target.value))}
              className="numeric w-40 rounded border border-desk-600 bg-desk-850 px-2 py-1.5 text-right"
            />
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="risk" className="text-xs text-ink-500">
              Risk per trade (%)
            </label>
            <input
              id="risk"
              type="number"
              min={0.1}
              max={100}
              step={0.1}
              value={riskPct}
              onChange={(e) => setRiskPct(Number(e.target.value))}
              className="numeric w-28 rounded border border-desk-600 bg-desk-850 px-2 py-1.5 text-right"
              aria-describedby="risk-hint"
            />
          </div>

          <p id="risk-hint" className="max-w-xs text-xs text-ink-500">
            The stop is derived from realised volatility; this is the share of
            equity lost if that stop is hit.
          </p>

          <button
            type="button"
            onClick={run}
            disabled={pending || !selected}
            className="ml-auto rounded bg-accent px-4 py-2 font-medium text-desk-950 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pending ? "Running…" : `Run pipeline${selected ? ` · ${selected}` : ""}`}
          </button>
        </div>

        {/* Pre-existing live region: announces outcome without stealing focus. */}
        <p aria-live="polite" className="min-h-[1.25rem] text-xs text-ink-500">
          {pending
            ? "Scoring, sizing and routing…"
            : error
              ? `Failed: ${error.message}`
              : result?.outcome === "routed"
                ? `Simulated ${result.run.side} of ${result.run.symbol} routed to ${result.run.venue}.`
                : result?.outcome === "no_trade"
                  ? "No position taken — the read came back flat."
                  : ""}
        </p>
      </section>

      {error && (
        <div
          role="alert"
          className="rounded-lg border border-down/50 bg-down/10 p-4 text-sm"
        >
          <p className="font-medium text-down">{error.message}</p>
          {error.detail && (
            <p className="mt-1 text-xs text-ink-300">{error.detail}</p>
          )}
        </div>
      )}

      {result?.outcome === "no_trade" && <NoTradeResult result={result} />}
      {result?.outcome === "routed" && <PipelineResult result={result} />}
    </div>
  );
}

/**
 * Declining to trade is a result, and it gets a real panel rather than an
 * error. A risk model that only ever says yes is not a risk model — showing
 * the score behind a "no" is the more informative screen, not the consolation
 * prize.
 */
function NoTradeResult({ result }: { result: NoTradeResponse }) {
  const composite = result.score.composite;

  return (
    <div className="space-y-6">
      <section aria-labelledby="notrade-heading" className="space-y-3">
        <h2
          id="notrade-heading"
          className="text-sm font-semibold uppercase tracking-wide text-ink-300"
        >
          3 · Score — no position
        </h2>

        <div className="rounded-lg border border-flat/30 bg-desk-900 p-4">
          <p className="text-sm text-ink-50">{result.reason}</p>
          <p className="mt-2 text-xs text-ink-500">
            Sizing and routing are skipped and nothing is written to the audit
            trail, because there is no position to record. This is the pipeline
            working, not failing.
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Composite" value={composite.score.toFixed(1)} suffix="/100" emphasis />
          <Stat label="Direction" value={composite.direction} />
          <Stat label="RSI(14)" value={composite.technical.rsi.toFixed(1)} />
          <Stat
            label="Volatility (daily)"
            value={`${(composite.technical.volatility * 100).toFixed(2)}%`}
          />
        </div>

        <div className="rounded-lg border border-desk-700 bg-desk-900 p-4 text-sm">
          <h3 className="mb-2 text-xs uppercase tracking-wide text-ink-500">
            Why — components before weighting
          </h3>
          <dl className="grid gap-2 sm:grid-cols-3">
            <Component label="Momentum" value={composite.technical.components.momentum} />
            <Component label="Volatility" value={composite.technical.components.volatility} />
            <Component label="Participation" value={composite.technical.components.participation} />
          </dl>
        </div>

        {composite.llm && (
          <div className="rounded-lg border border-accent/40 bg-accent/5 p-4 text-sm">
            <h3 className="mb-1 text-xs uppercase tracking-wide text-accent">
              Model assessment · conviction {composite.llm.conviction}/100 ·{" "}
              {composite.llm.confidence} confidence
            </h3>
            <p className="text-ink-300">{composite.llm.rationale}</p>
          </div>
        )}
      </section>
    </div>
  );
}

function PipelineResult({ result }: { result: RoutedResponse }) {
  const { run, score, size, decision, persistence } = result;
  const composite = score.composite;

  return (
    <div className="space-y-8">
      {/* --- SCORE --- */}
      <section aria-labelledby="score-heading" className="space-y-3">
        <h2
          id="score-heading"
          className="text-sm font-semibold uppercase tracking-wide text-ink-300"
        >
          3 · Score
        </h2>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Composite" value={composite.score.toFixed(1)} suffix="/100" emphasis />
          <Stat label="Direction" value={composite.direction} />
          <Stat label="RSI(14)" value={composite.technical.rsi.toFixed(1)} />
          <Stat
            label="Volatility (daily)"
            value={`${(composite.technical.volatility * 100).toFixed(2)}%`}
          />
        </div>

        <div className="rounded-lg border border-desk-700 bg-desk-900 p-4 text-sm">
          <h3 className="mb-2 text-xs uppercase tracking-wide text-ink-500">
            Why — components before weighting
          </h3>
          <dl className="grid gap-2 sm:grid-cols-3">
            <Component label="Momentum" value={composite.technical.components.momentum} />
            <Component label="Volatility" value={composite.technical.components.volatility} />
            <Component label="Participation" value={composite.technical.components.participation} />
          </dl>
        </div>

        {composite.llm ? (
          <div className="rounded-lg border border-accent/40 bg-accent/5 p-4 text-sm">
            <h3 className="mb-1 text-xs uppercase tracking-wide text-accent">
              Model assessment · conviction {composite.llm.conviction}/100 ·{" "}
              {composite.llm.confidence} confidence
            </h3>
            <p className="text-ink-300">{composite.llm.rationale}</p>
            {composite.llm.risks.length > 0 && (
              <>
                <h4 className="mt-3 text-xs uppercase tracking-wide text-ink-500">Risks</h4>
                <ul className="mt-1 list-disc space-y-0.5 pl-5 text-ink-300">
                  {composite.llm.risks.map((risk) => (
                    <li key={risk}>{risk}</li>
                  ))}
                </ul>
              </>
            )}
          </div>
        ) : (
          <p className="rounded-lg border border-desk-700 bg-desk-850 p-3 text-xs text-ink-500">
            <strong className="text-ink-300">Deterministic score only.</strong>{" "}
            {composite.llmUnavailableReason ?? "The model half is unavailable."}{" "}
            The composite above is the technical score alone — no neutral value
            has been substituted for the missing half.
          </p>
        )}
      </section>

      {/* --- SIZE --- */}
      <section aria-labelledby="size-heading" className="space-y-3">
        <h2
          id="size-heading"
          className="text-sm font-semibold uppercase tracking-wide text-ink-300"
        >
          4 · Size
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Quantity" value={size.quantity.toPrecision(6)} />
          <Stat label="Notional" value={`$${size.notional.toLocaleString("en-US", { maximumFractionDigits: 2 })}`} />
          <Stat label="Risk amount" value={`$${size.riskAmount.toFixed(2)}`} />
          <Stat label="Vol adjustment" value={`${(size.volAdjustment * 100).toFixed(0)}%`} />
        </div>
        <p className="text-xs text-ink-500">
          Base quantity {size.baseQuantity.toPrecision(6)} reduced by the
          volatility adjustment. Entry ${run.entryPrice.toPrecision(6)}, stop $
          {run.stopLoss.toPrecision(6)}, risk per unit $
          {size.perUnitRisk.toPrecision(4)}.
        </p>
      </section>

      {/* --- ROUTE --- */}
      <section aria-labelledby="route-heading" className="space-y-3">
        <h2
          id="route-heading"
          className="text-sm font-semibold uppercase tracking-wide text-ink-300"
        >
          5 · Route <span className="text-warn">(simulated)</span>
        </h2>

        <div className="overflow-x-auto rounded-lg border border-desk-700">
          <table className="w-full min-w-[36rem] border-collapse text-sm">
            <caption className="sr-only">
              Venues considered, with the chosen one marked.
            </caption>
            <thead className="bg-desk-850 text-left text-xs uppercase tracking-wide text-ink-500">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">Venue</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Effective price</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Slippage</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Fee</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  {run.side === "buy" ? "All-in cost" : "Net proceeds"}
                </th>
              </tr>
            </thead>
            <tbody>
              {decision.considered.map((quote) => {
                const chosen = quote.venue.name === run.venue;
                return (
                  <tr
                    key={quote.venue.id}
                    className={`border-t border-desk-800 ${chosen ? "bg-up/10" : ""}`}
                  >
                    <th scope="row" className="px-3 py-2 text-left font-medium">
                      {quote.venue.name}
                      {/* Text label, not just the row highlight. */}
                      {chosen && (
                        <span className="ml-2 rounded bg-up/20 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-up">
                          Chosen
                        </span>
                      )}
                    </th>
                    <td className="numeric px-3 py-2 text-right">
                      {quote.effectivePrice.toPrecision(8)}
                    </td>
                    <td className="numeric px-3 py-2 text-right text-ink-300">
                      {quote.slippageBps.toFixed(2)} bps
                    </td>
                    <td className="numeric px-3 py-2 text-right text-ink-300">
                      {quote.venue.feeBps} bps
                    </td>
                    <td className="numeric px-3 py-2 text-right">
                      ${quote.totalCost.toLocaleString("en-US", { maximumFractionDigits: 2 })}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <p className="text-xs text-ink-300">{decision.reason}</p>

        <div className="rounded-lg border border-warn/40 bg-warn/10 p-3 text-xs text-warn">
          <strong>No order was placed.</strong> Audit row{" "}
          <code className="numeric">{run.id.slice(0, 8)}</code> written to the{" "}
          {persistence === "postgres" ? "Postgres" : "in-memory"} store with
          simulated = {String(run.simulated)}.
          {persistence === "memory" && (
            <> This store resets when the server restarts — set DATABASE_URL to persist.</>
          )}
        </div>
      </section>
    </div>
  );
}

function Stat({
  label,
  value,
  suffix,
  emphasis,
}: {
  label: string;
  value: string;
  suffix?: string;
  emphasis?: boolean;
}) {
  return (
    <div className="rounded-lg border border-desk-700 bg-desk-900 p-3">
      <dt className="text-xs uppercase tracking-wide text-ink-500">{label}</dt>
      <dd
        className={`numeric mt-1 ${emphasis ? "text-2xl text-accent" : "text-lg"}`}
      >
        {value}
        {suffix && <span className="text-sm text-ink-500">{suffix}</span>}
      </dd>
    </div>
  );
}

function Component({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="text-xs text-ink-500">{label}</dt>
      <dd className="numeric flex items-center gap-2">
        <span className="w-12">{value.toFixed(1)}</span>
        {/* Decorative bar; the number beside it carries the value. */}
        <span
          aria-hidden="true"
          className="h-1.5 flex-1 overflow-hidden rounded bg-desk-700"
        >
          <span
            className="block h-full bg-accent"
            style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
          />
        </span>
      </dd>
    </div>
  );
}
