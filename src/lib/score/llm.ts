import "server-only";

import { llmProvider } from "@/lib/env";
import { appError, err, type AppError, type Result } from "@/lib/result";
import type { Ticker } from "@/lib/market/binance";
import type { TechnicalScore } from "./technical";
import { scoreWithAnthropic } from "./providers/anthropic";
import { scoreWithOpenRouter, type LlmSuccess } from "./providers/openrouter";

/**
 * Provider selection for the model half of the score.
 *
 * Both providers implement the same contract — same prompt, same JSON schema,
 * same Zod validation on arrival — so which one runs is a deployment decision,
 * not an architectural one.
 */

export type { LlmSuccess };
export type LlmScoreResult = LlmSuccess;

export async function scoreWithLlm(
  ticker: Ticker,
  technical: TechnicalScore,
): Promise<Result<LlmScoreResult, AppError>> {
  switch (llmProvider()) {
    case "openrouter":
      return scoreWithOpenRouter(ticker, technical);
    case "anthropic":
      return scoreWithAnthropic(ticker, technical);
    default:
      return err(
        appError(
          "llm_unavailable",
          "Model scoring is not configured.",
          "Set OPENROUTER_API_KEY (free tier available) or ANTHROPIC_API_KEY.",
        ),
      );
  }
}

export type { LlmAnalysis } from "./contract";
