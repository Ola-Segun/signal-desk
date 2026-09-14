import "server-only";

import { z } from "zod";

import { getRunStore } from "@/db/store";
import type { RunRow } from "@/db/schema";
import { isLlmConfigured } from "@/lib/env";
import {
  fetchCandles,
  fetchUniverse,
  type Candle,
  type Ticker,
} from "@/lib/market/binance";
import { appError, err, ok, type AppError, type Result } from "@/lib/result";
import { combineScores, type CompositeScore } from "@/lib/score";
import { scoreWithLlm } from "@/lib/score/llm";
import { scoreTechnicals } from "@/lib/score/technical";
import { routeOrder, type RouteDecision } from "@/lib/route/simulate";
import { sizePosition, suggestStop, type SizeResult } from "@/lib/size/position";

/**
 * The service layer.
 *
 * REST route handlers and the GraphQL resolvers both call these functions.
 * Neither transport contains business logic — a transport's job is to validate
 * its own input shape, call one of these, and serialise the result. That is why
 * `/api/score` and the `score` GraphQL field can never drift apart.
 */

// --- Input schemas (shared by both transports) ----------------------------

export const symbolSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{4,20}$/, "Symbol must be 4-20 alphanumeric characters.");

export const scanInputSchema = z.object({
  limit: z.number().int().min(1).max(50).optional(),
  quoteAsset: z.string().trim().toUpperCase().min(2).max(6).optional(),
});

export const scoreInputSchema = z.object({
  symbol: symbolSchema,
  /** Skip the model half even when it is configured. */
  skipLlm: z.boolean().optional(),
});

export const sizeInputSchema = z.object({
  accountEquity: z.number().positive(),
  riskPct: z.number().positive().max(100),
  entry: z.number().positive(),
  stopLoss: z.number().positive(),
  takeProfit: z.number().positive().optional(),
  volatility: z.number().min(0),
  referenceVolatility: z.number().positive().optional(),
});

export const routeInputSchema = z.object({
  symbol: symbolSchema,
  accountEquity: z.number().positive().default(10_000),
  riskPct: z.number().positive().max(100).default(1),
  skipLlm: z.boolean().optional(),
});

export const runsInputSchema = z.object({
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().min(0).optional(),
});

// --- SCAN -----------------------------------------------------------------

export async function scan(
  input: z.infer<typeof scanInputSchema>,
): Promise<Result<Ticker[], AppError>> {
  return fetchUniverse(input);
}

// --- SCORE ----------------------------------------------------------------

export type ScoreOutput = {
  symbol: string;
  ticker: Ticker;
  composite: CompositeScore;
  candleCount: number;
};

/**
 * Candles are fetched hourly; `periodsPerDay` is 24 to match, so the volatility
 * figure is a daily one regardless of the candle interval used.
 */
const CANDLE_INTERVAL = "1h" as const;
const CANDLE_PERIODS_PER_DAY = 24;
const CANDLE_LIMIT = 168; // one week of hourly candles

async function loadTickerAndCandles(
  symbol: string,
): Promise<Result<{ ticker: Ticker; candles: Candle[] }, AppError>> {
  const [universeResult, candlesResult] = await Promise.all([
    fetchUniverse({ limit: 50 }),
    fetchCandles(symbol, CANDLE_INTERVAL, CANDLE_LIMIT),
  ]);

  if (!universeResult.ok) return universeResult;
  if (!candlesResult.ok) return candlesResult;

  const ticker = universeResult.value.find((t) => t.symbol === symbol);
  if (!ticker) {
    return err(
      appError(
        "not_found",
        `${symbol} is not in the current top-50 universe by volume.`,
      ),
    );
  }

  return ok({ ticker, candles: candlesResult.value });
}

export async function score(
  input: z.infer<typeof scoreInputSchema>,
): Promise<Result<ScoreOutput, AppError>> {
  const loaded = await loadTickerAndCandles(input.symbol);
  if (!loaded.ok) return loaded;

  const { ticker, candles } = loaded.value;

  const technical = scoreTechnicals(candles, CANDLE_PERIODS_PER_DAY);
  if (!technical.ok) return technical;

  // The model half is optional by design. When it is unavailable the composite
  // falls back to deterministic-only and carries the reason, rather than
  // failing the whole request or silently substituting a neutral value.
  if (input.skipLlm || !isLlmConfigured()) {
    const reason = input.skipLlm
      ? "Model scoring was skipped for this request."
      : "Model scoring is not configured (no ANTHROPIC_API_KEY).";
    return ok({
      symbol: input.symbol,
      ticker,
      composite: combineScores(technical.value, null, reason),
      candleCount: candles.length,
    });
  }

  const llm = await scoreWithLlm(ticker, technical.value);
  const composite = llm.ok
    ? combineScores(technical.value, llm.value.analysis)
    : combineScores(technical.value, null, llm.error.message);

  return ok({
    symbol: input.symbol,
    ticker,
    composite,
    candleCount: candles.length,
  });
}

