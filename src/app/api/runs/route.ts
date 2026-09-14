import { parseSearchParams, sendError, sendResult } from "@/app/api/_lib/respond";
import { listRuns, runsInputSchema } from "@/lib/services/pipeline";

export const runtime = "nodejs";

/**
 * GET /api/runs?limit=25&offset=0
 *
 * Paginated audit history, newest first.
 */
export async function GET(request: Request) {
  const input = parseSearchParams(request, runsInputSchema);
  if (!input.ok) return sendError(input.error);

  return sendResult(await listRuns(input.value));
}
