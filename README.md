# Signal Desk

A market-research pipeline built end to end: **scan → score → size → route**.

Live exchange data and read-only on-chain reads, scored by deterministic
indicators alongside a language model constrained to a JSON schema, sized
against a unit-tested risk model, and routed to one of four venues with an
immutable audit trail.

> ## ⚠️ This is a simulation
>
> **No order is ever submitted anywhere.** There is no exchange client, no
> credential, no signing key, and no network write path in the routing module.
> No wallet is connected and no private key is handled at any point. The
> `simulated` column on every persisted row is `NOT NULL DEFAULT true` and
> nothing in the codebase writes `false`.
>
> Nothing here is financial advice.

---

## Run it

```bash
npm install
npm run dev
```

That is the whole setup. **Every environment variable is optional** — with none
set, the app fetches live market data, computes deterministic scores, performs
real on-chain reads, and stores the audit trail in memory. The UI states which
features are reduced rather than pretending otherwise.

To enable the rest, copy `.env.example` to `.env.local`:

| Variable | Enables | Without it |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | Model scoring | Deterministic score only, and the UI says so |
| `DATABASE_URL` | Postgres persistence | In-memory store, resets on restart |
| `ETHEREUM_RPC_URL` | Your own RPC | Falls back to a public endpoint |

With `DATABASE_URL` set, create the table:

```bash
npm run db:push
```

## Verify it

```bash
npm run typecheck   # tsc --noEmit, strict
npm run lint        # eslint
npm test            # vitest — 89 tests
npm run build       # production build
```

All four run in CI on every push and pull request, with no secrets provided —
the build must succeed without an API key or a database, which is also how a
reviewer will first run it.

---

## The pipeline

### 1 · Scan

`src/lib/market/binance.ts` · `src/lib/chain/erc20.ts`

Public Binance REST endpoints for the 24h ticker universe and hourly candles,
plus a combined `@ticker` WebSocket stream for live prices. No API key needed.

The stream handles three things a naive implementation does not:

- **Reconnect with exponential backoff and jitter**, so a dropped socket does
  not leave a dead UI showing stale prices.
- **A stale-tick guard** — messages can arrive out of order after a reconnect,
  so a tick older than the newest already seen for that symbol is dropped. A
  slower in-flight message can never overwrite a newer price.
- **Deliberate teardown** — `close()` suppresses the reconnect, so an unmounting
  component does not leave a socket reopening forever.

On-chain reads use a **viem public client**, which has no account attached and
therefore cannot send a transaction. The absence of a write path is structural,
not a convention.

### 2 · Score

`src/lib/score/technical.ts` · `src/lib/score/llm.ts`

Two halves, combined 60/40 in favour of the deterministic one.

**Deterministic:** RSI(14) with Wilder smoothing, realised daily volatility, and
volume against its own recent baseline. Pure functions — no I/O, no clock, no
randomness. Each formula is stated in a comment above its implementation.

**Model:** a Claude call constrained by `output_config.format` to a JSON schema,
then re-validated with Zod on arrival. The API constraint is the contract; the
Zod parse is the guard for when the contract is wrong. No free-text parsing
anywhere.

`stop_reason` is checked **before** `content` is read — a refusal returns HTTP
200 with empty or partial content, so indexing `content[0]` first is a latent
crash rather than an error case.

When the model half is unavailable the composite falls back to the
deterministic score and reports why. It does not substitute a neutral 50, which
would look like a real assessment.

### 3 · Size

`src/lib/size/position.ts`

```
riskAmount    = accountEquity * (riskPct / 100)
perUnitRisk   = |entry - stopLoss|
baseQuantity  = riskAmount / perUnitRisk

volAdjustment = referenceVolatility / max(volatility, referenceVolatility)
quantity      = baseQuantity * volAdjustment
```

The `max()` caps the adjustment at 1: volatility above the reference shrinks the
position, volatility below it does not inflate one. Sizing *up* because a market
has been quiet is how a risk model turns a calm period into a large loss when
the calm ends.

Direction is inferred from the stop rather than passed in, which makes the
inconsistent combination — a long with a stop above entry — unrepresentable
rather than merely discouraged. Invalid inputs are rejected explicitly; nothing
is silently clamped.

### 4 · Route — simulated

`src/lib/route/simulate.ts`

Four fictional venues with fee, spread and depth parameters. The rule, stated
plainly: **buy where the all-in cost is lowest, sell where the net proceeds are
highest** — fees and slippage included, because routing on displayed price alone
is how an apparently better quote turns out worse after costs.

Buying and selling routinely route to *different* venues, which is the point.

Impact is modelled as linear in order size relative to venue depth, then capped.
Real impact is closer to a square-root law; this is a deliberate simplification
documented as one, not presented as market-accurate.

---

## API

