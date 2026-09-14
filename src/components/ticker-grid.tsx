"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { openTickerStream, type Ticker } from "@/lib/market/binance";

/**
 * SCAN — the live half.
 *
 * Initial rows are rendered on the server, so the grid is populated before any
 * JavaScript runs and the page is useful without a socket. The stream then
 * updates prices in place.
 *
 * Accessibility notes, because a live price grid is easy to get wrong:
 *
 *  - The status region exists in the DOM from first render. A live region
 *    mounted at the same moment as its text announces nothing — the change has
 *    to happen to an element the screen reader is already watching.
 *  - Price movement is conveyed by an arrow glyph and a signed number, not by
 *    colour alone. Colour is a redundant cue.
 *  - Individual tick updates are deliberately NOT announced. A live region on
 *    every price change would be unusable; the region reports connection state
 *    and how many instruments are loaded, which is the information a
 *    non-visual user actually needs.
 */

type Props = {
  initial: Ticker[];
  /** Called when the user selects a row, so the desk can score it. */
  onSelect?: (symbol: string) => void;
  selected?: string | null;
};

type Row = Ticker & { direction: "up" | "down" | "flat" };

type Status = "connecting" | "open" | "closed";

const STATUS_LABEL: Record<Status, string> = {
  connecting: "Connecting to live price stream",
  open: "Live",
  closed: "Disconnected — retrying",
};

export function TickerGrid({ initial, onSelect, selected }: Props) {
  const [rows, setRows] = useState<Row[]>(() =>
    initial.map((t) => ({ ...t, direction: "flat" })),
  );
  const [status, setStatus] = useState<Status>("connecting");

  // Previous prices live in a ref rather than state: they are needed to compute
  // the tick direction but must not themselves trigger a re-render.
  const previousPrice = useRef<Map<string, number>>(new Map());

  const symbols = useMemo(() => initial.map((t) => t.symbol), [initial]);

  useEffect(() => {
    if (symbols.length === 0) return;

    const handle = openTickerStream(symbols, {
      onTick: (tick) => {
        setRows((current) => {
          const index = current.findIndex((r) => r.symbol === tick.symbol);
          if (index === -1) return current;

          const previous = previousPrice.current.get(tick.symbol) ?? tick.price;
          previousPrice.current.set(tick.symbol, tick.price);

          const direction: Row["direction"] =
            tick.price > previous ? "up" : tick.price < previous ? "down" : "flat";

          const next = [...current];
          next[index] = {
            ...current[index]!,
            price: tick.price,
            changePercent24h: tick.changePercent24h,
            quoteVolume24h: tick.quoteVolume24h,
            direction,
          };
          return next;
        });
      },
      onStatus: setStatus,
    });

    // Closing on unmount suppresses the reconnect. Without this the socket
    // would keep reopening after the component is gone.
    return () => handle.close();
  }, [symbols]);

  return (
    <section aria-labelledby="scan-heading" className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="scan-heading" className="text-sm font-semibold tracking-wide text-ink-300 uppercase">
          1 · Scan
        </h2>
        {/*
          Rendered unconditionally so the live region pre-exists its updates.
          `aria-live="polite"` waits for a pause rather than interrupting.
        */}
        <p
          aria-live="polite"
          className="flex items-center gap-2 text-xs text-ink-500"
        >
          <span
            aria-hidden="true"
            className={`inline-block h-2 w-2 rounded-full ${
              status === "open"
                ? "bg-up"
                : status === "connecting"
                  ? "bg-warn"
                  : "bg-down"
            }`}
          />
          {STATUS_LABEL[status]} · {rows.length} instruments
        </p>
      </div>

      <div className="overflow-x-auto rounded-lg border border-desk-700">
        <table className="w-full min-w-[40rem] border-collapse text-sm">
          <caption className="sr-only">
            Top instruments by 24 hour quote volume, updating live. Select a row
            to score that instrument.
          </caption>
          <thead className="bg-desk-850 text-left text-xs uppercase tracking-wide text-ink-500">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">Symbol</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Price</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">24h</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Volume</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                <span className="sr-only">Action</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const isSelected = selected === row.symbol;
              const up = row.changePercent24h >= 0;
              return (
                <tr
                  key={row.symbol}
                  className={`border-t border-desk-800 ${
                    isSelected ? "bg-accent/10" : "hover:bg-desk-850"
                  }`}
                >
                  <th scope="row" className="px-3 py-2 text-left font-medium">
                    {row.symbol}
                  </th>
                  <td className="numeric px-3 py-2 text-right">
                    {/* Arrow + colour together; the arrow carries the meaning. */}
                    <span
                      aria-hidden="true"
                      className={
                        row.direction === "up"
                          ? "text-up"
                          : row.direction === "down"
                            ? "text-down"
                            : "text-ink-500"
                      }
                    >
                      {row.direction === "up" ? "▲" : row.direction === "down" ? "▼" : "·"}
                    </span>{" "}
                    {formatPrice(row.price)}
                  </td>
                  <td
                    className={`numeric px-3 py-2 text-right ${up ? "text-up" : "text-down"}`}
                  >
                    {/* The sign is in the text, so colour is redundant. */}
                    {up ? "+" : ""}
                    {row.changePercent24h.toFixed(2)}%
                  </td>
                  <td className="numeric px-3 py-2 text-right text-ink-300">
                    {formatCompact(row.quoteVolume24h)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {onSelect && (
                      <button
                        type="button"
                        onClick={() => onSelect(row.symbol)}
                        aria-pressed={isSelected}
                        className="rounded border border-desk-600 px-2 py-1 text-xs text-ink-300 hover:border-accent hover:text-ink-50"
                      >
                        {isSelected ? "Selected" : "Select"}
                        <span className="sr-only"> {row.symbol}</span>
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {rows.length === 0 && (
        <p className="rounded-lg border border-desk-700 bg-desk-850 px-3 py-6 text-center text-sm text-ink-500">
          No instruments returned. The exchange may be unreachable from here.
        </p>
      )}
    </section>
  );
}

function formatPrice(value: number): string {
  if (value >= 1000) return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (value >= 1) return value.toFixed(4);
  return value.toFixed(6);
}

function formatCompact(value: number): string {
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}
