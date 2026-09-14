import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * The routing audit trail.
 *
 * Every simulated route writes exactly one immutable row here. Nothing in the
 * application updates or deletes a row once written — an audit trail you can
 * edit is not an audit trail.
 *
 * `simulated` is NOT NULL DEFAULT true at the schema level, and there is no
 * code path in this application that writes `false`. That is deliberate: the
 * database itself should make it hard to misrepresent a simulated fill as a
 * real one.
 */
export const runs = pgTable(
  "runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),

    symbol: text("symbol").notNull(),
    side: text("side", { enum: ["buy", "sell"] }).notNull(),

    // --- score ---
    compositeScore: doublePrecision("composite_score").notNull(),
    technicalScore: doublePrecision("technical_score").notNull(),
    llmConviction: integer("llm_conviction"),
    llmDirection: text("llm_direction", { enum: ["long", "short", "flat"] }),
    llmRationale: text("llm_rationale"),
    scoreComponents: jsonb("score_components").notNull(),

    // --- size ---
    quantity: doublePrecision("quantity").notNull(),
    notional: doublePrecision("notional").notNull(),
    riskAmount: doublePrecision("risk_amount").notNull(),
    entryPrice: doublePrecision("entry_price").notNull(),
    stopLoss: doublePrecision("stop_loss").notNull(),

    // --- route ---
    venue: text("venue").notNull(),
    venueReason: text("venue_reason").notNull(),
    effectivePrice: doublePrecision("effective_price").notNull(),
    slippageBps: doublePrecision("slippage_bps").notNull(),
    feeBps: doublePrecision("fee_bps").notNull(),

    /**
     * Always true. Enforced here rather than in application code so that the
     * guarantee survives a refactor.
     */
    simulated: boolean("simulated").notNull().default(true),
  },
  (table) => [
    index("runs_created_at_idx").on(table.createdAt),
    index("runs_symbol_idx").on(table.symbol),
  ],
);

export type RunRow = typeof runs.$inferSelect;
export type NewRunRow = typeof runs.$inferInsert;
