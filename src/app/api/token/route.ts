import { sendError, sendResult } from "@/app/api/_lib/respond";
import { readToken } from "@/lib/chain/erc20";
import { appError } from "@/lib/result";

/**
 * GET /api/token?address=0x...
 *
 * Read-only ERC-20 metadata. No wallet, no signing, no writes.
 */
export async function GET(request: Request) {
  const address = new URL(request.url).searchParams.get("address");
  if (!address) {
    return sendError(
      appError("invalid_input", "An `address` query parameter is required."),
    );
  }

  return sendResult(await readToken(address));
}
