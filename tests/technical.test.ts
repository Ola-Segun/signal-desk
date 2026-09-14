import { describe, expect, it } from "vitest";

import { unwrap } from "@/lib/result";
import {
  PARTICIPATION_CEILING,
  TECHNICAL_WEIGHTS,
  VOLATILITY_CEILING,
  realisedVolatility,
  rsi,
  scoreTechnicals,
  volumeRatio,
} from "@/lib/score/technical";
import type { Candle } from "@/lib/market/binance";

describe("rsi", () => {
  it("returns 100 when every change is a gain", () => {
    // avgLoss is 0, so RS is undefined and RSI is 100 by convention.
    const closes = Array.from({ length: 20 }, (_, i) => 100 + i);
    expect(unwrap(rsi(closes, 14))).toBe(100);
  });

  it("returns 0 when every change is a loss", () => {
    // avgGain is 0, so RS = 0 and RSI = 100 - 100/(1+0) = 0.
    const closes = Array.from({ length: 20 }, (_, i) => 120 - i);
    expect(unwrap(rsi(closes, 14))).toBe(0);
  });

  it("returns 0 for a perfectly flat series", () => {
    // Both averages are 0. A flat series has no momentum in either direction,
    // so 0 is reported rather than the 100 that the avgLoss === 0 branch would
    // otherwise give.
    const closes = Array.from({ length: 20 }, () => 100);
    expect(unwrap(rsi(closes, 14))).toBe(0);
  });

  it("matches a hand-computed Wilder smoothing", () => {
    // closes  = [10, 11, 10, 11], period = 2
    // changes = [+1, -1, +1]
    //
    // seed (first 2 changes):
    //   avgGain = (1 + 0) / 2 = 0.5
    //   avgLoss = (0 + 1) / 2 = 0.5
    //
    // smooth in the third change (+1):
    //   avgGain = (0.5 * 1 + 1) / 2 = 0.75
    //   avgLoss = (0.5 * 1 + 0) / 2 = 0.25
    //
    //   RS  = 0.75 / 0.25 = 3
    //   RSI = 100 - 100 / (1 + 3) = 100 - 25 = 75
    expect(unwrap(rsi([10, 11, 10, 11], 2))).toBe(75);
  });

  it("rejects too few closes for the period", () => {
    // RSI(14) needs 15 closes; 14 is one short.
    const result = rsi(Array.from({ length: 14 }, (_, i) => i + 1), 14);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_input");
  });

  it("rejects an invalid period", () => {
    const closes = Array.from({ length: 20 }, (_, i) => 100 + i);
    expect(rsi(closes, 1).ok).toBe(false);
    expect(rsi(closes, 2.5).ok).toBe(false);
  });

  it("rejects non-finite closes", () => {
    const closes = Array.from({ length: 20 }, (_, i) => 100 + i);
    closes[5] = Number.NaN;
    expect(rsi(closes, 14).ok).toBe(false);
  });
});

describe("realisedVolatility", () => {
  it("is zero when every log return is identical", () => {
    // 100 -> 110 -> 121 is +10% twice, so both log returns are ln(1.1) and the
    // sample standard deviation is exactly 0.
    expect(unwrap(realisedVolatility([100, 110, 121], 1))).toBe(0);
  });

  it("matches a hand-computed standard deviation", () => {
    // Construct closes whose log returns are exactly [+0.1, -0.1]:
    //   c0 = 100, c1 = 100 * e^0.1, c2 = c1 * e^-0.1 = 100
    //
    //   mean     = (0.1 + -0.1) / 2 = 0
    //   variance = ((0.1)^2 + (-0.1)^2) / (2 - 1) = 0.02   [sample, n-1]
    //   sigma    = sqrt(0.02) = 0.141421356...
    //   vol      = sigma * sqrt(1) = 0.141421356...
    const closes = [100, 100 * Math.E ** 0.1, 100];
    expect(unwrap(realisedVolatility(closes, 1))).toBeCloseTo(
      Math.sqrt(0.02),
      7,
    );
  });

  it("scales by the square root of periods per day", () => {
    // Same series at periodsPerDay = 4 must be exactly 2x the value at 1,
    // because sqrt(4) / sqrt(1) = 2.
    const closes = [100, 100 * Math.E ** 0.1, 100];
    const daily1 = unwrap(realisedVolatility(closes, 1));
    const daily4 = unwrap(realisedVolatility(closes, 4));
    expect(daily4).toBeCloseTo(daily1 * 2, 7);
  });

  it("rejects fewer than three closes", () => {
    expect(realisedVolatility([100, 110], 24).ok).toBe(false);
  });

  it("rejects non-positive closes", () => {
    // A zero or negative close makes the log return undefined.
    expect(realisedVolatility([100, 0, 110], 24).ok).toBe(false);
    expect(realisedVolatility([100, -5, 110], 24).ok).toBe(false);
  });

  it("rejects a non-positive periodsPerDay", () => {
    expect(realisedVolatility([100, 110, 121], 0).ok).toBe(false);
  });
});