REST route handlers and GraphQL resolvers call the **same service functions** in
`src/lib/services/pipeline.ts`. Neither transport contains business logic, so
`/api/score` and the `score` GraphQL field cannot drift apart.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/scan` | Current universe by 24h volume |
| `POST` | `/api/score` | Combined score with every component |
| `POST` | `/api/size` | Position sizing (pure, no I/O) |
| `POST` | `/api/route` | Full pipeline; writes one audit row |
| `GET` | `/api/runs` | Paginated audit history |
| `GET` | `/api/token` | Read-only ERC-20 metadata |
| `GET`/`POST` | `/api/graphql` | Same operations over GraphQL |

```bash
curl -s localhost:3000/api/scan | head -c 400

curl -s localhost:3000/api/graphql \
  -H 'content-type: application/json' \
  -d '{"query":"{ universe(limit:3){ symbol price changePercent24h } }"}'
```

---

## Design notes

**Typed errors, not exceptions.** Modules return `Result<T, AppError>` rather
than throwing across their public boundary, so callers are forced by the type
system to handle failure. Exceptions are reserved for programmer error.

**Validation at every boundary.** Every upstream response is Zod-parsed before
use. An exchange that changes shape produces one clear error at the boundary
rather than `undefined` surfacing three layers away.

**Graceful degradation over hard failure.** Missing API key, unreachable model,
no database — each degrades a feature and says so. A demo that silently
half-works looks broken; one that explains itself looks deliberate.

**Accessibility as implementation.** Live regions exist in the DOM before the
updates they announce, because a region mounted at the same moment as its text
announces nothing. Price direction is carried by an arrow and a signed number,
never by colour alone. Numeric columns use tabular figures so rows do not reflow
as prices tick. Individual ticks are deliberately *not* announced — a live
region firing on every price change is unusable.

**A 2.5 MB response cannot be cached.** The Binance 24h ticker payload exceeds
Next's 2 MB data-cache limit, so `cache: "force-cache"` silently fails to store
and every request reaches the exchange. The derived universe is memoised
in-process instead, which is what the fetch cache was meant to buy. This was
found by reading a build warning, not by guessing.

---

## Stack

Next.js 16 (App Router, Server Components, Route Handlers) · React 19 ·
TypeScript strict · PostgreSQL via Drizzle · GraphQL Yoga · viem · Anthropic SDK
· Vitest · Tailwind CSS v4 · deployed on Vercel.

---

## On testing

The expected values in `tests/position.test.ts`, `tests/technical.test.ts` and
`tests/route.test.ts` were **computed by hand from the documented formulas**,
not captured from a run of the code. The worked arithmetic is in a comment above
each case.

This matters more than the count. A test asserting whatever the implementation
produced verifies only that the implementation is deterministic — it cannot
catch arithmetic that is confidently wrong. `Math.ceil(total * 0.67)` on a
three-item check reads like "67%" and silently demands a perfect score; a test
written from the output would have locked that behaviour in rather than caught
it.

Four real defects were caught during the build, none by the type checker:

1. **A sign error in the slippage model** — market impact was applied
   side-independently, so a buy and a sell got identical slippage. Now covered
   by a test asserting the two differ and are symmetric about the venue spread.
2. **A cache-mutation bug** — `Array.prototype.sort` mutates, so sorting the
   cached ticker list in place reordered it for every later caller. It would
   only have surfaced on the second request, with no error. Now covered.
3. **An unknown symbol returned 502** — Binance answers one with a 400, which
   was being mapped to `upstream_unavailable`. That tells the caller to retry
   something that can never succeed. Now mapped to `not_found` / 404, with
   tests for both the 400 and 500 cases.
4. **GraphQL was masking typed errors** — Yoga replaces any non-`GraphQLError`
   with "Unexpected error" and `INTERNAL_SERVER_ERROR`, which is the right
   default but discarded the error codes the service layer produces. Resolvers
   now throw a real `GraphQLError`.

The last two were only reachable by running the server and walking the routes —
typecheck, lint, tests and a clean build all passed while both were present.
That is the argument for exercising a flow end to end rather than trusting a
green pipeline.

The deterministic core is well covered. UI coverage is deliberately not chased —
a snapshot of a `div` proves nothing.

---

## How this was built

Built with AI assistance, deliberately and on the record.

The architecture, scoring policy, risk model and honesty constraints were
specified first; generation happened against that brief. The output was then
reviewed the way any contribution would be: typecheck, lint, tests, and reading
the arithmetic rather than trusting that it looked right. Both bugs listed above
were caught in that review, not by the generator.

Disclosed and documented, AI assistance is evidence of process. Hidden and then
discovered, it discounts everything around it.

## Known limitations

- The in-memory store is per-instance and resets on restart. Set `DATABASE_URL`
  for real persistence.
- The in-process universe cache is per-instance, not shared. It exists to be
  polite to a public endpoint, not to be a distributed cache.
- `drizzle-kit` pulls a dev-only transitive advisory (`@esbuild-kit/*`). It is a
  dev dependency and no part of it ships in the build.
- Binance's public API is unavailable from some regions. The app reports this as
  an upstream error rather than failing opaquely.

---

Built by Segun Olaniyan — [olasegun.netlify.app](https://olasegun.netlify.app) ·
[github.com/Ola-Segun](https://github.com/Ola-Segun)
