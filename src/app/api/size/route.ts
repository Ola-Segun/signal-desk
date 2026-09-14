import { parseJsonBody, sendError, sendResult } from "@/app/api/_lib/respond";
import { size, sizeInputSchema } from "@/lib/services/pipeline";

export const runtime = "nodejs";

/**
 * POST /api/size  { accountEquity, riskPct, entry, stopLoss, takeProfit?, volatility }
 *
 * Pure arithmetic — no I/O. Invalid combinations (a stop on the wrong side of
 * entry, a take profit that implies a loss) are rejected with a 400 rather than
 * silently clamped.
 */
export async function POST(request: Request) {
  const input = await parseJsonBody(request, sizeInputSchema);
  if (!input.ok) return sendError(input.error);

  return sendResult(size(input.value));
}
