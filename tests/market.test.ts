import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearUniverseCache,
  fetchCandles,
  fetchUniverse,
} from "@/lib/market/binance";
import { unwrap } from "@/lib/result";
import {
  routeInputSchema,
  scoreInputSchema,
  sizeInputSchema,
  symbolSchema,
} from "@/lib/services/pipeline";

/**
 * Upstream parsing and boundary validation.
 *
 * `fetchUniverse` and `fetchCandles` take an injectable `fetch`, so the parsing
 * and filtering logic is tested without touching the network — these assertions
 * are about how the code behaves when the exchange returns something
 * unexpected, which is exactly the case you cannot reproduce on demand against
 * the live endpoint.
 */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function ticker(overrides: Record<string, string>) {
  return {
    symbol: "BTCUSDT",
    lastPrice: "50000",
    priceChangePercent: "1.5",
    quoteVolume: "1000000",
    highPrice: "51000",
    lowPrice: "49000",
    ...overrides,
  };
}

describe("fetchUniverse", () => {
  // The derived universe is memoised in-process for 15s. Without clearing it
  // between cases, the second test would silently assert against the first
  // test's data and pass for the wrong reason.
  beforeEach(() => clearUniverseCache());

  it("parses numeric strings into numbers", () => {
    // Binance returns every numeric field as a string; downstream arithmetic
    // would silently concatenate rather than add if this were not converted.
    const fetchImpl = vi.fn(async () => jsonResponse([ticker({})]));
    const result = fetchUniverse({}, fetchImpl as unknown as typeof fetch);

    return result.then((r) => {
      const universe = unwrap(r);
      expect(universe[0]!.price).toBe(50_000);
      expect(typeof universe[0]!.price).toBe("number");
      expect(universe[0]!.changePercent24h).toBe(1.5);
    });
  });

  it("ranks by quote volume and applies the limit", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse([
        ticker({ symbol: "AAAUSDT", quoteVolume: "100" }),
        ticker({ symbol: "BBBUSDT", quoteVolume: "300" }),
        ticker({ symbol: "CCCUSDT", quoteVolume: "200" }),
      ]),
    );

    const universe = unwrap(
      await fetchUniverse({ limit: 2 }, fetchImpl as unknown as typeof fetch),
    );

    expect(universe.map((t) => t.symbol)).toEqual(["BBBUSDT", "CCCUSDT"]);
  });

  it("filters to the requested quote asset", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse([
        ticker({ symbol: "BTCUSDT" }),
        ticker({ symbol: "BTCEUR" }),
      ]),
    );

    const universe = unwrap(
      await fetchUniverse({}, fetchImpl as unknown as typeof fetch),
    );
    expect(universe.map((t) => t.symbol)).toEqual(["BTCUSDT"]);
  });

  it("excludes leveraged tokens", async () => {
    // These quote in USDT but do not track the spot pair, so scoring them as
    // if they did would be wrong rather than merely noisy.
    const fetchImpl = vi.fn(async () =>
      jsonResponse([
        ticker({ symbol: "BTCUPUSDT", quoteVolume: "9999999" }),
        ticker({ symbol: "BTCDOWNUSDT", quoteVolume: "9999998" }),
        ticker({ symbol: "ETHBULLUSDT", quoteVolume: "9999997" }),
        ticker({ symbol: "ETHBEARUSDT", quoteVolume: "9999996" }),
        ticker({ symbol: "BTCUSDT", quoteVolume: "1" }),
      ]),
    );

    const universe = unwrap(
      await fetchUniverse({}, fetchImpl as unknown as typeof fetch),
    );
    expect(universe.map((t) => t.symbol)).toEqual(["BTCUSDT"]);
  });

  it("drops rows with zero price or volume", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse([
        ticker({ symbol: "DEADUSDT", quoteVolume: "0" }),
        ticker({ symbol: "ZEROUSDT", lastPrice: "0" }),
        ticker({ symbol: "GOODUSDT" }),
      ]),
    );

    const universe = unwrap(
      await fetchUniverse({}, fetchImpl as unknown as typeof fetch),
    );
    expect(universe.map((t) => t.symbol)).toEqual(["GOODUSDT"]);
  });

  it("reports a non-OK response as upstream_unavailable", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ msg: "nope" }, 429));
    const result = await fetchUniverse({}, fetchImpl as unknown as typeof fetch);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("upstream_unavailable");
      expect(result.error.detail).toContain("429");
    }
  });

  it("reports a changed upstream shape as upstream_malformed", async () => {
    // A silently changed contract should produce one clear error here rather
    // than `undefined` surfacing three layers away.
    const fetchImpl = vi.fn(async () =>
      jsonResponse([{ symbol: "BTCUSDT", lastPrice: "not-a-number" }]),
    );
    const result = await fetchUniverse({}, fetchImpl as unknown as typeof fetch);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("upstream_malformed");
  });

  it("reports a network failure without throwing", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const result = await fetchUniverse({}, fetchImpl as unknown as typeof fetch);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("upstream_unavailable");
  });

  it("serves a second call from the in-process cache", async () => {
    // The upstream payload is ~2.5MB and cannot use Next's data cache, so this
    // memo is the only thing standing between a page view and a request to
    // Binance. If it regresses, the app quietly starts hammering a public
    // endpoint — which is invisible until rate limiting starts.
    const fetchImpl = vi.fn(async () =>
      jsonResponse([ticker({ symbol: "BTCUSDT" })]),
    );

    await fetchUniverse({}, fetchImpl as unknown as typeof fetch);
    await fetchUniverse({}, fetchImpl as unknown as typeof fetch);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("applies a different limit to cached data without refetching", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse([
        ticker({ symbol: "AAAUSDT", quoteVolume: "300" }),
        ticker({ symbol: "BBBUSDT", quoteVolume: "200" }),
        ticker({ symbol: "CCCUSDT", quoteVolume: "100" }),
      ]),
    );

    const first = unwrap(
      await fetchUniverse({ limit: 1 }, fetchImpl as unknown as typeof fetch),
    );
    const second = unwrap(
      await fetchUniverse({ limit: 3 }, fetchImpl as unknown as typeof fetch),
    );

    expect(first.map((t) => t.symbol)).toEqual(["AAAUSDT"]);
    expect(second.map((t) => t.symbol)).toEqual([
      "AAAUSDT",
      "BBBUSDT",
      "CCCUSDT",
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not let sorting reorder the cached list", async () => {
    // `Array.prototype.sort` mutates. Sorting the cached array directly rather
    // than the filtered copy would reorder it for every subsequent caller —
    // a bug that only shows up on the second call, with no error.
    const fetchImpl = vi.fn(async () =>
      jsonResponse([
        ticker({ symbol: "LOWUSDT", quoteVolume: "1" }),
        ticker({ symbol: "HIGHUSDT", quoteVolume: "999" }),
      ]),
    );

    const first = unwrap(
      await fetchUniverse({}, fetchImpl as unknown as typeof fetch),
    );
    const second = unwrap(
      await fetchUniverse({}, fetchImpl as unknown as typeof fetch),
    );

    expect(first.map((t) => t.symbol)).toEqual(["HIGHUSDT", "LOWUSDT"]);
    expect(second.map((t) => t.symbol)).toEqual(first.map((t) => t.symbol));
  });
});

