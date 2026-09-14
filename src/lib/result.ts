/**
 * A typed result. Modules in this codebase do not throw across their public
 * boundary — they return `Result`, and the caller is forced by the type system
 * to consider the failure case.
 *
 * Exceptions are reserved for programmer error (a bug), not for expected
 * conditions like "the exchange is unreachable" or "the model declined".
 */

export type Ok<T> = { ok: true; value: T };
export type Err<E> = { ok: false; error: E };
export type Result<T, E> = Ok<T> | Err<E>;

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}

export function isOk<T, E>(r: Result<T, E>): r is Ok<T> {
  return r.ok;
}

export function isErr<T, E>(r: Result<T, E>): r is Err<E> {
  return !r.ok;
}

/** Unwrap, or throw. Only for tests and for genuinely unreachable states. */
export function unwrap<T, E>(r: Result<T, E>): T {
  if (r.ok) return r.value;
  throw new Error(`unwrap() on an Err: ${JSON.stringify(r.error)}`);
}

/** A failure shape shared by every layer, so API handlers can map it uniformly. */
export type AppError = {
  code: AppErrorCode;
  message: string;
  /** Safe to show a user. Never contains keys, URLs with credentials, or stack traces. */
  detail?: string;
};

export type AppErrorCode =
  | "invalid_input"
  | "upstream_unavailable"
  | "upstream_malformed"
  | "llm_unavailable"
  | "llm_refused"
  | "not_found"
  | "persistence_failed";

export function appError(
  code: AppErrorCode,
  message: string,
  detail?: string,
): AppError {
  return detail === undefined ? { code, message } : { code, message, detail };
}

/** HTTP status for each error code, so route handlers stay one-liners. */
export function statusForError(code: AppErrorCode): number {
  switch (code) {
    case "invalid_input":
      return 400;
    case "not_found":
      return 404;
    case "llm_refused":
      return 422;
    case "upstream_unavailable":
    case "upstream_malformed":
    case "llm_unavailable":
      return 502;
    case "persistence_failed":
      return 500;
  }
}
