import { round8, type TechnicalScore } from "./technical";
import type { LlmAnalysis } from "./llm";

/**
 * Combining the deterministic and model halves of the score.
 *
 * The weighting is data, not arithmetic buried in a function body, so the
 * scoring policy can be read and argued with. The deterministic half carries
 * more weight than the model half on purpose: the indicators are reproducible
 * and the model's judgement is not.
 *
 * When the model half is missing — no API key, rate limited, refused — the
 * composite falls back to the deterministic score alone and says so. It does
 * not quietly substitute a neutral 50, which would look like a real assessment.
 */

export const COMPOSITE_WEIGHTS = {
  technical: 0.6,
  llm: 0.4,
} as const;

export type Direction = "long" | "short" | "flat";

export type CompositeScore = {
  /** 0-100. */
  score: number;
  direction: Direction;
  technical: TechnicalScore;
  llm: LlmAnalysis | null;
  /** Why the model half is absent, when it is. Shown in the UI verbatim. */
  llmUnavailableReason: string | null;
  weighting: { technical: number; llm: number };
};

/**
 * Direction when there is no model view: RSI above 50 is upward momentum,
 * below 50 downward. The 45-55 band is treated as flat rather than forcing a
 * direction out of noise.
 */
export function directionFromTechnicals(rsiValue: number): Direction {
  if (rsiValue > 55) return "long";
  if (rsiValue < 45) return "short";
  return "flat";
}

export function combineScores(
  technical: TechnicalScore,
  llm: LlmAnalysis | null,
  llmUnavailableReason: string | null = null,
): CompositeScore {
  if (!llm) {
    return {
      score: round8(technical.score),
      direction: directionFromTechnicals(technical.rsi),
      technical,
      llm: null,
      llmUnavailableReason,
      weighting: { technical: 1, llm: 0 },
    };
  }

  const score =
    technical.score * COMPOSITE_WEIGHTS.technical +
    llm.conviction * COMPOSITE_WEIGHTS.llm;

  return {
    score: round8(score),
    direction: llm.direction,
    technical,
    llm,
    llmUnavailableReason: null,
    weighting: { ...COMPOSITE_WEIGHTS },
  };
}
