import "server-only";

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

import { anthropicApiKey } from "@/lib/env";
import { appError, err, ok, type AppError, type Result } from "@/lib/result";
import type { Ticker } from "@/lib/market/binance";
import type { TechnicalScore } from "./technical";

/**
 * SCORE (model half) — a Claude analysis constrained to a JSON schema.
 *
 * Three deliberate choices:
 *
 *  1. **Structured output, not prose parsing.** The response is constrained by
 *     `output_config.format` to a JSON schema, then re-validated with Zod on
 *     arrival. The API constraint is the contract; the Zod parse is the guard
 *     for when the contract is wrong. Free-text parsing is not used anywhere.
 *
 *  2. **`stop_reason` is checked before `content` is read.** A refusal returns
 *     HTTP 200 with an empty or partial content array, so indexing
 *     `content[0]` first is a latent crash. It is handled as a typed outcome.
 *
 *  3. **The model scores; it does not size or route.** Everything downstream of
 *     this file is deterministic and unit-tested. An LLM belongs in the
 *     judgement step, not in the execution path.
 */

export const MODEL = "claude-opus-5";

// --- Output contract ------------------------------------------------------

/** The schema sent to the API. */
const analysisJsonSchema = {
  type: "object",
  properties: {
    conviction: {
      type: "integer",
      description: "Strength of the setup, 0 (none) to 100 (very strong).",
    },
    direction: {
      type: "string",
      enum: ["long", "short", "flat"],
      description: "Directional bias implied by the data.",
    },
    rationale: {
      type: "string",
      description:
        "Two or three sentences explaining the reasoning, referencing the specific numbers supplied.",
    },
    risks: {
      type: "array",
      items: { type: "string" },
      description: "Concrete risks that would invalidate this view.",
    },
    confidence: {
      type: "string",
      enum: ["low", "medium", "high"],
      description: "Confidence in the assessment given only the supplied data.",
    },
  },
  required: ["conviction", "direction", "rationale", "risks", "confidence"],
  additionalProperties: false,
} as const;

/** The same contract, enforced again on the way in. */
const analysisSchema = z.object({
  conviction: z.number().int().min(0).max(100),
  direction: z.enum(["long", "short", "flat"]),
  rationale: z.string().min(1),
  risks: z.array(z.string()),
  confidence: z.enum(["low", "medium", "high"]),
});

export type LlmAnalysis = z.infer<typeof analysisSchema>;

// --- Prompt ---------------------------------------------------------------

/**
 * Stable across every request, so it sits before the cache breakpoint and is
 * billed at cache-read rates after the first call. The volatile per-symbol data
 * goes in the user turn, after the breakpoint.
 */
const SYSTEM_PROMPT = `You are a market analyst inside a research tool. You assess a single instrument from a fixed set of supplied indicators and return a structured judgement.

Rules:
- Reason only from the numbers supplied. You have no other market data, no news, and no price history beyond what is given.
- "conviction" is the strength of the setup, not a probability and not a recommendation.
- If the indicators conflict or are unremarkable, say so: use direction "flat", low conviction, and explain why. A confident answer from weak evidence is worse than an honest "nothing here".
- Reference the actual figures in your rationale rather than describing them in general terms.
- Never suggest a position size, an entry, a stop, or an order. Sizing and routing happen elsewhere in the system and are not your responsibility.
- This is a simulation tool for demonstration. It does not place orders and does not give financial advice.`;

function buildUserPrompt(ticker: Ticker, technical: TechnicalScore): string {
  return [
    `Instrument: ${ticker.symbol}`,
    "",
    "Market (last 24h):",
    `- Last price: ${ticker.price}`,
    `- Change: ${ticker.changePercent24h.toFixed(2)}%`,
    `- Quote volume: ${Math.round(ticker.quoteVolume24h).toLocaleString("en-US")}`,
    `- High / low: ${ticker.high24h} / ${ticker.low24h}`,
    "",
    "Computed indicators:",
    `- RSI(14): ${technical.rsi.toFixed(2)}`,
    `- Realised volatility (daily): ${(technical.volatility * 100).toFixed(2)}%`,
    `- Volume vs 24-candle average: ${technical.volumeRatio.toFixed(2)}x`,
    `- Deterministic composite: ${technical.score.toFixed(1)}/100`,
    "",
    "Assess this setup.",
  ].join("\n");
}

// --- Client ---------------------------------------------------------------

let client: Anthropic | undefined;

function anthropic(apiKey: string): Anthropic {
  if (!client) client = new Anthropic({ apiKey, maxRetries: 2 });
  return client;
}

export type LlmScoreResult = {
  analysis: LlmAnalysis;
  model: string;
};

/**
 * Score one instrument.
 *
 * Returns `llm_unavailable` rather than throwing when no API key is configured,
 * so the application degrades to deterministic-only scoring instead of failing.
 */
export async function scoreWithLlm(
  ticker: Ticker,
  technical: TechnicalScore,
): Promise<Result<LlmScoreResult, AppError>> {
  const apiKey = anthropicApiKey();
  if (!apiKey) {
    return err(
      appError(
        "llm_unavailable",
        "LLM scoring is not configured.",
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
        format: { type: "json_schema", schema: analysisJsonSchema },
      },
      system: [
        {
          type: "text",
          text: SYSTEM_PROMPT,
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
        cause instanceof Error ? cause.message : String(cause),
      ),
    );
  }

  // Checked before `content` is touched — a refusal can carry no content at all.
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
    return err(
      appError("upstream_malformed", "The model returned no text content."),
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(textBlock.text);
  } catch {
    return err(
      appError(
        "upstream_malformed",
        "The model response was not valid JSON despite the schema constraint.",
      ),
    );
  }

  const parsed = analysisSchema.safeParse(raw);
  if (!parsed.success) {
    return err(
      appError(
        "upstream_malformed",
        "The model response did not match the expected shape.",
        parsed.error.issues[0]?.message,
      ),
    );
  }

  return ok({ analysis: parsed.data, model: response.model });
}
