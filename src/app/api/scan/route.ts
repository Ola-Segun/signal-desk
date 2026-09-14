import { parseSearchParams, sendError, sendResult } from "@/app/api/_lib/respond";
import { scan, scanInputSchema } from "@/lib/services/pipeline";

/** Node runtime: the service layer reaches Postgres and the Anthropic SDK. */
export const runtime = "nodejs";

/**
 * GET /api/scan?limit=12&quoteAsset=USDT
 *
 * The current universe, ranked by 24h quote volume.
 */
export async function GET(request: Request) {
  const input = parseSearchParams(request, scanInputSchema);
  if (!input.ok) return sendError(input.error);

  return sendResult(await scan(input.value));
}
