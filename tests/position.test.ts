import { describe, expect, it } from "vitest";

import { sizePosition, suggestStop } from "@/lib/size/position";
import { unwrap } from "@/lib/result";

/**
 * Every expected value in this file was computed by hand from the formulas
 * documented in `src/lib/size/position.ts`, not captured from a previous run of
 * that code. A test that asserts whatever the implementation produced verifies
 * only that the implementation is deterministic — it cannot catch arithmetic
 * that is confidently wrong.
 *
 * The worked arithmetic is in the comment above each case so a reviewer can
 * check the expectation without running anything.
 */

describe("sizePosition — core arithmetic", () => {
  it("sizes a long at the reference volatility", () => {
    //   riskAmount   = 10000 * (1/100)      = 100
    //   perUnitRisk  = |100 - 95|           = 5
    //   baseQuantity = 100 / 5              = 20
    //   volAdj       = 0.02 / max(.02,.02)  = 1
    //   quantity     = 20 * 1               = 20
    //   notional     = 20 * 100             = 2000
    const result = unwrap(
      sizePosition({
        accountEquity: 10_000,
        riskPct: 1,
        entry: 100,
        stopLoss: 95,
        volatility: 0.02,
      }),
    );

    expect(result.side).toBe("buy");
    expect(result.riskAmount).toBe(100);
    expect(result.perUnitRisk).toBe(5);
    expect(result.baseQuantity).toBe(20);
    expect(result.volAdjustment).toBe(1);
    expect(result.quantity).toBe(20);
    expect(result.notional).toBe(2000);
    expect(result.rMultiple).toBeNull();
  });

  it("halves the position when volatility is twice the reference", () => {
    //   volAdj   = 0.02 / max(0.04, 0.02) = 0.02 / 0.04 = 0.5
    //   quantity = 20 * 0.5               = 10
    //   notional = 10 * 100               = 1000
    const result = unwrap(
      sizePosition({
        accountEquity: 10_000,
        riskPct: 1,
        entry: 100,
        stopLoss: 95,
        volatility: 0.04,
      }),
    );

    expect(result.volAdjustment).toBe(0.5);
    expect(result.quantity).toBe(10);
    expect(result.notional).toBe(1000);
  });

  it("does NOT size up when volatility is below the reference", () => {
    // This is the important one. max(volatility, reference) caps the
    // adjustment at 1, so a quiet market cannot inflate the position:
    //   volAdj = 0.02 / max(0.01, 0.02) = 0.02 / 0.02 = 1
    // Without the max() this would be 0.02/0.01 = 2 and the position would
    // double precisely because the market had been calm.
    const result = unwrap(
      sizePosition({
        accountEquity: 10_000,
        riskPct: 1,
        entry: 100,
        stopLoss: 95,
        volatility: 0.01,
      }),
    );

    expect(result.volAdjustment).toBe(1);
    expect(result.quantity).toBe(20);
  });

  it("infers a short from a stop above entry", () => {
    //   perUnitRisk = |100 - 105| = 5, so the quantity matches the long case.
    const result = unwrap(
      sizePosition({
        accountEquity: 10_000,
        riskPct: 1,
        entry: 100,
        stopLoss: 105,
        volatility: 0.02,
      }),
    );

    expect(result.side).toBe("sell");
    expect(result.perUnitRisk).toBe(5);
    expect(result.quantity).toBe(20);
  });

  it("computes the R multiple from a take profit", () => {
    //   rMultiple = |115 - 100| / |100 - 95| = 15 / 5 = 3
    const result = unwrap(
      sizePosition({
        accountEquity: 10_000,
        riskPct: 1,
        entry: 100,
        stopLoss: 95,
        takeProfit: 115,
        volatility: 0.02,
      }),
    );

    expect(result.rMultiple).toBe(3);
    expect(result.takeProfit).toBe(115);
  });

  it("scales with equity and risk percent", () => {
    //   riskAmount   = 25000 * (2/100) = 500
    //   perUnitRisk  = |50 - 45|       = 5
    //   baseQuantity = 500 / 5         = 100
    //   quantity     = 100 * 1         = 100
    //   notional     = 100 * 50        = 5000
    const result = unwrap(
      sizePosition({
        accountEquity: 25_000,
        riskPct: 2,
        entry: 50,
        stopLoss: 45,
        volatility: 0.02,
      }),
    );

    expect(result.riskAmount).toBe(500);
    expect(result.quantity).toBe(100);
    expect(result.notional).toBe(5000);
  });

  it("rounds the volatility adjustment to 8 decimal places", () => {
    //   volAdj = 0.02 / 0.06 = 0.333333... -> 0.33333333 at 8 dp
    //   quantity = 100 * 0.33333333 = 33.333333
    const result = unwrap(
      sizePosition({
        accountEquity: 10_000,
        riskPct: 1,
        entry: 3,
        stopLoss: 2,
        volatility: 0.06,
      }),
    );

    expect(result.baseQuantity).toBe(100);
    expect(result.volAdjustment).toBe(0.33333333);
    expect(result.quantity).toBeCloseTo(33.333333, 6);
  });

  it("honours an explicit reference volatility", () => {
    //   volAdj = 0.05 / max(0.10, 0.05) = 0.5
    const result = unwrap(
      sizePosition({
        accountEquity: 10_000,
        riskPct: 1,
        entry: 100,
        stopLoss: 95,
        volatility: 0.1,
        referenceVolatility: 0.05,
      }),
    );

    expect(result.volAdjustment).toBe(0.5);
    expect(result.quantity).toBe(10);
  });
});

