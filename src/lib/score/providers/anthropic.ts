import "server-only";

import Anthropic from "@anthropic-ai/sdk";

import { anthropicApiKey } from "@/lib/env";
import { appError, err, ok, type AppError, type Result } from "@/lib/result";
import type { Ticker } from "@/lib/market/binance";
import type { TechnicalScore } from "../technical";
import {
  ANALYSIS_JSON_SCHEMA,
  SYSTEM_PROMPT,
  analysisSchema,
  buildUserPrompt,
  extractJson,
} from "../contract";
import type { LlmSuccess } from "./openrouter";

/**
 * Anthropic provider — used when ANTHROPIC_API_KEY is set and OpenRouter is
 * not, or when LLM_PROVIDER=anthropic forces it.
 *
 * Kept alongside the OpenRouter provider so the two are directly comparable:
 * identical prompt, identical schema, identical validation. The only thing
 * that differs is the transport.
 */

export const MODEL = "claude-opus-5";

let client: Anthropic | undefined;

function anthropic(apiKey: string): Anthropic {
  if (!client) client = new Anthropic({ apiKey, maxRetries: 2 });
  return client;
}

export async function scoreWithAnthropic(
  ticker: Ticker,
  technical: TechnicalScore,
): Promise<Result<LlmSuccess, AppError>> {
  const apiKey = anthropicApiKey();
  if (!apiKey) {
    return err(
      appError(
        "llm_unavailable",
        "Anthropic scoring is not configured.",
        "Set ANTHROPIC_API_KEY to enable the model half of the score.",
      ),
    );
  }

  let response: Anthropic.Message;
  try {
    response = await anthropic(apiKey).messages.create({
      model: MODEL,
      max_tokens: 2048,
      thinking: { type: "adaptive" },
      output_config: {
        effort: "medium",
        format: { type: "json_schema", schema: ANALYSIS_JSON_SCHEMA },
      },
      system: [
        {
          type: "text",
          text: SYSTEM_PROMPT,
          // Stable across every request, so it sits before the cache
          // breakpoint; the volatile per-symbol data goes in the user turn.
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: buildUserPrompt(ticker, technical) }],
    });
  } catch (cause) {
    if (cause instanceof Anthropic.RateLimitError) {
      return err(
        appError("llm_unavailable", "Rate limited by the model API. Try again shortly."),
      );
    }
    if (cause instanceof Anthropic.APIError) {
      return err(
        appError("llm_unavailable", "The model API returned an error.", `HTTP ${cause.status}`),
      );
    }
    return err(
      appError(
        "llm_unavailable",
        "Could not reach the model API.",
        cause instanceof Error ? cause.message.slice(0, 200) : String(cause),
      ),
    );
  }

  // Checked before `content` is touched — a refusal can carry no content.
  if (response.stop_reason === "refusal") {
    return err(
      appError(
        "llm_refused",
        "The model declined to analyse this instrument.",
        response.stop_details?.category ?? undefined,
      ),
    );
  }

  if (response.stop_reason === "max_tokens") {
    return err(
      appError(
        "upstream_malformed",
        "The model response was truncated before it produced complete JSON.",
      ),
    );
  }

  const textBlock = response.content.find(
    (block): block is Anthropic.TextBlock => block.type === "text",
  );
  if (!textBlock) {
    return err(appError("upstream_malformed", "The model returned no text content."));
  }

  const parsed = extractJson(textBlock.text);
  if (parsed === undefined) {
    return err(
      appError(
        "upstream_malformed",
        "The model response was not valid JSON despite the schema constraint.",
      ),
    );
  }

  const validated = analysisSchema.safeParse(parsed);
  if (!validated.success) {
    return err(
      appError(
        "upstream_malformed",
        "The model response did not match the expected shape.",
        validated.error.issues[0]?.message,
      ),
    );
  }

  return ok({ analysis: validated.data, model: response.model, attempts: [] });
}
