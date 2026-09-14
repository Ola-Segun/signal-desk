import type { Config } from "drizzle-kit";

/**
 * Migration tooling only — the application itself never reads this file.
 *
 * `drizzle-kit` is a dev dependency and these commands are run by hand
 * (`npm run db:generate`, `npm run db:push`), so failing loudly on a missing
 * DATABASE_URL is right here, even though the app degrades gracefully without
 * one at runtime.
 */
const url = process.env.DATABASE_URL;

if (!url) {
  throw new Error(
    "DATABASE_URL is required for drizzle-kit commands. " +
      "The application itself runs without it, using an in-memory store — " +
      "you only need this to generate or push migrations.",
  );
}

export default {
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url },
  strict: true,
  verbose: true,
} satisfies Config;