describe("sizePosition — rejections", () => {
  const base = {
    accountEquity: 10_000,
    riskPct: 1,
    entry: 100,
    stopLoss: 95,
    volatility: 0.02,
  };

  // Each of these is rejected rather than clamped. A position silently resized
  // to something the caller did not ask for is more dangerous than an error.
  const cases: ReadonlyArray<[string, Parameters<typeof sizePosition>[0]]> = [
    ["zero equity", { ...base, accountEquity: 0 }],
    ["negative equity", { ...base, accountEquity: -1 }],
    ["non-finite equity", { ...base, accountEquity: Number.NaN }],
    ["infinite equity", { ...base, accountEquity: Number.POSITIVE_INFINITY }],
    ["zero risk percent", { ...base, riskPct: 0 }],
    ["negative risk percent", { ...base, riskPct: -5 }],
    ["risk percent above 100", { ...base, riskPct: 101 }],
    ["zero entry", { ...base, entry: 0 }],
    ["negative entry", { ...base, entry: -100 }],
    ["zero stop", { ...base, stopLoss: 0 }],
    ["stop equal to entry", { ...base, stopLoss: 100 }],
    ["negative volatility", { ...base, volatility: -0.01 }],
    ["non-finite volatility", { ...base, volatility: Number.NaN }],
    ["zero reference volatility", { ...base, referenceVolatility: 0 }],
    ["take profit below entry on a long", { ...base, takeProfit: 99 }],
    ["take profit equal to entry on a long", { ...base, takeProfit: 100 }],
    [
      "take profit above entry on a short",
      { ...base, stopLoss: 105, takeProfit: 101 },
    ],
    ["negative take profit", { ...base, takeProfit: -10 }],
  ];

  it.each(cases)("rejects %s", (_label, input) => {
    const result = sizePosition(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("invalid_input");
      expect(result.error.message.length).toBeGreaterThan(0);
    }
  });

  it("accepts exactly 100 percent risk as the boundary", () => {
    const result = sizePosition({ ...base, riskPct: 100 });
    expect(result.ok).toBe(true);
  });
});

describe("suggestStop", () => {
  it("places a long stop below entry by volatility * multiplier", () => {
    //   distance = 100 * 0.02 * 1.5 = 3
    //   stop     = 100 - 3          = 97
    expect(unwrap(suggestStop(100, 0.02, "buy", 1.5))).toBe(97);
  });

  it("places a short stop above entry", () => {
    //   stop = 100 + 3 = 103
    expect(unwrap(suggestStop(100, 0.02, "sell", 1.5))).toBe(103);
  });

  it("rejects a volatility that would push the stop to or below zero", () => {
    //   distance = 100 * 0.8 * 1.5 = 120  ->  stop = -20
    const result = suggestStop(100, 0.8, "buy", 1.5);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_input");
  });

  it("rejects non-positive inputs", () => {
    expect(suggestStop(0, 0.02, "buy").ok).toBe(false);
    expect(suggestStop(100, 0, "buy").ok).toBe(false);
    expect(suggestStop(100, 0.02, "buy", 0).ok).toBe(false);
  });
});
