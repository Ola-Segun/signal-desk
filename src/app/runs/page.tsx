import Link from "next/link";

import { listRuns } from "@/lib/services/pipeline";

export const metadata = {
  title: "Audit trail — Signal Desk",
  description:
    "Every simulated routing decision, with the score components and venue reasoning that produced it.",
};

const PAGE_SIZE = 25;

/**
 * The audit trail.
 *
 * `searchParams` is a Promise in this version of Next and must be awaited.
 */
export default async function RunsPage({ searchParams }: PageProps<"/runs">) {
  const params = await searchParams;
  const pageParam = Number(Array.isArray(params.page) ? params.page[0] : params.page);
  const page = Number.isInteger(pageParam) && pageParam > 0 ? pageParam : 1;

  const result = await listRuns({
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  });

  if (!result.ok) {
    return (
      <div role="alert" className="rounded-lg border border-down/50 bg-down/10 p-4">
        <h1 className="text-lg font-semibold text-down">Could not load the audit trail</h1>
        <p className="mt-1 text-sm text-ink-300">{result.error.message}</p>
      </div>
    );
  }

  const { runs, total, persistence } = result.value;
  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Audit trail</h1>
        <p className="max-w-3xl text-sm text-ink-300">
          One immutable row per pipeline run. Nothing in this application updates
          or deletes a row once written — an audit trail you can edit is not an
          audit trail. Every row is a simulation.
        </p>
        <p className="text-xs text-ink-500">
          {total} {total === 1 ? "run" : "runs"} · stored in{" "}
          {persistence === "postgres" ? "PostgreSQL" : "an in-memory store"}
          {persistence === "memory" && " (resets when the server restarts)"}
        </p>
      </header>

      {runs.length === 0 ? (
        <p className="rounded-lg border border-desk-700 bg-desk-850 px-4 py-10 text-center text-sm text-ink-500">
          No runs yet.{" "}
          <Link href="/" className="text-accent underline underline-offset-4">
            Run the pipeline
          </Link>{" "}
          and it will appear here.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-desk-700">
          <table className="w-full min-w-[54rem] border-collapse text-sm">
            <caption className="sr-only">
              Simulated routing decisions, newest first.
            </caption>
            <thead className="bg-desk-850 text-left text-xs uppercase tracking-wide text-ink-500">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">When</th>
                <th scope="col" className="px-3 py-2 font-medium">Symbol</th>
                <th scope="col" className="px-3 py-2 font-medium">Side</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Score</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Quantity</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Notional</th>
                <th scope="col" className="px-3 py-2 font-medium">Venue</th>
                <th scope="col" className="px-3 py-2 font-medium">Simulated</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.id} className="border-t border-desk-800 align-top">
                  <td className="numeric px-3 py-2 text-xs text-ink-500">
                    <time dateTime={run.createdAt.toISOString()}>
                      {run.createdAt.toISOString().replace("T", " ").slice(0, 19)}
                    </time>
                  </td>
                  <th scope="row" className="px-3 py-2 text-left font-medium">
                    {run.symbol}
                  </th>
                  <td className="px-3 py-2 uppercase">{run.side}</td>
                  <td className="numeric px-3 py-2 text-right">
                    {run.compositeScore.toFixed(1)}
                  </td>
                  <td className="numeric px-3 py-2 text-right">
                    {run.quantity.toPrecision(6)}
                  </td>
                  <td className="numeric px-3 py-2 text-right">
                    ${run.notional.toLocaleString("en-US", { maximumFractionDigits: 2 })}
                  </td>
                  <td className="px-3 py-2">
                    <span>{run.venue}</span>
                    <span className="mt-0.5 block max-w-xs text-xs text-ink-500">
                      {run.venueReason}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <span className="rounded bg-warn/20 px-1.5 py-0.5 text-xs uppercase tracking-wide text-warn">
                      {String(run.simulated)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {lastPage > 1 && (
        <nav aria-label="Pagination" className="flex items-center gap-3 text-sm">
          {page > 1 && (
            <Link
              href={`/runs?page=${page - 1}`}
              className="rounded border border-desk-600 px-3 py-1.5 text-ink-300 hover:border-accent"
            >
              ← Newer
            </Link>
          )}
          <span className="text-xs text-ink-500">
            Page {page} of {lastPage}
          </span>
          {page < lastPage && (
            <Link
              href={`/runs?page=${page + 1}`}
              className="rounded border border-desk-600 px-3 py-1.5 text-ink-300 hover:border-accent"
            >
              Older →
            </Link>
          )}
        </nav>
      )}
    </div>
  );
}