// --- SIZE -----------------------------------------------------------------

export function size(
  input: z.infer<typeof sizeInputSchema>,
): Result<SizeResult, AppError> {
  return sizePosition(input);
}

// --- ROUTE ----------------------------------------------------------------

export type RouteOutput = {
  run: RunRow;
  score: ScoreOutput;
  size: SizeResult;
  decision: RouteDecision;
  /** Which store the run was written to, so the UI can be honest about it. */
  persistence: "postgres" | "memory";
};

/**
 * The full pipeline: scan → score → size → route, then persist the audit row.
 *
 * The stop is derived from realised volatility rather than asked for, so the
 * demo is a single click. `sizePosition` still treats it as an input it must
 * validate — this function chooses a stop, it does not bypass the risk model.
 */
export async function route(
  input: z.infer<typeof routeInputSchema>,
): Promise<Result<RouteOutput, AppError>> {
  const scored = await score({ symbol: input.symbol, skipLlm: input.skipLlm });
  if (!scored.ok) return scored;

  const { ticker, composite } = scored.value;

  if (composite.direction === "flat") {
    return err(
      appError(
        "invalid_input",
        `The current read on ${input.symbol} is flat, so there is no position to size or route.`,
      ),
    );
  }

  const side = composite.direction === "long" ? "buy" : "sell";
  const entry = ticker.price;

  const stop = suggestStop(entry, composite.technical.volatility, side);
  if (!stop.ok) return stop;

  const sized = sizePosition({
    accountEquity: input.accountEquity,
    riskPct: input.riskPct,
    entry,
    stopLoss: stop.value,
    volatility: composite.technical.volatility,
  });
  if (!sized.ok) return sized;

  const decision = routeOrder(entry, sized.value.quantity, side);
  if (!decision.ok) return decision;

  const store = getRunStore();
  const inserted = await store.insert({
    symbol: input.symbol,
    side,
    compositeScore: composite.score,
    technicalScore: composite.technical.score,
    llmConviction: composite.llm?.conviction ?? null,
    llmDirection: composite.llm?.direction ?? null,
    llmRationale: composite.llm?.rationale ?? null,
    scoreComponents: {
      rsi: composite.technical.rsi,
      volatility: composite.technical.volatility,
      volumeRatio: composite.technical.volumeRatio,
      components: composite.technical.components,
      weighting: composite.weighting,
      llmUnavailableReason: composite.llmUnavailableReason,
    },
    quantity: sized.value.quantity,
    notional: sized.value.notional,
    riskAmount: sized.value.riskAmount,
    entryPrice: entry,
    stopLoss: stop.value,
    venue: decision.value.chosen.venue.name,
    venueReason: decision.value.reason,
    effectivePrice: decision.value.chosen.effectivePrice,
    slippageBps: decision.value.chosen.slippageBps,
    feeBps: decision.value.chosen.feeBps,
    simulated: true,
  });
  if (!inserted.ok) return inserted;

  return ok({
    run: inserted.value,
    score: scored.value,
    size: sized.value,
    decision: decision.value,
    persistence: store.kind,
  });
}

// --- RUNS -----------------------------------------------------------------

export type RunsOutput = {
  runs: RunRow[];
  total: number;
  persistence: "postgres" | "memory";
};

export async function listRuns(
  input: z.infer<typeof runsInputSchema>,
): Promise<Result<RunsOutput, AppError>> {
  const store = getRunStore();
  const limit = input.limit ?? 25;
  const offset = input.offset ?? 0;

  const [rows, total] = await Promise.all([
    store.list(limit, offset),
    store.count(),
  ]);

  if (!rows.ok) return rows;
  if (!total.ok) return total;

  return ok({ runs: rows.value, total: total.value, persistence: store.kind });
}

export async function getRun(id: string): Promise<Result<RunRow, AppError>> {
  return getRunStore().byId(id);
}
