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

/** Present only when Anthropic scoring is configured. */
export function anthropicApiKey(): string | undefined {
  const value = process.env.ANTHROPIC_API_KEY?.trim();
  return value ? value : undefined;
}

/** Present only when OpenRouter scoring is configured. */
export function openRouterApiKey(): string | undefined {
  const value = process.env.OPENROUTER_API_KEY?.trim();
  return value ? value : undefined;
}

/**
 * Override the OpenRouter model chain. Comma-separated, tried in order.
 * Defaults live in the provider so the fallback list is versioned with the
 * code that knows how to handle each model's failure modes.
 */
export function openRouterModels(): string[] | undefined {
  const raw = process.env.OPENROUTER_MODELS?.trim();
  if (!raw) return undefined;
  const list = raw.split(",").map((m) => m.trim()).filter(Boolean);
  return list.length > 0 ? list : undefined;
}

export type LlmProviderName = "openrouter" | "anthropic";

/**
 * Which provider to use. `LLM_PROVIDER` forces one; otherwise OpenRouter is
 * preferred when configured, because its free tier means the demo costs
 * nothing to run.
 */
export function llmProvider(): LlmProviderName | undefined {
  const forced = process.env.LLM_PROVIDER?.trim().toLowerCase();
  if (forced === "openrouter") return openRouterApiKey() ? "openrouter" : undefined;
  if (forced === "anthropic") return anthropicApiKey() ? "anthropic" : undefined;

  if (openRouterApiKey()) return "openrouter";
  if (anthropicApiKey()) return "anthropic";
  return undefined;
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
  return llmProvider() !== undefined;
}

export function isDatabaseConfigured(): boolean {
  return databaseUrl() !== undefined;
}
