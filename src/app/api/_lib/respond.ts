import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";

import { appError, statusForError, type AppError, type Result } from "@/lib/result";

/**
 * Shared plumbing for the REST handlers, so each route file is a thin adapter:
 * parse the body, call one service function, serialise. No business logic lives
 * in a route handler.
 */

export function sendResult<T>(result: Result<T, AppError>): NextResponse {
  if (result.ok) {
    return NextResponse.json({ ok: true, data: result.value });
  }
  return NextResponse.json(
    { ok: false, error: result.error },
    { status: statusForError(result.error.code) },
  );
}

export function sendError(error: AppError): NextResponse {
  return NextResponse.json(
    { ok: false, error },
    { status: statusForError(error.code) },
  );
}

/** Parse a JSON request body against a schema, returning a typed failure. */
export async function parseJsonBody<S extends z.ZodType>(
  request: Request,
  schema: S,
): Promise<Result<z.infer<S>, AppError>> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return {
      ok: false,
      error: appError("invalid_input", "Request body must be valid JSON."),
    };
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      error: appError(
        "invalid_input",
        issue
          ? `${issue.path.join(".") || "body"}: ${issue.message}`
          : "Request body did not match the expected shape.",
      ),
    };
  }

  return { ok: true, value: parsed.data };
}

/** Parse query-string params against a schema, coercing numbers and booleans. */
export function parseSearchParams<S extends z.ZodType>(
  request: Request,
  schema: S,
): Result<z.infer<S>, AppError> {
  const url = new URL(request.url);
  const raw: Record<string, unknown> = {};

  for (const [key, value] of url.searchParams.entries()) {
    if (value === "true" || value === "false") {
      raw[key] = value === "true";
      continue;
    }
    const asNumber = Number(value);
    raw[key] = value !== "" && Number.isFinite(asNumber) ? asNumber : value;
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      error: appError(
        "invalid_input",
        issue
          ? `${issue.path.join(".") || "query"}: ${issue.message}`
          : "Query parameters did not match the expected shape.",
      ),
    };
  }

  return { ok: true, value: parsed.data };
}
