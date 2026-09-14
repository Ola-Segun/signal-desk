/**
 * Verify DATABASE_URL end to end: connect, confirm the table exists, confirm
 * the schema matches, write a row, read it back, delete it.
 *
 * Run with:  npm run db:check
 *
 * Prints nothing that could leak the connection string — host and database
 * name only, never the password.
 */

import { readFileSync } from "node:fs";
import postgres from "postgres";

// Load .env.local without adding a dependency. Next loads this automatically at
// runtime; a standalone script does not get that for free.
function loadEnvLocal() {
  try {
    const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (!match) continue;
      const [, key, rawValue] = match;
      if (process.env[key]) continue;
      process.env[key] = rawValue.trim().replace(/^["']|["']$/g, "");
    }
  } catch {
    // No .env.local is fine — the variable may come from the environment.
  }
}

loadEnvLocal();

const url = process.env.DATABASE_URL?.trim();

if (!url) {
  console.error("DATABASE_URL is not set.");
  console.error("Add it to .env.local, then run this again.");
  process.exit(1);
}

// --- Sanity-check the URL shape before opening a socket, so the common
// --- paste mistakes produce a precise message instead of a timeout.

const problems = [];

// Check the RAW string first. `new URL()` percent-encodes brackets in the
// userinfo, so a `[YOUR-PASSWORD]` placeholder silently becomes
// `%5BYOUR-PASSWORD%5D` and a check against the parsed password never matches.
const placeholders = ["[YOUR-PASSWORD]", "[PROJECT-REF]", "[REGION]", "[DB-PASSWORD]"].filter(
  (p) => url.includes(p),
);
if (placeholders.length > 0) {
  problems.push(
    `Still contains ${placeholders.join(", ")} — replace with the real values from the dashboard.`,
  );
}

// The authority section is everything between "//" and the first "/" after it.
// An unencoded @ in the password puts two @ in there, and URL resolves the
// LAST one as the delimiter — so the host still looks plausible and the
// failure only shows up as a confusing DNS error at connect time.
const authority = url.replace(/^[a-z+]+:\/\//i, "").split("/")[0] ?? "";
const atCount = (authority.match(/@/g) ?? []).length;
if (atCount > 1) {
  problems.push(
    "The password appears to contain an unencoded '@'. URL-encode it as %40 " +
      "(and any other of : / ? # [ ] %).",
  );
}

// Report raw-string problems before attempting to parse. A placeholder like
// [REGION] in the hostname makes `new URL()` throw (brackets are reserved for
// IPv6 literals), so parsing first would replace a precise message with a
// generic "not a valid URL".
if (problems.length > 0) {
  console.error("DATABASE_URL looks malformed:\n");
  problems.forEach((p) => console.error(`  - ${p}`));
  process.exit(1);
}

let parsed;
try {
  parsed = new URL(url);
} catch {
  console.error("DATABASE_URL is not a valid URL.");
  console.error("It should start with postgresql:// — check for a stray quote or line break.");
  process.exit(1);
}

if (!/^postgres(ql)?:$/.test(parsed.protocol)) {
  problems.push(`Protocol is "${parsed.protocol}" — expected postgresql:`);
}
if (!parsed.password) {
  problems.push("No password in the URL.");
}
if (parsed.hostname && !parsed.hostname.includes(".")) {
  problems.push(
    `Host parsed as "${parsed.hostname}", which looks wrong — check for unencoded characters in the password.`,
  );
}

if (problems.length > 0) {
  console.error("DATABASE_URL looks malformed:\n");
  problems.forEach((p) => console.error(`  - ${p}`));
  process.exit(1);
}

const pooled =
  url.includes("pooler.supabase.com") ||
  url.includes(":6543") ||
  url.includes("pgbouncer=true");

console.log(`host        : ${parsed.hostname}`);
console.log(`port        : ${parsed.port || "5432"}`);
console.log(`database    : ${parsed.pathname.replace(/^\//, "") || "(default)"}`);
console.log(`pooled      : ${pooled ? "yes — prepared statements disabled" : "no (direct connection)"}`);

if (!pooled && parsed.hostname.includes("supabase")) {
  console.log(
    "\nnote        : this is a DIRECT Supabase connection. It works locally, but on\n" +
      "              Vercel prefer the Transaction pooler (port 6543) — a serverless\n" +
      "              function opening a direct connection per invocation will exhaust\n" +
      "              the connection limit.",
  );
}

console.log();

const sql = postgres(url, {
  max: 1,
  idle_timeout: 5,
  connect_timeout: 15,
  prepare: !pooled,
  onnotice: () => {},
});

const EXPECTED_COLUMNS = [
  "composite_score", "created_at", "effective_price", "entry_price", "fee_bps",
  "id", "llm_conviction", "llm_direction", "llm_rationale", "notional",
  "quantity", "risk_amount", "score_components", "side", "simulated",
  "slippage_bps", "stop_loss", "symbol", "technical_score", "venue",
  "venue_reason",
];

let failed = false;

try {
  const [version] = await sql`SELECT version() AS v`;
  console.log("connected   : OK");
  console.log(`server      : ${String(version.v).split(" ").slice(0, 2).join(" ")}`);

  const [exists] = await sql`
    SELECT to_regclass('public.runs') IS NOT NULL AS present
  `;

  if (!exists.present) {
    console.error("\ntable 'runs': MISSING");
    console.error("Run drizzle/0000_create_runs.sql in the Supabase SQL Editor,");
    console.error("or `npm run db:push`, then run this check again.");
    failed = true;
  } else {
    console.log("table 'runs': present");

    const columns = await sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'runs'
      ORDER BY column_name
    `;
    const found = columns.map((c) => c.column_name);
    const missing = EXPECTED_COLUMNS.filter((c) => !found.includes(c));

    if (missing.length > 0) {
      console.error(`\ncolumns     : MISSING ${missing.join(", ")}`);
      console.error("The table exists but does not match the schema this app expects.");
      failed = true;
    } else {
      console.log(`columns     : all ${EXPECTED_COLUMNS.length} present`);

      // Round-trip a row. Connecting proves credentials; writing proves the
      // grants are right, which is the part that usually bites later.
      const [written] = await sql`
        INSERT INTO runs (
          symbol, side, composite_score, technical_score, score_components,
          quantity, notional, risk_amount, entry_price, stop_loss,
          venue, venue_reason, effective_price, slippage_bps, fee_bps
        ) VALUES (
          '__CONNECTIVITY_CHECK__', 'buy', 0, 0, '{"check":true}'::jsonb,
          0, 0, 0, 1, 0.5,
          'check', 'connectivity check', 1, 0, 0
        ) RETURNING id, simulated
      `;

      console.log(`write       : OK (simulated defaulted to ${written.simulated})`);

      await sql`DELETE FROM runs WHERE id = ${written.id}`;
      console.log("cleanup     : OK");

      const [{ count }] = await sql`SELECT count(*)::int AS count FROM runs`;
      console.log(`rows        : ${count}`);
    }
  }
} catch (cause) {
  const message = cause instanceof Error ? cause.message : String(cause);
  console.error("\nFAILED:", message.replace(/postgres(ql)?:\/\/[^\s]*/gi, "[redacted]"));

  if (/password authentication failed/i.test(message)) {
    console.error("\n-> Wrong password, or an unencoded special character in it.");
    console.error("   Reset it at Dashboard -> Settings -> Database -> Reset password.");
  } else if (/ENOTFOUND|EAI_AGAIN/i.test(message)) {
    console.error("\n-> Host not found. Copy the string from Dashboard -> Connect.");
  } else if (/ETIMEDOUT|ECONNREFUSED/i.test(message)) {
    console.error("\n-> Could not reach the host. If this is the direct connection,");
    console.error("   try the Transaction pooler string instead (port 6543).");
  } else if (/prepared statement/i.test(message)) {
    console.error("\n-> PgBouncer rejected a prepared statement. The URL should contain");
    console.error("   pooler.supabase.com or :6543 so this is detected automatically.");
  }
  failed = true;
} finally {
  await sql.end({ timeout: 5 });
}

console.log(failed ? "\nRESULT: not ready" : "\nRESULT: ready — persistence will use Postgres");
process.exit(failed ? 1 : 0);
