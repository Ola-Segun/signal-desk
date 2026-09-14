import Link from "next/link";

export const metadata = {
  title: "What's real — Signal Desk",
  description:
    "An explicit account of which parts of Signal Desk use live data and which are simulated.",
};

const REAL: ReadonlyArray<{ what: string; detail: string }> = [
  {
    what: "Market data",
    detail:
      "Live 24h ticker and hourly candles from Binance's public REST endpoints, plus a live WebSocket price stream. No API key is required for any of it.",
  },
  {
    what: "Technical indicators",
    detail:
      "RSI(14), realised daily volatility and volume ratio, computed from the candles actually returned. Pure functions, unit-tested against hand-computed values.",
  },
  {
    what: "Model scoring",
    detail:
      "A real Claude API call, constrained to a JSON schema and re-validated on arrival. When no API key is configured the app says so and falls back to deterministic scoring rather than inventing a number.",
  },
  {
    what: "On-chain reads",
    detail:
      "Genuine ERC-20 contract reads against Ethereum mainnet over a public RPC, using a viem public client.",
  },
  {
    what: "The audit trail",
    detail:
      "Rows are really written and really persisted — to PostgreSQL when DATABASE_URL is set, to an in-memory store otherwise. The page tells you which.",
  },
];

const SIMULATED: ReadonlyArray<{ what: string; detail: string }> = [
  {
    what: "Order execution",
    detail:
      "Nothing is ever submitted anywhere. There is no exchange client, no credential, no signing key and no network write path in the routing module.",
  },
  {
    what: "The venues",
    detail:
      "Four fictional venues with plausible fee, spread and depth parameters. They are a configuration table, not connections.",
  },
  {
    what: "Fills and slippage",
    detail:
      "Impact is modelled as linear in order size relative to venue depth, then capped. Real impact is closer to a square-root law; this is a deliberate simplification, not a market-accurate model.",
  },
  {
    what: "Account equity",
    detail:
      "A number you type. There is no account, no balance and no custody of anything.",
  },
  {
    what: "The stop loss",
    detail:
      "Derived from realised volatility so the demo is one click. A real desk would not let a formula pick its stops unsupervised.",
  },
];

export default function AboutPage() {
  return (
    <div className="max-w-3xl space-y-10">
      <header className="space-y-3">
        <h1 className="text-2xl font-semibold tracking-tight">
          What is real, and what is not
        </h1>
        <p className="text-sm text-ink-300">
          A demo that blurs this line is worse than no demo. Everything below is
          stated plainly so nothing here can be mistaken for a trading system.
        </p>
      </header>

      <section aria-labelledby="real-heading" className="space-y-3">
        <h2 id="real-heading" className="text-sm font-semibold uppercase tracking-wide text-up">
          Real
        </h2>
        <dl className="space-y-3">
          {REAL.map((item) => (
            <div
              key={item.what}
              className="rounded-lg border border-up/30 bg-up/5 p-3"
            >
              <dt className="font-medium">{item.what}</dt>
              <dd className="mt-1 text-sm text-ink-300">{item.detail}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section aria-labelledby="sim-heading" className="space-y-3">
        <h2 id="sim-heading" className="text-sm font-semibold uppercase tracking-wide text-warn">
          Simulated
        </h2>
        <dl className="space-y-3">
          {SIMULATED.map((item) => (
            <div
              key={item.what}
              className="rounded-lg border border-warn/30 bg-warn/5 p-3"
            >
              <dt className="font-medium">{item.what}</dt>
              <dd className="mt-1 text-sm text-ink-300">{item.detail}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section aria-labelledby="why-heading" className="space-y-3">
        <h2 id="why-heading" className="text-sm font-semibold uppercase tracking-wide text-ink-300">
          Why an LLM scores but does not execute
        </h2>
        <p className="text-sm text-ink-300">
          The model is asked for a judgement — conviction, direction, rationale,
          risks — and its output is constrained to a JSON schema and validated
          again on arrival. Everything downstream of that judgement is
          deterministic and unit-tested: sizing is arithmetic, venue selection is
          a stated rule, and both are reproducible from their inputs.
        </p>
        <p className="text-sm text-ink-300">
          That split is deliberate. A language model is useful for weighing
          ambiguous evidence and explaining itself. It is the wrong tool for
          anything that must be exactly reproducible, auditable after the fact,
          or safe under adversarial input — which is all of sizing, routing and
          execution.
        </p>
      </section>

      <section aria-labelledby="stack-heading" className="space-y-3">
        <h2 id="stack-heading" className="text-sm font-semibold uppercase tracking-wide text-ink-300">
          Stack
        </h2>
        <p className="text-sm text-ink-300">
          Next.js 16 (App Router, Server Components, Route Handlers) · React 19 ·
          TypeScript in strict mode · PostgreSQL via Drizzle · GraphQL over the
          same service layer as the REST API · viem for on-chain reads · the
          Anthropic SDK for model scoring · Vitest · Tailwind CSS v4.
        </p>
        <p className="text-sm text-ink-300">
          The REST handlers and the GraphQL resolvers call the same service
          functions, so the two transports cannot drift apart. Try the{" "}
          <Link
            href="/api/graphql"
            className="text-accent underline underline-offset-4"
          >
            GraphQL endpoint
          </Link>{" "}
          or{" "}
          <Link
            href="/api/scan"
            className="text-accent underline underline-offset-4"
          >
            /api/scan
          </Link>
          .
        </p>
      </section>

      <section aria-labelledby="ai-heading" className="space-y-3">
        <h2 id="ai-heading" className="text-sm font-semibold uppercase tracking-wide text-ink-300">
          How this was built
        </h2>
        <p className="text-sm text-ink-300">
          Built with AI assistance, deliberately and on the record. The
          architecture, the scoring policy, the risk model and the honesty
          constraints were specified first; generation happened against that
          brief, and the output was reviewed the way any contribution would be —
          typecheck, lint, tests, and reading the arithmetic rather than trusting
          that it looked right. One sign error in the slippage model was caught
          that way before it shipped.
        </p>
        <p className="text-sm text-ink-300">
          Disclosed and documented, AI assistance is evidence of process. Hidden
          and then discovered, it discounts everything around it. The README
          covers the workflow in more detail.
        </p>
      </section>
    </div>
  );
}
