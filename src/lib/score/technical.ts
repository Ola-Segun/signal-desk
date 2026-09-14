import { appError, err, ok, type AppError, type Result } from "@/lib/result";
import type { Candle } from "@/lib/market/binance";

/**
 * SCORE (deterministic half) — pure functions over candles.
 *
 * No I/O, no clock, no randomness. Given the same candles these return the same
 * numbers forever, which is what makes them unit-testable against hand-computed
 * values rather than against whatever the implementation happened to produce.
 *
 * Every formula here is stated in the comment above it, because "trust the
 * code" is not a specification.
 */

/** Round to 8 decimal places — enough for crypto quantities, and it keeps
 *  float noise (0.30000000000000004) out of stored values and test assertions. */
export function round8(value: number): number {
  return Math.round(value * 1e8) / 1e8;
}

// --- RSI ------------------------------------------------------------------

/**
 * Wilder's RSI.
 *
 *   change_i    = close_i - close_{i-1}
 *   gain_i      = max(change_i, 0)
 *   loss_i      = max(-change_i, 0)
 *   avgGain_p   = mean(gain_1..gain_p)                    (seed)
 *   avgGain_i   = (avgGain_{i-1} * (p-1) + gain_i) / p    (smoothing)
 *   RS          = avgGain / avgLoss
 *   RSI         = 100 - 100 / (1 + RS)
 *
 * When avgLoss is 0 the ratio is undefined; by convention RSI is 100 (and 0
 * when avgGain is also 0 — a flat series has no momentum in either direction).
 *
 * Requires `period + 1` closes: `period` changes need one prior close.
 */
export function rsi(closes: number[], period = 14): Result<number, AppError> {
  if (!Number.isInteger(period) || period < 2) {
    return err(appError("invalid_input", "RSI period must be an integer >= 2."));
  }
  if (closes.length < period + 1) {
    return err(
      appError(
        "invalid_input",
        `RSI(${period}) needs at least ${period + 1} closes, got ${closes.length}.`,
      ),
    );
  }
  if (closes.some((c) => !Number.isFinite(c))) {
    return err(appError("invalid_input", "Closes must all be finite numbers."));
  }

  const gains: number[] = [];
  const losses: number[] = [];
  for (let i = 1; i < closes.length; i += 1) {
    const change = closes[i]! - closes[i - 1]!;
    gains.push(Math.max(change, 0));
    losses.push(Math.max(-change, 0));
  }

  // Seed with the simple mean of the first `period` changes.
  let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;

  // Then smooth across the remainder.
  for (let i = period; i < gains.length; i += 1) {
    avgGain = (avgGain * (period - 1) + gains[i]!) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]!) / period;
  }

  if (avgLoss === 0) return ok(avgGain === 0 ? 0 : 100);

  const rs = avgGain / avgLoss;
  return ok(round8(100 - 100 / (1 + rs)));
}

// --- Realised volatility --------------------------------------------------

/**
 * Realised volatility, as a decimal fraction (0.02 = 2%).
 *
 *   r_i   = ln(close_i / close_{i-1})
 *   sigma = sample stdev of r  (n-1 denominator)
 *   vol   = sigma * sqrt(periodsPerDay)
 *
 * The sqrt scaling converts per-candle volatility to a daily figure, so hourly
 * and 4-hourly candles produce comparable numbers. `periodsPerDay` must match
 * the candle interval — 24 for 1h, 6 for 4h, 1 for 1d.
 */
export function realisedVolatility(
  closes: number[],
  periodsPerDay = 24,
): Result<number, AppError> {
  if (closes.length < 3) {
    return err(
      appError("invalid_input", "Volatility needs at least 3 closes."),
    );
  }
  if (closes.some((c) => !Number.isFinite(c) || c <= 0)) {
    return err(
      appError("invalid_input", "Closes must all be finite and positive."),
    );
  }
  if (!(periodsPerDay > 0)) {
    return err(appError("invalid_input", "periodsPerDay must be positive."));
  }

  const returns: number[] = [];
  for (let i = 1; i < closes.length; i += 1) {
    returns.push(Math.log(closes[i]! / closes[i - 1]!));
  }

  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance =
    returns.reduce((acc, r) => acc + (r - mean) ** 2, 0) / (returns.length - 1);

  return ok(round8(Math.sqrt(variance) * Math.sqrt(periodsPerDay)));
}

