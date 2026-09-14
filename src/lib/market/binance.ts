import { z } from "zod";

import { appError, err, ok, type AppError, type Result } from "@/lib/result";

/**
 * SCAN — live market data from Binance's public endpoints.
 *
 * No API key is required for any of this; these are the public market-data
 * routes. Every response is parsed with Zod before it is used, because an
 * upstream that changes shape should produce one clear error here rather than
 * `undefined` surfacing three layers away.
 */

const REST_BASE = "https://api.binance.com";
export const WS_BASE = "wss://stream.binance.com:9443/stream";

// --- 24h ticker -----------------------------------------------------------

/** Binance returns every numeric field as a string. */
const numericString = z
  .string()
  .refine((s) => s.trim() !== "" && Number.isFinite(Number(s)), {
    message: "expected a numeric string",
  })
  .transform(Number);

const tickerSchema = z.object({
  symbol: z.string(),
  lastPrice: numericString,
  priceChangePercent: numericString,
  quoteVolume: numericString,
  highPrice: numericString,
  lowPrice: numericString,
});

const tickerArraySchema = z.array(tickerSchema);

export type Ticker = {
  symbol: string;
  price: number;
  changePercent24h: number;
  quoteVolume24h: number;
  high24h: number;
  low24h: number;
};

export type ScanOptions = {
  /** How many symbols to return, ranked by 24h quote volume. */
  limit?: number;
  /** Quote asset to filter on. */
  quoteAsset?: string;
};

/**
 * Leveraged tokens and similar derivatives quote in USDT but do not behave like
 * the spot pair, so they are excluded from the universe rather than silently
 * scored as if they were one.
 */
const EXCLUDED_SUFFIXES = ["UPUSDT", "DOWNUSDT", "BULLUSDT", "BEARUSDT"];

/**
 * The full 24h ticker response is ~2.5 MB, which is over Next's 2 MB data-cache
 * limit — `cache: "force-cache"` on it silently fails to store, so every
 * request would reach Binance and the revalidation window would do nothing.
 *
 * Caching the *derived* universe instead sidesteps that: the parsed result is a
 * few kilobytes, and one upstream call per TTL per server instance is what the
 * fetch cache was supposed to buy in the first place.
 *
 * In-process, so it does not survive a restart and is not shared across
 * instances. That is the right trade here — it exists to be polite to a public
 * endpoint, not to be a distributed cache.
 */
const UNIVERSE_TTL_MS = 15_000;

let universeCache: { tickers: Ticker[]; expiresAt: number } | undefined;

/** Exposed so tests can assert on cold-path behaviour deterministically. */
export function clearUniverseCache(): void {
  universeCache = undefined;
}

export async function fetchUniverse(
  options: ScanOptions = {},
  fetchImpl: typeof fetch = fetch,
): Promise<Result<Ticker[], AppError>> {
  const limit = options.limit ?? 12;
  const quoteAsset = options.quoteAsset ?? "USDT";

  // The cache holds the full parsed list; filtering and slicing stay per-call
  // so different limits do not each need their own upstream request.
  const cached =
    universeCache && universeCache.expiresAt > Date.now()
      ? universeCache.tickers
      : undefined;

  let all: Ticker[];

  if (cached) {
    all = cached;
  } else {
    let payload: unknown;
    try {
      const response = await fetchImpl(`${REST_BASE}/api/v3/ticker/24hr`, {
        // Deliberately uncached at the fetch layer — see the note above.
        cache: "no-store",
      });
      if (!response.ok) {
        return err(
          appError(
            "upstream_unavailable",
            "The exchange rejected the market-data request.",
            `HTTP ${response.status}`,
          ),
        );
      }
      payload = await response.json();
    } catch (cause) {
      return err(
        appError(
          "upstream_unavailable",
          "Could not reach the exchange for market data.",
          cause instanceof Error ? cause.message : String(cause),
        ),
      );
    }

    const parsed = tickerArraySchema.safeParse(payload);
    if (!parsed.success) {
      return err(
        appError(
          "upstream_malformed",
          "The exchange returned market data in an unexpected shape.",
          parsed.error.issues[0]?.message,
        ),
      );
    }

    all = parsed.data.map(
      (t): Ticker => ({
        symbol: t.symbol,
        price: t.lastPrice,
        changePercent24h: t.priceChangePercent,
        quoteVolume24h: t.quoteVolume,
        high24h: t.highPrice,
        low24h: t.lowPrice,
      }),
    );

    universeCache = { tickers: all, expiresAt: Date.now() + UNIVERSE_TTL_MS };
  }

  const universe = all
    .filter((t) => t.symbol.endsWith(quoteAsset))
    .filter((t) => !EXCLUDED_SUFFIXES.some((suffix) => t.symbol.endsWith(suffix)))
    .filter((t) => t.quoteVolume24h > 0 && t.price > 0)
    // `filter` has already produced a new array, so sorting here does not touch
    // the cached one — but the ordering of these calls is load-bearing. Sorting
    // `all` directly would reorder the cache in place for every later caller.
    .sort((a, b) => b.quoteVolume24h - a.quoteVolume24h)
    .slice(0, limit);

  return ok(universe);
}

// --- Klines (candles) -----------------------------------------------------

/**
 * A kline is a positional array. Only the fields used downstream are named;
 * the rest are tolerated so a future upstream addition does not break parsing.
 */
const klineSchema = z
  .tuple([
    z.number(), // open time
    numericString, // open
    numericString, // high
    numericString, // low
    numericString, // close
    numericString, // base volume
  ])
  .rest(z.unknown());

