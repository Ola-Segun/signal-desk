-- Signal Desk — the routing audit trail.
--
-- Run this once against your database. In Supabase: SQL Editor → New query →
-- paste → Run. Or use `npm run db:push` with DATABASE_URL set.
--
-- NOTE ON `simulated`: it is NOT NULL DEFAULT true and no application code
-- writes false. The guarantee lives in the schema so it survives a refactor.

CREATE TABLE IF NOT EXISTS "runs" (
  "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "created_at"       timestamp with time zone DEFAULT now() NOT NULL,

  "symbol"           text NOT NULL,
  "side"             text NOT NULL,

  -- score
  "composite_score"  double precision NOT NULL,
  "technical_score"  double precision NOT NULL,
  "llm_conviction"   integer,
  "llm_direction"    text,
  "llm_rationale"    text,
  "score_components" jsonb NOT NULL,

  -- size
  "quantity"         double precision NOT NULL,
  "notional"         double precision NOT NULL,
  "risk_amount"      double precision NOT NULL,
  "entry_price"      double precision NOT NULL,
  "stop_loss"        double precision NOT NULL,

  -- route
  "venue"            text NOT NULL,
  "venue_reason"     text NOT NULL,
  "effective_price"  double precision NOT NULL,
  "slippage_bps"     double precision NOT NULL,
  "fee_bps"          double precision NOT NULL,

  "simulated"        boolean DEFAULT true NOT NULL,

  CONSTRAINT "runs_side_check"      CHECK ("side" IN ('buy', 'sell')),
  CONSTRAINT "runs_direction_check" CHECK ("llm_direction" IS NULL OR "llm_direction" IN ('long', 'short', 'flat')),
  -- Belt and braces: the database itself refuses to record a non-simulated run.
  CONSTRAINT "runs_simulated_check" CHECK ("simulated" = true)
);

CREATE INDEX IF NOT EXISTS "runs_created_at_idx" ON "runs" ("created_at");
CREATE INDEX IF NOT EXISTS "runs_symbol_idx"     ON "runs" ("symbol");

-- Supabase exposes tables through PostgREST by default. This app connects
-- directly over Postgres and does not use the REST API, so enabling row level
-- security without a policy closes that surface rather than leaving the audit
-- trail world-readable through the anon key.
ALTER TABLE "runs" ENABLE ROW LEVEL SECURITY;