describe("fetchCandles", () => {
  const kline = [
    1_700_000_000_000,
    "100.0",
    "110.0",
    "90.0",
    "105.0",
    "1234.5",
    "ignored",
    "extra",
  ];

  it("maps the positional kline array onto named fields", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([kline]));
    const candles = unwrap(
      await fetchCandles("BTCUSDT", "1h", 10, fetchImpl as unknown as typeof fetch),
    );

    expect(candles[0]).toEqual({
      openTime: 1_700_000_000_000,
      open: 100,
      high: 110,
      low: 90,
      close: 105,
      volume: 1234.5,
    });
  });

  it("tolerates extra trailing fields from the exchange", async () => {
    // Binance appends fields over time; rejecting on length would break the
    // app for an additive upstream change.
    const fetchImpl = vi.fn(async () =>
      jsonResponse([[...kline, "another", "and-another"]]),
    );
    const result = await fetchCandles(
      "BTCUSDT",
      "1h",
      10,
      fetchImpl as unknown as typeof fetch,
    );
    expect(result.ok).toBe(true);
  });

  it("maps an upstream 400 to not_found rather than an outage", async () => {
    // Binance answers an unknown symbol with a 400. Reporting that as
    // `upstream_unavailable` would surface a 502 and invite the caller to
    // retry something that can never succeed.
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ code: -1121, msg: "Invalid symbol." }, 400),
    );
    const result = await fetchCandles(
      "NOTREALUSDT",
      "1h",
      10,
      fetchImpl as unknown as typeof fetch,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });

  it("still reports a 500 from the exchange as an outage", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ msg: "boom" }, 500));
    const result = await fetchCandles(
      "BTCUSDT",
      "1h",
      10,
      fetchImpl as unknown as typeof fetch,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("upstream_unavailable");
  });

  it("rejects a malformed symbol before making a request", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([]));
    const result = await fetchCandles(
      "btc-usdt!",
      "1h",
      10,
      fetchImpl as unknown as typeof fetch,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_input");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("service input schemas", () => {
  it("upper-cases and trims symbols", () => {
    expect(symbolSchema.parse("  btcusdt ")).toBe("BTCUSDT");
  });

  it("rejects symbols that could not be a trading pair", () => {
    expect(symbolSchema.safeParse("BTC-USDT").success).toBe(false);
    expect(symbolSchema.safeParse("ab").success).toBe(false);
    expect(symbolSchema.safeParse("").success).toBe(false);
  });

  it("applies documented defaults on the route input", () => {
    const parsed = routeInputSchema.parse({ symbol: "BTCUSDT" });
    expect(parsed.accountEquity).toBe(10_000);
    expect(parsed.riskPct).toBe(1);
  });

  it("rejects out-of-range risk on the route input", () => {
    expect(
      routeInputSchema.safeParse({ symbol: "BTCUSDT", riskPct: 0 }).success,
    ).toBe(false);
    expect(
      routeInputSchema.safeParse({ symbol: "BTCUSDT", riskPct: 101 }).success,
    ).toBe(false);
  });

  it("requires the fields the sizer needs", () => {
    expect(sizeInputSchema.safeParse({ accountEquity: 10_000 }).success).toBe(
      false,
    );
    expect(
      sizeInputSchema.safeParse({
        accountEquity: 10_000,
        riskPct: 1,
        entry: 100,
        stopLoss: 95,
        volatility: 0.02,
      }).success,
    ).toBe(true);
  });

  it("treats skipLlm as optional on the score input", () => {
    expect(scoreInputSchema.parse({ symbol: "BTCUSDT" }).skipLlm).toBeUndefined();
    expect(
      scoreInputSchema.parse({ symbol: "BTCUSDT", skipLlm: true }).skipLlm,
    ).toBe(true);
  });
});
