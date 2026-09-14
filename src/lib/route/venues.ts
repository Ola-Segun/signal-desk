/**
 * Venue configuration for the routing simulation.
 *
 * These are fictional venues with plausible parameters. They are not
 * connections to real exchanges and no credential exists for any of them.
 */

export type Venue = {
  id: string;
  name: string;
  /** Taker fee in basis points (1 bp = 0.01%). */
  feeBps: number;
  /**
   * Displayed price as an offset from the reference price, in basis points.
   * Positive means this venue quotes above the reference.
   */
  spreadBps: number;
  /**
   * Notional depth in quote currency before material impact. Larger depth
   * absorbs a given order size with less slippage.
   */
  depth: number;
};

export const VENUES: readonly Venue[] = [
  { id: "alpha", name: "Alpha Exchange", feeBps: 10, spreadBps: -2, depth: 2_000_000 },
  { id: "beta", name: "Beta Markets", feeBps: 4, spreadBps: 6, depth: 5_000_000 },
  { id: "gamma", name: "Gamma Liquidity", feeBps: 7, spreadBps: 1, depth: 800_000 },
  { id: "delta", name: "Delta OTC", feeBps: 2, spreadBps: 12, depth: 12_000_000 },
] as const;