describe("volumeRatio", () => {
  it("excludes the latest candle from its own baseline", () => {
    // 24 baseline candles of 100, then a latest of 200.
    //   baseline mean = 100          (the 200 is NOT included)
    //   ratio         = 200 / 100 = 2
    //
    // Had the latest been included in its own baseline the mean would be
    // (24*100 + 200) / 25 = 104 and the ratio 1.923..., so asserting exactly 2
    // is what proves the exclusion.
    const volumes = [...Array.from({ length: 24 }, () => 100), 200];
    expect(unwrap(volumeRatio(volumes, 24))).toBe(2);
  });

  it("returns 1 when the latest matches the baseline", () => {
    const volumes = Array.from({ length: 25 }, () => 100);
    expect(unwrap(volumeRatio(volumes, 24))).toBe(1);
  });

  it("rejects too few candles", () => {
    const volumes = Array.from({ length: 24 }, () => 100);
    expect(volumeRatio(volumes, 24).ok).toBe(false);
  });

  it("rejects a zero baseline", () => {
    // Dividing by a zero mean is undefined, and reporting Infinity as a
    // "ratio" downstream would be worse than an error.
    const volumes = [...Array.from({ length: 24 }, () => 0), 50];
    const result = volumeRatio(volumes, 24);
    expect(result.ok).toBe(false);
  });

  it("rejects negative volumes", () => {
    const volumes = [...Array.from({ length: 24 }, () => 100), -5];
    expect(volumeRatio(volumes, 24).ok).toBe(false);
  });
});

/** Build candles with given closes and volumes; OHLC is not used by the score. */
function candles(closes: number[], volumes: number[]): Candle[] {
  return closes.map((close, i) => ({
    openTime: i * 3_600_000,
    open: close,
    high: close,
    low: close,
    close,
    volume: volumes[i] ?? 100,
  }));
}

describe("scoreTechnicals", () => {
  const rising = candles(
    Array.from({ length: 40 }, (_, i) => 100 + i),
    Array.from({ length: 40 }, () => 100),
  );

  it("maps a strictly rising series to full momentum", () => {
    // Every change is a gain, so RSI is 100 and momentum is 100.
    const result = unwrap(scoreTechnicals(rising, 24));
    expect(result.rsi).toBe(100);
    expect(result.components.momentum).toBe(100);
  });

  it("scores flat volume at one third of participation", () => {
    // Constant volume gives a ratio of exactly 1, and participation is
    // 100 * min(1, 3) / 3 = 33.333...
    const result = unwrap(scoreTechnicals(rising, 24));
    expect(result.volumeRatio).toBe(1);
    expect(result.components.participation).toBeCloseTo(100 / 3, 6);
  });

  it("combines components with the documented weights", () => {
    // The individual formulas are verified above against hand-computed values;
    // this asserts the weighted sum that combines them.
    const result = unwrap(scoreTechnicals(rising, 24));
    const expected =
      result.components.momentum * TECHNICAL_WEIGHTS.momentum +
      result.components.volatility * TECHNICAL_WEIGHTS.volatility +
      result.components.participation * TECHNICAL_WEIGHTS.participation;

    expect(result.score).toBeCloseTo(expected, 6);
  });

  it("keeps every component within 0 and 100", () => {
    const result = unwrap(scoreTechnicals(rising, 24));
    for (const value of Object.values(result.components)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(100);
    }
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
  });

  it("caps participation at the ceiling rather than scaling without bound", () => {
    // A 50x volume spike must not score 50x a 3x spike.
    const spiked = candles(
      Array.from({ length: 40 }, (_, i) => 100 + i),
      [...Array.from({ length: 39 }, () => 100), 5000],
    );
    const result = unwrap(scoreTechnicals(spiked, 24));
    expect(result.volumeRatio).toBe(50);
    expect(result.components.participation).toBe(100);
    expect(PARTICIPATION_CEILING).toBe(3);
  });

  it("scores zero on volatility at or above the ceiling", () => {
    expect(VOLATILITY_CEILING).toBe(0.12);
    // Alternating +/-20% moves produce daily volatility far above the ceiling.
    const choppy = candles(
      Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? 100 : 120)),
      Array.from({ length: 40 }, () => 100),
    );
    const result = unwrap(scoreTechnicals(choppy, 24));
    expect(result.volatility).toBeGreaterThan(VOLATILITY_CEILING);
    expect(result.components.volatility).toBe(0);
  });

  it("propagates the failure when there are too few candles", () => {
    const result = scoreTechnicals(candles([100, 101, 102], [1, 1, 1]), 24);
    expect(result.ok).toBe(false);
  });
});
