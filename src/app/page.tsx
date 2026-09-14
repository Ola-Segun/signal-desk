import { PipelineRunner } from "@/components/pipeline-runner";
import { TokenReader } from "@/components/token-reader";
import { isDatabaseConfigured, isLlmConfigured } from "@/lib/env";
import { scan } from "@/lib/services/pipeline";

/**
 * The desk.
 *
 * The universe is fetched on the server so the grid has rows before any
 * JavaScript runs — the page is readable without a working socket, and the
 * socket only takes over updating it.
 */
export default async function DeskPage() {
  const universe = await scan({ limit: 12 });

  return (
    <div className="space-y-10">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">
          Scan → Score → Size → Route
        </h1>
        <p className="max-w-3xl text-sm text-ink-300">
          Live market data from a public exchange feed, scored by deterministic
          indicators and a language model constrained to a JSON schema, sized
          against a unit-tested risk model, and routed to the best of four
          fictional venues. The routing step is simulated and writes an
          immutable audit row. Nothing here places an order.
        </p>
        <ConfigNotice />
      </header>

      {universe.ok ? (
        <PipelineRunner universe={universe.value} />
      ) : (
        <div
          role="alert"
          className="rounded-lg border border-down/50 bg-down/10 p-4 text-sm"
        >
          <p className="font-medium text-down">{universe.error.message}</p>
          {universe.error.detail && (
            <p className="mt-1 text-xs text-ink-300">{universe.error.detail}</p>
          )}
          <p className="mt-2 text-xs text-ink-500">
            The exchange endpoint is public and unauthenticated, so this is
            usually a network or regional restriction rather than a
            configuration problem.
          </p>
        </div>
      )}

      <hr className="border-desk-800" />

      <TokenReader />
    </div>
  );
}

/**
 * Says plainly which optional pieces are configured. A demo that silently
 * degrades looks broken; one that explains itself looks deliberate.
 */
function ConfigNotice() {
  const llm = isLlmConfigured();
  const db = isDatabaseConfigured();
  if (llm && db) return null;

  return (
    <p className="rounded border border-desk-700 bg-desk-850 px-3 py-2 text-xs text-ink-500">
      <strong className="text-ink-300">Running in reduced mode.</strong>{" "}
      {!llm && "Model scoring is off (no ANTHROPIC_API_KEY) — scores are deterministic only. "}
      {!db && "Audit rows go to an in-memory store (no DATABASE_URL) and reset on restart."}
    </p>
  );
}
