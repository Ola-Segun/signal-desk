import "server-only";

/**
 * Server-only environment access.
 *
 * Importing `server-only` makes it a build error to pull this module into a
 * Client Component, so a secret cannot reach the browser by accident. Nothing
 * here is read at module scope — values are read on use, so a missing optional
 * variable degrades a feature instead of failing the build.
 */

/** Present only when a Postgres instance is configured. */
export function databaseUrl(): string | undefined {
  const value = process.env.DATABASE_URL?.trim();
  return value ? value : undefined;
}

/** Present only when LLM scoring is configured. */
export function anthropicApiKey(): string | undefined {
  const value = process.env.ANTHROPIC_API_KEY?.trim();
  return value ? value : undefined;
}

/**
 * Public JSON-RPC endpoints for read-only chain reads.
 *
 * Several are returned so the client can fail over between them: free public
 * endpoints go down or rate-limit without warning, and a single hardcoded URL
 * makes the feature look broken when it is really just one provider having a
 * bad day. `ETHEREUM_RPC_URL` overrides the list entirely.
 */
export function ethereumRpcUrls(): string[] {
  const override = process.env.ETHEREUM_RPC_URL?.trim();
  if (override) return [override];

  return [
    "https://ethereum-rpc.publicnode.com",
    "https://cloudflare-eth.com",
    "https://eth.drpc.org",
  ];
}

export function isLlmConfigured(): boolean {
  return anthropicApiKey() !== undefined;
}

export function isDatabaseConfigured(): boolean {
  return databaseUrl() !== undefined;
}
