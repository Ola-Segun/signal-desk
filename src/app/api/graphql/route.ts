import "server-only";

import { GraphQLError } from "graphql";
import { createSchema, createYoga } from "graphql-yoga";

import {
  getRun,
  listRuns,
  runsInputSchema,
  scan,
  scanInputSchema,
  score,
  scoreInputSchema,
  size,
  sizeInputSchema,
} from "@/lib/services/pipeline";
import type { AppError, Result } from "@/lib/result";

export const runtime = "nodejs";

/**
 * GraphQL over the *same* service layer as the REST handlers.
 *
 * Every resolver below calls a function from `@/lib/services/pipeline` — the
 * identical function the corresponding REST route calls. There is no business
 * logic in this file. That is the whole point: two transports, one
 * implementation, so `/api/score` and the `score` query cannot disagree.
 *
 * Mutations are deliberately absent. Everything this API exposes is a read;
 * running the pipeline writes an audit row, and that stays behind the REST
 * endpoint where its side effect is explicit.
 */

const typeDefs = /* GraphQL */ `
  """
  A simulated routing decision, persisted immutably. Never a real fill.
  """
  type Run {
    id: ID!
    createdAt: String!
    symbol: String!
    side: String!
    compositeScore: Float!
    technicalScore: Float!
    llmConviction: Int
    llmDirection: String
    llmRationale: String
    quantity: Float!
    notional: Float!
    riskAmount: Float!
    entryPrice: Float!
    stopLoss: Float!
    venue: String!
    venueReason: String!
    effectivePrice: Float!
    slippageBps: Float!
    feeBps: Float!
    "Always true. This system does not place real orders."
    simulated: Boolean!
  }

  type RunPage {
    runs: [Run!]!
    total: Int!
    "Which store served this request: 'postgres' or 'memory'."
    persistence: String!
  }

  type Ticker {
    symbol: String!
    price: Float!
    changePercent24h: Float!
    quoteVolume24h: Float!
    high24h: Float!
    low24h: Float!
  }

  type TechnicalComponents {
    momentum: Float!
    volatility: Float!
    participation: Float!
  }

  type TechnicalScore {
    score: Float!
    rsi: Float!
    volatility: Float!
    volumeRatio: Float!
    components: TechnicalComponents!
  }

  type LlmAnalysis {
    conviction: Int!
    direction: String!
    rationale: String!
    risks: [String!]!
    confidence: String!
  }

  type CompositeScore {
    score: Float!
    direction: String!
    technical: TechnicalScore!
    llm: LlmAnalysis
    "Why the model half is missing, when it is."
    llmUnavailableReason: String
  }

  type ScoreResult {
    symbol: String!
    ticker: Ticker!
    composite: CompositeScore!
    candleCount: Int!
  }

  type SizeResult {
    side: String!
    quantity: Float!
    notional: Float!
    riskAmount: Float!
    perUnitRisk: Float!
    baseQuantity: Float!
    volAdjustment: Float!
    rMultiple: Float
    entry: Float!
    stopLoss: Float!
    takeProfit: Float
  }

  type Query {
    "Current universe, ranked by 24h quote volume."
    universe(limit: Int, quoteAsset: String): [Ticker!]!
    "Score one instrument."
    score(symbol: String!, skipLlm: Boolean): ScoreResult!
    "Position sizing. Pure arithmetic, no I/O."
    size(
      accountEquity: Float!
      riskPct: Float!
      entry: Float!
      stopLoss: Float!
      takeProfit: Float
      volatility: Float!
      referenceVolatility: Float
    ): SizeResult!
    "Paginated audit history, newest first."
    runs(limit: Int, offset: Int): RunPage!
    "One run by id."
    run(id: ID!): Run!
  }
`;

/**
 * The service layer returns `Result`. GraphQL communicates failure by throwing,
 * so this is the one adapter between the two conventions — in a single place
 * rather than repeated in every resolver.
 */
function unwrapOrThrow<T>(result: Result<T, AppError>): T {
  if (result.ok) return result.value;

  // Must be a real GraphQLError. Yoga masks any other thrown error as
  // "Unexpected error" with code INTERNAL_SERVER_ERROR — correct behaviour by
  // default, since an arbitrary exception may carry internals — but it means a
  // plain `Error` with `extensions` bolted on loses the typed code on the way
  // out. These messages are written to be user-facing, so they are safe to
  // surface deliberately.
  throw new GraphQLError(result.error.message, {
    extensions: { code: result.error.code, detail: result.error.detail },
  });
}

/** Strip undefined so Zod's `.optional()` and defaults behave as intended. */
function defined<T extends Record<string, unknown>>(args: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(args).filter(([, value]) => value !== undefined && value !== null),
  ) as Partial<T>;
}

const schema = createSchema({
  typeDefs,
  resolvers: {
    Query: {
      universe: async (_: unknown, args: Record<string, unknown>) =>
        unwrapOrThrow(await scan(scanInputSchema.parse(defined(args)))),

      score: async (_: unknown, args: Record<string, unknown>) =>
        unwrapOrThrow(await score(scoreInputSchema.parse(defined(args)))),

      size: (_: unknown, args: Record<string, unknown>) =>
        unwrapOrThrow(size(sizeInputSchema.parse(defined(args)))),

      runs: async (_: unknown, args: Record<string, unknown>) =>
        unwrapOrThrow(await listRuns(runsInputSchema.parse(defined(args)))),

      run: async (_: unknown, args: { id: string }) =>
        unwrapOrThrow(await getRun(args.id)),
    },
    Run: {
      createdAt: (run: { createdAt: Date }) => run.createdAt.toISOString(),
    },
  },
});

const { handleRequest } = createYoga({
  schema,
  graphqlEndpoint: "/api/graphql",
  fetchAPI: { Response },
});

/**
 * Yoga's handler takes its own server-adapter context, which is not the shape
 * Next's route handlers are typed against. Wrapping it — rather than casting
 * the export — keeps both contracts honest: Next sees a route handler, Yoga
 * gets the empty context it expects.
 */
async function handler(request: Request): Promise<Response> {
  return handleRequest(request, {});
}

export { handler as GET, handler as POST, handler as OPTIONS };
