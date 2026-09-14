import { describe, expect, it } from "vitest";

import { unwrap } from "@/lib/result";
import {
  IMPACT_SCALE_BPS,
  MAX_IMPACT_BPS,
  quoteVenue,
  routeOrder,
} from "@/lib/route/simulate";
import { VENUES, type Venue } from "@/lib/route/venues";

/**
 * Venue quoting and selection, hand-computed from the model in
 * `src/lib/route/simulate.ts`:
 *
 *   impactBps        = min(50, (notional / depth) * 100)
 *   slippageBps      = spreadBps + (buy ? +impactBps : -impactBps)
 *   effectivePrice   = reference * (1 + slippageBps / 10000)
 *   totalCost (buy)  = gross + fee
 *   totalCost (sell) = gross - fee
 */

const alpha: Venue = {
  id: "alpha",
  name: "Alpha Exchange",
  feeBps: 10,
  spreadBps: -2,
  depth: 2_000_000,
};

describe("quoteVenue", () => {
  it("prices a buy with impact working against the taker", () => {
    //   notional    = 100 * 100 = 10,000
    //   impactBps   = min(50, (10000 / 2,000,000) * 100) = min(50, 0.5) = 0.5
    //   slippageBps = -2 + 0.5 = -1.5
    //   price       = 100 * (1 - 0.00015) = 99.985
    //   gross       = 99.985 * 100 = 9,998.50
    //   fee         = 9,998.50 * 0.0010 = 9.9985
    //   totalCost   = 9,998.50 + 9.9985 = 10,008.4985
    const quote = quoteVenue(alpha, 100, 100, "buy");

    expect(quote.slippageBps).toBe(-1.5);
    expect(quote.effectivePrice).toBeCloseTo(99.985, 8);
    expect(quote.feeBps).toBe(10);
    expect(quote.totalCost).toBeCloseTo(10_008.4985, 6);
  });

  it("prices a sell with impact in the opposite direction", () => {
    // This is the case that catches a sign error. Impact must *subtract* on a
    // sell, so the same venue and size gives a different slippage:
    //   slippageBps = -2 - 0.5 = -2.5
    //   price       = 100 * (1 - 0.00025) = 99.975
    //   gross       = 9,997.50
    //   fee         = 9,997.50 * 0.0010 = 9.9975
    //   proceeds    = 9,997.50 - 9.9975 = 9,987.5025
    const quote = quoteVenue(alpha, 100, 100, "sell");

    expect(quote.slippageBps).toBe(-2.5);
    expect(quote.effectivePrice).toBeCloseTo(99.975, 8);
    expect(quote.totalCost).toBeCloseTo(9_987.5025, 6);
  });

  it("gives buy and sell different slippage for the same order", () => {
    // A model where impact is side-independent would make these equal.
    const buy = quoteVenue(alpha, 100, 100, "buy");
    const sell = quoteVenue(alpha, 100, 100, "sell");
    expect(buy.slippageBps).not.toBe(sell.slippageBps);
    // Symmetric about the venue's own spread: -2 + 0.5 and -2 - 0.5.
    expect(buy.slippageBps + sell.slippageBps).toBeCloseTo(2 * alpha.spreadBps, 8);
  });

  it("caps market impact rather than extrapolating without bound", () => {
    //   notional  = 20,000 * 100 = 2,000,000
    //   uncapped  = (2,000,000 / 2,000,000) * 100 = 100 bps
    //   capped    = 50 bps
    //   slippage  = -2 + 50 = 48
    expect(MAX_IMPACT_BPS).toBe(50);
    expect(IMPACT_SCALE_BPS).toBe(100);

    const quote = quoteVenue(alpha, 100, 20_000, "buy");
    expect(quote.slippageBps).toBe(48);
  });

  it("scales impact linearly below the cap", () => {
    // Doubling the order size doubles the impact component:
    //   100 units  -> impact 0.5 bps  -> slippage -1.5
    //   200 units  -> impact 1.0 bps  -> slippage -1.0
    expect(quoteVenue(alpha, 100, 100, "buy").slippageBps).toBe(-1.5);
    expect(quoteVenue(alpha, 100, 200, "buy").slippageBps).toBe(-1);
  });
});

