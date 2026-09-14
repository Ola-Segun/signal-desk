import { parseJsonBody, sendError, sendResult } from "@/app/api/_lib/respond";
import { score, scoreInputSchema } from "@/lib/services/pipeline";

export const runtime = "nodejs";

/**
 * POST /api/score  { symbol, skipLlm? }
 *
 * Deterministic indicators combined with the model's assessment. Returns every
 * component, not just the composite, so the UI can show why rather than just
 * what.
 */
export async function POST(request: Request) {
  const input = await parseJsonBody(request, scoreInputSchema);
  if (!input.ok) return sendError(input.error);

  return sendResult(await score(input.value));
}
