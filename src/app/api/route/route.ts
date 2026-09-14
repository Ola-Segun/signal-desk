import { parseJsonBody, sendError, sendResult } from "@/app/api/_lib/respond";
import { route, routeInputSchema } from "@/lib/services/pipeline";

export const runtime = "nodejs";

/**
 * POST /api/route  { symbol, accountEquity?, riskPct?, skipLlm? }
 *
 * Runs the full pipeline and writes one immutable audit row.
 *
 * SIMULATION ONLY. No order is submitted to any venue. The `simulated` column
 * on the persisted row is NOT NULL DEFAULT true and nothing here writes false.
 */
export async function POST(request: Request) {
  const input = await parseJsonBody(request, routeInputSchema);
  if (!input.ok) return sendError(input.error);

  return sendResult(await route(input.value));
}
