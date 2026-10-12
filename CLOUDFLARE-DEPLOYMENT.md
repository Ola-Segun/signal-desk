# Cloudflare Deployment Guide — Signal Desk

Signal Desk is configured for deployment to **Cloudflare Workers** using `@opennextjs/cloudflare`, the official Cloudflare adapter for Next.js App Router applications.

---

## Architecture & Compatibility

- **Runtime**: Cloudflare Workers `workerd` with `nodejs_compat` enabled.
- **Adapter**: `@opennextjs/cloudflare`
- **Output**: Bundled worker script (`.open-next/worker.js`) with static assets (`.open-next/assets`).
- **Postgres / Persistence**: Connects to Supabase Postgres over transaction pooler (port `6543`) with `postgres.js`, or can be configured with Cloudflare Hyperdrive for connection pooling and edge acceleration. If `DATABASE_URL` is unset, the in-memory fallback runs automatically without crashing.
- **Market Data & RPCs**: REST & WebSocket calls to Binance and Ethereum JSON-RPC failover work seamlessly over standard edge fetch.

---

## Configuration Files

1. **`wrangler.jsonc`**:
   Points to `.open-next/worker.js`, enables `nodejs_compat`, and binds static assets from `.open-next/assets`.

2. **`open-next.config.ts`**:
   Configures OpenNext using `defineCloudflareConfig()`.

3. **`.gitignore`**:
   Includes `.open-next/` and `.wrangler/` to prevent build artifacts and session tokens from being committed.

---

## Local Preview & Deployment

### 1. Build and Preview Locally in the Workers Runtime

```bash
# Build the Cloudflare Worker bundle
pnpm run build:worker

# Or preview locally under the workerd runtime
pnpm run preview
```

### 2. Authenticate Wrangler CLI (one-time)

```bash
pnpm exec wrangler login
```

### 3. Deploy directly from your machine

```bash
pnpm run deploy
```

---

## Cloudflare Dashboard (Continuous Deployment via Git)

To deploy automatically on every `git push`:

1. Go to **Cloudflare Dashboard** → **Compute (Workers & Pages)** → **Create** → **Workers**.
2. Select **Import a repository** and choose your repository.
3. Configure the build settings:
   - **Framework Preset**: None
   - **Build command**: `pnpm run build:worker`
     *(must be `build:worker`, not `build` — the worker build runs `opennextjs-cloudflare build`
     which produces `.open-next/`. Using `build` alone runs the standard Next.js build, which
     produces `.next/` only and leaves wrangler unable to find the compiled worker.)*
   - **Deploy command**: `pnpm exec wrangler deploy`
     *(use `pnpm exec`, not `npx`, so it picks up the project-local wrangler from `node_modules`)*
   - **Root directory**: `/` (or `signal-desk` if deploying from a monorepo root)
4. Add Environment Variables / Secrets under **Settings** → **Variables and Secrets**:
   - `DATABASE_URL` (Supabase transaction pooler port `6543`)
   - `OPENROUTER_API_KEY` (Optional: for AI scoring)
   - `ANTHROPIC_API_KEY` (Optional: alternative AI scoring)
   - `ETHEREUM_RPC_URL` (Optional: custom RPC node)
   - `NODE_VERSION`: `22`
5. Click **Save and Deploy**.

---

## Setting Secrets with Wrangler CLI

You can also push secrets securely via Wrangler:

```bash
pnpm exec wrangler secret put DATABASE_URL
pnpm exec wrangler secret put OPENROUTER_API_KEY
pnpm exec wrangler secret put ANTHROPIC_API_KEY
```

---

## Post-Deployment Verification Checklist

1. [ ] Check health & root route: `/` loads with live market scan.
2. [ ] Verify `/runs` audit trail displays correctly.
3. [ ] Verify `/about` loads.
4. [ ] Verify simulated routing execution.
5. [ ] Verify database connectivity (if `DATABASE_URL` is configured, verifies persistence; otherwise verifies graceful in-memory fallback).
