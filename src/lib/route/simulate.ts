import { appError, err, ok, type AppError, type Result } from "@/lib/result";
import { round8 } from "@/lib/score/technical";
import type { Side } from "@/lib/size/position";
import { VENUES, type Venue } from "./venues";

/* -----------------------------------------------------------------------------
 * ROUTE — SIMULATION ONLY.
 *
 * Nothing in this file, and nothing it calls, submits an order anywhere. There
 * is no exchange client, no credential, no signing key, and no network write
 * path in this module. It computes what a fill *would* cost against a table of
 * fictional venues and hands that back as data.
 *
 * If this application is ever extended to place a real order, that must be a
 * new, separate, deliberately built module — not a flag added to this one.
 * -------------------------------------------------------------------------- */

/**
 * Slippage model.
 *
 *   impactBps = min(maxImpactBps, (notional / depth) * IMPACT_SCALE_BPS)
 *   totalSlippageBps = spreadBps(signed for side) + impactBps
 *
 * Impact scales linearly with the order's size relative to venue depth and is
 * capped, because a linear model extrapolated to a huge order stops being
 * meaningful. Real impact is closer to a square-root law; this is an
 * intentional simplification and is documented as one rather than presented as
 * a market-accurate model.
 */
export const IMPACT_SCALE_BPS = 100;
export const MAX_IMPACT_BPS = 50;

export type VenueQuote = {
  venue: Venue;
  /** Price after spread and market impact, before fees. */
  effectivePrice: number;
  /** Total cost to buy / proceeds to sell, including fees. */
  totalCost: number;
  slippageBps: number;
  feeBps: number;
};

export type RouteDecision = {
  chosen: VenueQuote;
  considered: VenueQuote[];
  reason: string;
  /** Always true. There is no code path that sets this to false. */
  simulated: true;
};

/**
 * What one venue would cost for this order.
 *
 * A buy pays the spread and the impact; a sell receives them in the opposite
 * direction. Fees are always a cost to the taker regardless of side.
 */
export function quoteVenue(
  venue: Venue,
  referencePrice: number,
  quantity: number,
  side: Side,
): VenueQuote {
  const notional = referencePrice * quantity;

  const impactBps = Math.min(
    MAX_IMPACT_BPS,
    (notional / venue.depth) * IMPACT_SCALE_BPS,
  );

  // The venue's spread is a property of its quote and applies the same way to
  // either side. Market impact always works against the taker: a buy pushes
  // the price up, a sell pushes it down.
  const slippageBps = round8(
    venue.spreadBps + (side === "buy" ? impactBps : -impactBps),
  );

  const effectivePrice = round8(referencePrice * (1 + slippageBps / 10_000));

  const feeMultiplier = venue.feeBps / 10_000;
  const gross = effectivePrice * quantity;
  const fee = gross * feeMultiplier;

  // Buying: fees add to what you pay. Selling: fees subtract from proceeds.
  const totalCost = round8(side === "buy" ? gross + fee : gross - fee);

  return {
    venue,
    effectivePrice,
    totalCost,
    slippageBps,
    feeBps: venue.feeBps,
  };
}

/**
 * Choose a venue.
 *
 * The rule, stated plainly: **buy where the all-in cost is lowest; sell where
 * the net proceeds are highest.** Fees and slippage are both included, because
 * routing on displayed price alone is how an apparently better quote turns out
 * to be worse after costs.
 *
 * Ties break on venue id so the decision is deterministic and testable.
 */
export function routeOrder(
  referencePrice: number,
  quantity: number,
  side: Side,
  venues: readonly Venue[] = VENUES,
): Result<RouteDecision, AppError> {
  if (!Number.isFinite(referencePrice) || referencePrice <= 0) {
    return err(appError("invalid_input", "Reference price must be positive."));
  }
  if (!Number.isFinite(quantity) || quantity <= 0) {
    return err(appError("invalid_input", "Quantity must be positive."));
  }
  if (venues.length === 0) {
    return err(appError("invalid_input", "No venues are configured."));
  }

  const considered = venues.map((venue) =>
    quoteVenue(venue, referencePrice, quantity, side),
  );

  const sorted = [...considered].sort((a, b) => {
    const delta =
      side === "buy" ? a.totalCost - b.totalCost : b.totalCost - a.totalCost;
    if (delta !== 0) return delta;
    return a.venue.id.localeCompare(b.venue.id);
  });

  const chosen = sorted[0]!;
  const runnerUp = sorted[1];

  const savingBps =
    runnerUp === undefined
      ? 0
      : round8(
          (Math.abs(runnerUp.totalCost - chosen.totalCost) /
            Math.max(chosen.totalCost, Number.EPSILON)) *
            10_000,
        );

  const verb = side === "buy" ? "lowest all-in cost" : "highest net proceeds";
  const reason =
    runnerUp === undefined
      ? `${chosen.venue.name}: only venue configured.`
      : `${chosen.venue.name}: ${verb} after ${chosen.feeBps} bps fees and ` +
        `${chosen.slippageBps.toFixed(2)} bps slippage — ${savingBps.toFixed(2)} bps ` +
        `better than ${runnerUp.venue.name}.`;

  return ok({ chosen, considered, reason, simulated: true });
}
