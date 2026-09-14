import { appError, err, ok, type AppError, type Result } from "@/lib/result";
import { round8 } from "@/lib/score/technical";

/**
 * SIZE — how large a position the risk budget permits.
 *
 * Pure and deterministic. Every value returned here is reproduced by hand in
 * `tests/position.test.ts`; the expected numbers in those tests were computed
 * from the formulas below, not captured from a previous run of this code.
 *
 * That distinction matters. `Math.ceil(total * 0.67)` on a three-item check
 * reads like "67%" and silently demands 3/3 — arithmetic that looks right and
 * is wrong is the failure mode unit tests exist to catch, and a test asserting
 * whatever the implementation produced would have caught nothing.
 *
 * ---------------------------------------------------------------------------
 * The model
 * ---------------------------------------------------------------------------
 *
 *   riskAmount   = accountEquity * (riskPct / 100)
 *   perUnitRisk  = |entry - stopLoss|
 *   baseQuantity = riskAmount / perUnitRisk
 *
 *   volAdjustment = referenceVolatility / max(volatility, referenceVolatility)
 *   quantity      = baseQuantity * volAdjustment
 *
 *   notional   = quantity * entry
 *   rMultiple  = |takeProfit - entry| / perUnitRisk      (null without a target)
 *
 * `volAdjustment` is capped at 1: volatility above the reference shrinks the
 * position, volatility below it does not inflate one. Sizing *up* because a
 * market has been quiet is how a risk model turns a calm period into a large
 * loss when the calm ends.
 *
 * Direction is inferred from the stop rather than passed in, which makes the
 * inconsistent combination — a long with a stop above entry — unrepresentable
 * instead of merely discouraged.
 */

export type Side = "buy" | "sell";

export type SizeInput = {
  accountEquity: number;
  /** Percent of equity to risk, 0 < riskPct <= 100. */
  riskPct: number;
  entry: number;
  stopLoss: number;
  takeProfit?: number;
  /** Realised daily volatility as a fraction (0.02 = 2%). */
  volatility: number;
  /** Volatility at which no reduction is applied. Defaults to 2% daily. */
  referenceVolatility?: number;
};

export type SizeResult = {
  side: Side;
  quantity: number;
  notional: number;
  riskAmount: number;
  perUnitRisk: number;
  baseQuantity: number;
  volAdjustment: number;
  rMultiple: number | null;
  entry: number;
  stopLoss: number;
  takeProfit: number | null;
};

export const DEFAULT_REFERENCE_VOLATILITY = 0.02;

export function sizePosition(input: SizeInput): Result<SizeResult, AppError> {
  const {
    accountEquity,
    riskPct,
    entry,
    stopLoss,
    takeProfit,
    volatility,
    referenceVolatility = DEFAULT_REFERENCE_VOLATILITY,
  } = input;

  // --- Validation. Every rejection is explicit; nothing is silently clamped,
  // because a position quietly resized to something the caller did not ask for
  // is more dangerous than an error.

  if (!Number.isFinite(accountEquity) || accountEquity <= 0) {
    return err(
      appError("invalid_input", "Account equity must be a positive number."),
    );
  }
  if (!Number.isFinite(riskPct) || riskPct <= 0 || riskPct > 100) {
    return err(
      appError("invalid_input", "Risk percent must be greater than 0 and at most 100."),
    );
  }
  if (!Number.isFinite(entry) || entry <= 0) {
    return err(appError("invalid_input", "Entry price must be a positive number."));
  }
  if (!Number.isFinite(stopLoss) || stopLoss <= 0) {
    return err(appError("invalid_input", "Stop loss must be a positive number."));
  }
  if (stopLoss === entry) {
    return err(
      appError(
        "invalid_input",
        "Stop loss cannot equal the entry price — the risk per unit would be zero.",
      ),
    );
  }
  if (!Number.isFinite(volatility) || volatility < 0) {
    return err(
      appError("invalid_input", "Volatility must be a non-negative number."),
    );
  }
  if (!Number.isFinite(referenceVolatility) || referenceVolatility <= 0) {
    return err(
      appError("invalid_input", "Reference volatility must be a positive number."),
    );
  }

  const side: Side = stopLoss < entry ? "buy" : "sell";

  if (takeProfit !== undefined) {
    if (!Number.isFinite(takeProfit) || takeProfit <= 0) {
      return err(
        appError("invalid_input", "Take profit must be a positive number."),
      );
    }
    if (side === "buy" && takeProfit <= entry) {
      return err(
        appError(
          "invalid_input",
          "For a long position the take profit must be above the entry price.",
        ),
      );
    }
    if (side === "sell" && takeProfit >= entry) {
      return err(
        appError(
          "invalid_input",
          "For a short position the take profit must be below the entry price.",
        ),
      );
    }
  }

  // --- Arithmetic.

  const riskAmount = accountEquity * (riskPct / 100);
  const perUnitRisk = Math.abs(entry - stopLoss);
  const baseQuantity = riskAmount / perUnitRisk;

  const volAdjustment = round8(
    referenceVolatility / Math.max(volatility, referenceVolatility),
  );

  const quantity = round8(baseQuantity * volAdjustment);
  const notional = round8(quantity * entry);

  const rMultiple =
    takeProfit === undefined
      ? null
      : round8(Math.abs(takeProfit - entry) / perUnitRisk);

  return ok({
    side,
    quantity,
    notional,
    riskAmount: round8(riskAmount),
    perUnitRisk: round8(perUnitRisk),
    baseQuantity: round8(baseQuantity),
    volAdjustment,
    rMultiple,
    entry,
    stopLoss,
    takeProfit: takeProfit ?? null,
  });
}

/**
 * A conventional stop derived from volatility, for when the UI needs to suggest
 * one: `stopDistance = entry * volatility * multiplier`.
 *
 * Convenience only — `sizePosition` never calls this. The caller chooses the
 * stop; the sizer only ever measures the consequences of it.
 */
export function suggestStop(
  entry: number,
  volatility: number,
  side: Side,
  multiplier = 1.5,
): Result<number, AppError> {
  if (!Number.isFinite(entry) || entry <= 0) {
    return err(appError("invalid_input", "Entry price must be positive."));
  }
  if (!Number.isFinite(volatility) || volatility <= 0) {
    return err(appError("invalid_input", "Volatility must be positive."));
  }
  if (!Number.isFinite(multiplier) || multiplier <= 0) {
    return err(appError("invalid_input", "Multiplier must be positive."));
  }

  const distance = entry * volatility * multiplier;
  const stop = side === "buy" ? entry - distance : entry + distance;

  if (stop <= 0) {
    return err(
      appError(
        "invalid_input",
        "Volatility is too high for this entry — the suggested stop would be at or below zero.",
      ),
    );
  }

  return ok(round8(stop));
}
