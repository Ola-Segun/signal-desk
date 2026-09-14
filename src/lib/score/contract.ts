import { z } from "zod";

import type { Ticker } from "@/lib/market/binance";
import type { TechnicalScore } from "./technical";

/**
 * The contract every LLM provider must satisfy, and the prompt they all share.
 *
 * Keeping this provider-agnostic means swapping Claude for an OpenRouter model
 * changes which HTTP endpoint is called and nothing else — same schema, same
 * validation, same prompt, so the two are genuinely comparable.
 */

/** JSON Schema sent to the provider to constrain generation. */
export const ANALYSIS_JSON_SCHEMA = {
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

/**
 * The same contract enforced again on arrival. The schema constraint is what
 * the provider promises; this is the guard for when that promise is broken —
 * and on free models it regularly is.
 */
export const analysisSchema = z.object({
  conviction: z.number().int().min(0).max(100),
  direction: z.enum(["long", "short", "flat"]),
  rationale: z.string().trim().min(20),
  risks: z.array(z.string().trim().min(1)),
  confidence: z.enum(["low", "medium", "high"]),
});

export type LlmAnalysis = z.infer<typeof analysisSchema>;

export const SYSTEM_PROMPT = `You are a market analyst inside a research tool. You assess a single instrument from a fixed set of supplied indicators and return a structured judgement.

Rules:
- Reason only from the numbers supplied. You have no other market data, no news, and no price history beyond what is given.
- "conviction" is the strength of the setup, not a probability and not a recommendation.
- Set conviction consistently with your rationale. Do not write an encouraging rationale and then return a low number, or the reverse.
- If the indicators conflict or are unremarkable, say so: use direction "flat", low conviction, and explain why. A confident answer from weak evidence is worse than an honest "nothing here".
- Reference the actual figures in your rationale rather than describing them in general terms.
- Never suggest a position size, an entry, a stop, or an order. Sizing and routing happen elsewhere in the system and are not your responsibility.
- This is a simulation tool for demonstration. It does not place orders and does not give financial advice.
- Respond with JSON only. No prose outside the JSON object, and no markdown fences.`;

/**
 * Build the user turn.
 *
 * **The deterministic composite is deliberately NOT included.**
 *
 * It used to be, and measurement showed the model was anchoring hard on it.
 * Holding the indicators constant and varying only the supplied composite
 * moved the model's own conviction almost in lockstep:
 *
 *   composite 58.3 -> conviction 58, 61
 *   composite 12.0 -> conviction 24, 18
 *   composite 94.0 -> conviction 84, 82   (and direction flipped to "long")
 *   composite omitted -> conviction 56, 61
 *
 * So the "model half" of the score was largely a restatement of the
 * deterministic half. Blending them 60/40 then double-counted one signal while
 * presenting it as two independent opinions — which is worse than not having
 * the model at all, because it looks like corroboration.
 *
 * The model now sees the same evidence the indicators are computed from, and
 * forms its own view. The two halves can disagree, which is the only way the
 * blend means anything.
 */
export function buildUserPrompt(
  ticker: Ticker,
  technical: TechnicalScore,
): string {
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
    "",
    "Assess this setup.",
  ].join("\n");
}

/**
 * Pull a JSON object out of a model response.
 *
 * Free models return JSON wrapped in markdown fences, prefixed with prose, or
 * with a stray leading brace (`{ {"a": 1}`) when generation is truncated and
 * restarted. Each of those was observed during provider testing, so each is
 * handled rather than assumed away.
 */
export function extractJson(text: string): unknown {
  if (!text) return undefined;

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced?.[1] ?? text;

  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return undefined;

  const candidate = body.slice(start, end + 1);

  try {
    return JSON.parse(candidate);
  } catch {
    // Tolerate a doubled opening brace from an interrupted generation.
    try {
      return JSON.parse(candidate.replace(/^\{\s*(?=\{)/, ""));
    } catch {
      return undefined;
    }
  }
}
