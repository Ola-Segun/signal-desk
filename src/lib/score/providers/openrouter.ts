import "server-only";

import { openRouterApiKey, openRouterModels } from "@/lib/env";
import { appError, err, ok, type AppError, type Result } from "@/lib/result";
import type { Ticker } from "@/lib/market/binance";
import type { TechnicalScore } from "../technical";
import {
  ANALYSIS_JSON_SCHEMA,
  SYSTEM_PROMPT,
  analysisSchema,
  buildUserPrompt,
  extractJson,
  type LlmAnalysis,
} from "../contract";

/**
 * OpenRouter provider, running on free models.
 *
 * Free models are individually unreliable in ways paid ones usually are not,
 * and the handling here is shaped by measurement rather than by guesswork.
 * Across repeated runs of the real scoring prompt:
 *
 *   nex-agi/nex-n2.5-pro          2/2 valid
 *   nvidia/nemotron-3-super-120b  1/2 valid  (truncated mid-JSON once)
 *   dots-studio/dots-3-note       1/2 valid  (returned an empty risks array)
 *   google/gemma-4-*              0/2        (provider error)
 *   thinkingmachines/inkling      unavailable outside agentic harnesses
 *
 * The dominant failure is `finish_reason: "length"`: these are reasoning
 * models, and a long reasoning pass can exhaust the token budget before any
 * content is emitted, truncating the JSON. Hence a generous `max_tokens` and
 * a chain rather than a single model — a ~50-100% per-model success rate
 * composes into something dependable when three are tried in order.
 */

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

/**
 * Ordered by measured reliability on this task, best first. Versioned with the
 * code because the fallback logic and these specific models' failure modes
 * were established together.
 */
export const DEFAULT_MODEL_CHAIN = [
  "nex-agi/nex-n2.5-pro:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
  "dots-studio/dots-3-note-preview:free",
] as const;

/**
 * Reasoning can consume thousands of tokens before the answer starts. 6000 was
 * enough for every successful run observed; 1200 truncated repeatedly.
 */
const MAX_TOKENS = 6000;
const REQUEST_TIMEOUT_MS = 60_000;

export type LlmSuccess = {
  analysis: LlmAnalysis;
  model: string;
  /** Models tried and rejected before this one succeeded. */
  attempts: string[];
};

type AttemptOutcome =
  | { kind: "ok"; analysis: LlmAnalysis }
  | { kind: "retryable"; why: string }
  | { kind: "fatal"; why: string };

async function attempt(
  model: string,
  apiKey: string,
  userPrompt: string,
): Promise<AttemptOutcome> {
  let response: Response;
  try {
    response = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        // OpenRouter uses these for attribution on its rankings.
        "HTTP-Referer": "https://github.com/Ola-Segun/signal-desk",
        "X-Title": "Signal Desk",
      },
      body: JSON.stringify({
        model,
        max_tokens: MAX_TOKENS,
        // Deterministic given the same inputs, so two identical runs of the
        // pipeline produce the same audit row.
        temperature: 0,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "analysis",
            strict: true,
            schema: ANALYSIS_JSON_SCHEMA,
          },
        },
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (cause) {
    const why = cause instanceof Error ? cause.message : String(cause);
    return { kind: "retryable", why: `request failed: ${why.slice(0, 120)}` };
  }

  if (response.status === 401 || response.status === 403) {
    // A bad key will fail identically on every model — do not burn the chain.
    return { kind: "fatal", why: "OpenRouter rejected the API key." };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { kind: "retryable", why: "response was not JSON" };
  }

  const body = payload as {
    error?: { message?: string };
    choices?: Array<{
      finish_reason?: string;
      message?: { content?: string };
    }>;
  };

  if (body.error) {
    return {
      kind: "retryable",
      why: `provider error: ${(body.error.message ?? "unknown").slice(0, 120)}`,
    };
  }

  const choice = body.choices?.[0];
  if (!choice) return { kind: "retryable", why: "no choices returned" };

  if (choice.finish_reason === "length") {
    // Reasoning ate the budget. Another model may be terser.
    return { kind: "retryable", why: "response truncated before the JSON closed" };
  }

  const parsed = extractJson(choice.message?.content ?? "");
  if (parsed === undefined) {
    return { kind: "retryable", why: "no parseable JSON in the response" };
  }

  const validated = analysisSchema.safeParse(parsed);
  if (!validated.success) {
    const issue = validated.error.issues[0];
    return {
      kind: "retryable",
      why: `schema mismatch: ${issue ? `${issue.path.join(".")} ${issue.message}` : "unknown"}`,
    };
  }

  return { kind: "ok", analysis: validated.data };
}

export async function scoreWithOpenRouter(
  ticker: Ticker,
  technical: TechnicalScore,
): Promise<Result<LlmSuccess, AppError>> {
  const apiKey = openRouterApiKey();
  if (!apiKey) {
    return err(
      appError(
        "llm_unavailable",
        "OpenRouter scoring is not configured.",
        "Set OPENROUTER_API_KEY to enable the model half of the score.",
      ),
    );
  }

  const chain = openRouterModels() ?? [...DEFAULT_MODEL_CHAIN];
  const userPrompt = buildUserPrompt(ticker, technical);
  const attempts: string[] = [];
  const failures: string[] = [];

  for (const model of chain) {
    const outcome = await attempt(model, apiKey, userPrompt);

    if (outcome.kind === "ok") {
      return ok({ analysis: outcome.analysis, model, attempts });
    }

    if (outcome.kind === "fatal") {
      return err(appError("llm_unavailable", outcome.why));
    }

    attempts.push(model);
    failures.push(`${model}: ${outcome.why}`);
  }

  return err(
    appError(
      "llm_unavailable",
      `All ${chain.length} configured models failed to return a valid analysis.`,
      failures.join(" | ").slice(0, 400),
    ),
  );
}
