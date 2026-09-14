import "server-only";

import { desc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { databaseUrl } from "@/lib/env";
import { appError, err, ok, type AppError, type Result } from "@/lib/result";
import { runs, type NewRunRow, type RunRow } from "./schema";

/**
 * Persistence for the routing audit trail.
 *
 * Two implementations behind one interface:
 *
 *   - Postgres, when DATABASE_URL is set. This is the real one.
 *   - An in-memory store otherwise.
 *
 * The fallback exists so that `git clone && npm install && npm run dev`
 * produces a working application with no configuration. A reviewer should not
 * have to provision a database to see whether the thing works. The trade-off is
 * explicit and surfaced in the UI: when the in-memory store is active, the app
 * says so, because silently pretending to persist would be worse than not
 * persisting.
 */

export type RunStore = {
  readonly kind: "postgres" | "memory";
  insert(row: NewRunRow): Promise<Result<RunRow, AppError>>;
  list(limit: number, offset: number): Promise<Result<RunRow[], AppError>>;
  byId(id: string): Promise<Result<RunRow, AppError>>;
  count(): Promise<Result<number, AppError>>;
};

// --- Postgres -------------------------------------------------------------

type PostgresDb = ReturnType<typeof drizzle<{ runs: typeof runs }>>;

let cached: { client: postgres.Sql; db: PostgresDb } | undefined;

/**
 * Supabase (and most managed Postgres) put PgBouncer in front of the database.
 * In transaction pooling mode a connection is handed to a different session
 * between statements, so server-side prepared statements — which postgres.js
 * uses by default — break with "prepared statement s1 already exists".
 *
 * Detected from the URL rather than configured separately, so pasting the
 * pooler string from the Supabase dashboard just works.
 */
function usesTransactionPooler(url: string): boolean {
  return (
    url.includes("pooler.supabase.com") ||
    url.includes(":6543") ||
    url.includes("pgbouncer=true")
  );
}

function connection(url: string): { client: postgres.Sql; db: PostgresDb } {
  // Cached across hot reloads in dev, where the module graph is re-evaluated
  // on every edit and an uncached client would leak a connection each time.
  if (cached) return cached;

  const pooled = usesTransactionPooler(url);
  const client = postgres(url, {
    // A serverless function should hold very few connections; the pooler is
    // what multiplexes them.
    max: pooled ? 1 : 5,
    idle_timeout: 20,
    connect_timeout: 15,
    prepare: !pooled,
  });

  cached = { client, db: drizzle(client, { schema: { runs } }) };
  return cached;
}

function persistenceError(operation: string, cause: unknown): AppError {
  // The cause may embed the connection string. Never forward it.
  const message = cause instanceof Error ? cause.message : String(cause);
  const safe = message.replace(/postgres(ql)?:\/\/[^\s]*/gi, "[redacted]");
  return appError("persistence_failed", `Could not ${operation}.`, safe);
}

function postgresStore(url: string): RunStore {
  const { db } = connection(url);
  return {
    kind: "postgres",
    async insert(row) {
      try {
        const [inserted] = await db.insert(runs).values(row).returning();
        if (!inserted) {
          return err(persistenceError("write the run", "no row returned"));
        }
        return ok(inserted);
      } catch (cause) {
        return err(persistenceError("write the run", cause));
      }
    },
    async list(limit, offset) {
      try {
        const rows = await db
          .select()
          .from(runs)
          .orderBy(desc(runs.createdAt))
          .limit(limit)
          .offset(offset);
        return ok(rows);
      } catch (cause) {
        return err(persistenceError("read the run history", cause));
      }
    },
    async byId(id) {
      try {
        const [row] = await db.select().from(runs).where(eq(runs.id, id)).limit(1);
        if (!row) return err(appError("not_found", `No run with id ${id}.`));
        return ok(row);
      } catch (cause) {
        return err(persistenceError("read the run", cause));
      }
    },
    async count() {
      try {
        const [row] = await db
          .select({ value: sql<number>`count(*)::int` })
          .from(runs);
        return ok(row?.value ?? 0);
      } catch (cause) {
        return err(persistenceError("count runs", cause));
      }
    },
  };
}

// --- In-memory ------------------------------------------------------------

/**
 * Survives hot reloads via globalThis, for the same reason the Postgres client
 * is cached: without it, every edit in dev would silently wipe the history.
 */
const memoryKey = Symbol.for("signal-desk.memory-runs");
type MemoryGlobal = typeof globalThis & { [memoryKey]?: RunRow[] };

function memoryRows(): RunRow[] {
  const g = globalThis as MemoryGlobal;
  if (!g[memoryKey]) g[memoryKey] = [];
  return g[memoryKey];
}

function memoryStore(): RunStore {
  return {
    kind: "memory",
    async insert(row) {
      const stored: RunRow = {
        id: row.id ?? crypto.randomUUID(),
        createdAt: row.createdAt ?? new Date(),
        symbol: row.symbol,
        side: row.side,
        compositeScore: row.compositeScore,
        technicalScore: row.technicalScore,
        llmConviction: row.llmConviction ?? null,
        llmDirection: row.llmDirection ?? null,
        llmRationale: row.llmRationale ?? null,
        scoreComponents: row.scoreComponents,
        quantity: row.quantity,
        notional: row.notional,
        riskAmount: row.riskAmount,
        entryPrice: row.entryPrice,
        stopLoss: row.stopLoss,
        venue: row.venue,
        venueReason: row.venueReason,
        effectivePrice: row.effectivePrice,
        slippageBps: row.slippageBps,
        feeBps: row.feeBps,
        simulated: true,
      };
      memoryRows().unshift(stored);
      return ok(stored);
    },
    async list(limit, offset) {
      return ok(memoryRows().slice(offset, offset + limit));
    },
    async byId(id) {
      const row = memoryRows().find((r) => r.id === id);
      return row ? ok(row) : err(appError("not_found", `No run with id ${id}.`));
    },
    async count() {
      return ok(memoryRows().length);
    },
  };
}

// --- Selection ------------------------------------------------------------

export function getRunStore(): RunStore {
  const url = databaseUrl();
  return url ? postgresStore(url) : memoryStore();
}