describe("routeOrder", () => {
  it("buys where the all-in cost is lowest", () => {
    // For 100 units at a reference of 100 (notional 10,000):
    //
    //   alpha  fee 10, spread -2,  depth 2.0M -> impact 0.50 -> slip  -1.50
    //          price 99.985   gross 9,998.50   fee  9.9985  -> 10,008.4985
    //   beta   fee  4, spread +6,  depth 5.0M -> impact 0.20 -> slip   6.20
    //          price 100.062  gross 10,006.20  fee  4.00248 -> 10,010.20248
    //   gamma  fee  7, spread +1,  depth 0.8M -> impact 1.25 -> slip   2.25
    //          price 100.0225 gross 10,002.25  fee  7.001575-> 10,009.251575
    //   delta  fee  2, spread +12, depth 12M  -> impact 0.083-> slip  12.0833
    //          price 100.1208 gross 10,012.08  fee  2.00242 -> 10,014.0858
    //
    // Lowest all-in cost: alpha.
    const decision = unwrap(routeOrder(100, 100, "buy"));
    expect(decision.chosen.venue.id).toBe("alpha");
    expect(decision.chosen.totalCost).toBeCloseTo(10_008.4985, 4);
    expect(decision.considered).toHaveLength(VENUES.length);
  });

  it("sells where the net proceeds are highest — a different venue", () => {
    //   alpha  slip -2.5    price 99.975   gross 9,997.50  fee 9.9975   ->  9,987.5025
    //   beta   slip  5.8    price 100.058  gross 10,005.80 fee 4.00232  -> 10,001.79768
    //   gamma  slip -0.25   price 99.9975  gross 9,999.75  fee 6.999825 ->  9,992.750175
    //   delta  slip 11.9167 price 100.1192 gross 10,011.92 fee 2.002383 -> 10,009.914
    //
    // Highest proceeds: delta. Buying and selling route differently, which is
    // the behaviour a fee-and-slippage-aware router should have — routing on
    // displayed price alone would pick the same venue for both.
    const decision = unwrap(routeOrder(100, 100, "sell"));
    expect(decision.chosen.venue.id).toBe("delta");
    expect(decision.chosen.totalCost).toBeCloseTo(10_009.914, 2);
  });

  it("includes a human-readable reason naming the runner-up", () => {
    const decision = unwrap(routeOrder(100, 100, "buy"));
    expect(decision.reason).toContain("Alpha Exchange");
    expect(decision.reason).toMatch(/bps/);
  });

  it("always reports the decision as simulated", () => {
    const decision = unwrap(routeOrder(100, 100, "buy"));
    expect(decision.simulated).toBe(true);
  });

  it("breaks ties deterministically on venue id", () => {
    const twins: Venue[] = [
      { id: "zulu", name: "Zulu", feeBps: 5, spreadBps: 0, depth: 1_000_000 },
      { id: "alfa", name: "Alfa", feeBps: 5, spreadBps: 0, depth: 1_000_000 },
    ];
    const decision = unwrap(routeOrder(100, 10, "buy", twins));
    expect(decision.chosen.venue.id).toBe("alfa");
  });

  it("rejects invalid inputs", () => {
    expect(routeOrder(0, 100, "buy").ok).toBe(false);
    expect(routeOrder(-100, 100, "buy").ok).toBe(false);
    expect(routeOrder(100, 0, "buy").ok).toBe(false);
    expect(routeOrder(100, -1, "buy").ok).toBe(false);
    expect(routeOrder(Number.NaN, 100, "buy").ok).toBe(false);
    expect(routeOrder(100, 100, "buy", []).ok).toBe(false);
  });
});