const klineArraySchema = z.array(klineSchema);

export type Candle = {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type Interval = "1h" | "4h" | "1d";

export async function fetchCandles(
  symbol: string,
  interval: Interval = "1h",
  limit = 168,
  fetchImpl: typeof fetch = fetch,
): Promise<Result<Candle[], AppError>> {
  if (!/^[A-Z0-9]{4,20}$/.test(symbol)) {
    return err(appError("invalid_input", `"${symbol}" is not a valid symbol.`));
  }

  const url = new URL(`${REST_BASE}/api/v3/klines`);
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("interval", interval);
  url.searchParams.set("limit", String(Math.min(Math.max(limit, 2), 1000)));

  let payload: unknown;
  try {
    const response = await fetchImpl(url, {
      cache: "force-cache",
      next: { revalidate: 30 },
    });
    if (!response.ok) {
      // Binance answers an unknown symbol with a 400. That is a bad request,
      // not an outage — mapping it to `upstream_unavailable` would return a
      // 502 and tell the caller to retry something that can never succeed.
      if (response.status === 400) {
        return err(
          appError(
            "not_found",
            `${symbol} is not a symbol this exchange trades.`,
          ),
        );
      }
      return err(
        appError(
          "upstream_unavailable",
          `The exchange rejected the candle request for ${symbol}.`,
          `HTTP ${response.status}`,
        ),
      );
    }
    payload = await response.json();
  } catch (cause) {
    return err(
      appError(
        "upstream_unavailable",
        `Could not reach the exchange for ${symbol} candles.`,
        cause instanceof Error ? cause.message : String(cause),
      ),
    );
  }

  const parsed = klineArraySchema.safeParse(payload);
  if (!parsed.success) {
    return err(
      appError(
        "upstream_malformed",
        "The exchange returned candles in an unexpected shape.",
        parsed.error.issues[0]?.message,
      ),
    );
  }

  return ok(
    parsed.data.map(
      ([openTime, open, high, low, close, volume]): Candle => ({
        openTime,
        open,
        high,
        low,
        close,
        volume,
      }),
    ),
  );
}

// --- Live stream ----------------------------------------------------------

const streamMessageSchema = z.object({
  stream: z.string(),
  data: z.object({
    s: z.string(), // symbol
    c: numericString, // last price
    P: numericString, // 24h change percent
    q: numericString, // 24h quote volume
    E: z.number(), // event time (ms)
  }),
});

export type Tick = {
  symbol: string;
  price: number;
  changePercent24h: number;
  quoteVolume24h: number;
  eventTime: number;
};

export type StreamHandle = { close: () => void };

export type StreamCallbacks = {
  onTick: (tick: Tick) => void;
  onStatus?: (status: "connecting" | "open" | "closed") => void;
};

const MAX_BACKOFF_MS = 30_000;
const BASE_BACKOFF_MS = 1_000;

/**
 * Subscribe to combined `@ticker` streams.
 *
 * Three things this handles that a naive implementation does not:
 *
 *  1. **Reconnect with exponential backoff and jitter.** A dropped socket
 *     reconnects rather than silently leaving a dead UI showing stale prices.
 *     Jitter avoids every client in a tab group reconnecting in lockstep.
 *  2. **A stale-tick guard.** Messages can arrive out of order after a
 *     reconnect. A tick whose event time is older than the newest already seen
 *     for that symbol is dropped, so a slower in-flight message can never
 *     overwrite a newer price.
 *  3. **Deliberate teardown.** `close()` suppresses the reconnect, so an
 *     unmounting component does not leave a socket reopening forever.
 */
export function openTickerStream(
  symbols: string[],
  callbacks: StreamCallbacks,
): StreamHandle {
  const streams = symbols
    .map((s) => `${s.toLowerCase()}@ticker`)
    .join("/");

  let socket: WebSocket | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  let closedByCaller = false;

  /** Newest event time seen per symbol — the stale-tick guard. */
  const latestEventTime = new Map<string, number>();

  function connect(): void {
    if (closedByCaller || symbols.length === 0) return;
    callbacks.onStatus?.("connecting");

    socket = new WebSocket(`${WS_BASE}?streams=${streams}`);

    socket.onopen = () => {
      attempt = 0;
      callbacks.onStatus?.("open");
    };

    socket.onmessage = (event: MessageEvent<string>) => {
      let raw: unknown;
      try {
        raw = JSON.parse(event.data);
      } catch {
        return; // A malformed frame is not worth tearing the stream down for.
      }

      const parsed = streamMessageSchema.safeParse(raw);
      if (!parsed.success) return;

      const { s: symbol, c, P, q, E } = parsed.data.data;

      const seen = latestEventTime.get(symbol);
      if (seen !== undefined && E <= seen) return; // stale — drop it
      latestEventTime.set(symbol, E);

      callbacks.onTick({
        symbol,
        price: c,
        changePercent24h: P,
        quoteVolume24h: q,
        eventTime: E,
      });
    };

    socket.onclose = () => {
      callbacks.onStatus?.("closed");
      if (closedByCaller) return;
      const backoff = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
      const jittered = backoff * (0.5 + Math.random() * 0.5);
      attempt += 1;
      reconnectTimer = setTimeout(connect, jittered);
    };

    socket.onerror = () => {
      // `onclose` always follows, so reconnection is handled in one place.
      socket?.close();
    };
  }

  connect();

  return {
    close() {
      closedByCaller = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.close();
    },
  };
}