// --- Volume ratio ---------------------------------------------------------

/**
 * Current volume against its own recent baseline.
 *
 *   ratio = latest volume / mean(previous `lookback` volumes)
 *
 * 1.0 means "typical". 2.0 means twice the recent average. The latest candle is
 * excluded from its own baseline, otherwise a spike partly averages itself away.
 */
export function volumeRatio(
  volumes: number[],
  lookback = 24,
): Result<number, AppError> {
  if (volumes.length < lookback + 1) {
    return err(
      appError(
        "invalid_input",
        `Volume ratio needs at least ${lookback + 1} candles, got ${volumes.length}.`,
      ),
    );
  }
  if (volumes.some((v) => !Number.isFinite(v) || v < 0)) {
    return err(
      appError("invalid_input", "Volumes must all be finite and non-negative."),
    );
  }

  const latest = volumes[volumes.length - 1]!;
  const baseline = volumes.slice(-(lookback + 1), -1);
  const mean = baseline.reduce((a, b) => a + b, 0) / baseline.length;

  if (mean === 0) {
    return err(
      appError("invalid_input", "Baseline volume is zero — ratio is undefined."),
    );
  }

  return ok(round8(latest / mean));
}

// --- Composite ------------------------------------------------------------

export type TechnicalScore = {
  /** 0-100. Higher is a stronger long-side technical setup. */
  score: number;
  rsi: number;
  volatility: number;
  volumeRatio: number;
  /** Each component's 0-100 contribution, before weighting. */
  components: {
    momentum: number;
    volatility: number;
    participation: number;
  };
};

/**
 * Weights. Stated here as data rather than buried in the arithmetic so the
 * scoring policy can be read, argued with, and changed in one place.
 */
export const TECHNICAL_WEIGHTS = {
  momentum: 0.5,
  volatility: 0.2,
  participation: 0.3,
} as const;

/** Volatility above this (daily, as a fraction) scores zero on that component. */
export const VOLATILITY_CEILING = 0.12;

/** Volume ratio at or above this scores full marks on participation. */
export const PARTICIPATION_CEILING = 3;

export function scoreTechnicals(
  candles: Candle[],
  periodsPerDay = 24,
): Result<TechnicalScore, AppError> {
  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume);

  const rsiResult = rsi(closes, 14);
  if (!rsiResult.ok) return rsiResult;

  const volResult = realisedVolatility(closes, periodsPerDay);
  if (!volResult.ok) return volResult;

  const volRatioResult = volumeRatio(volumes, 24);
  if (!volRatioResult.ok) return volRatioResult;

  const rsiValue = rsiResult.value;
  const volatility = volResult.value;
  const participation = volRatioResult.value;

  // Momentum: RSI maps directly onto 0-100. RSI *is* a 0-100 momentum
  // oscillator, so no rescaling is needed or wanted.
  const momentumComponent = rsiValue;

  // Volatility: lower is better for a risk-adjusted setup. Linear from
  // full marks at zero volatility down to zero at the ceiling.
  const volatilityComponent =
    100 * Math.max(0, 1 - Math.min(volatility, VOLATILITY_CEILING) / VOLATILITY_CEILING);

  // Participation: more volume than usual is corroborating. Linear to the
  // ceiling, then flat — a 50x spike is not 50x the signal of a 3x one.
  const participationComponent =
    100 * Math.min(participation, PARTICIPATION_CEILING) / PARTICIPATION_CEILING;

  const score =
    momentumComponent * TECHNICAL_WEIGHTS.momentum +
    volatilityComponent * TECHNICAL_WEIGHTS.volatility +
    participationComponent * TECHNICAL_WEIGHTS.participation;

  return ok({
    score: round8(score),
    rsi: rsiValue,
    volatility,
    volumeRatio: participation,
    components: {
      momentum: round8(momentumComponent),
      volatility: round8(volatilityComponent),
      participation: round8(participationComponent),
    },
  });
}
