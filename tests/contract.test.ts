import { describe, expect, it } from "vitest";

import {
  ANALYSIS_JSON_SCHEMA,
  analysisSchema,
  buildUserPrompt,
  extractJson,
} from "@/lib/score/contract";
import { DEFAULT_MODEL_CHAIN } from "@/lib/score/providers/openrouter";
import type { Ticker } from "@/lib/market/binance";
import type { TechnicalScore } from "@/lib/score/technical";

const ticker: Ticker = {
  symbol: "BTCUSDT",
  price: 77776.01,
  changePercent24h: 1.31,
  quoteVolume24h: 778_668_256,
  high24h: 77999.99,
  low24h: 76388.72,
};

const technical: TechnicalScore = {
  score: 58.3,
  rsi: 60.93,
  volatility: 0.0167,
  volumeRatio: 1.06,
  components: { momentum: 60.93, volatility: 86.1, participation: 35.29 },
};

describe("buildUserPrompt — anchoring regression", () => {
  /**
   * The deterministic composite must never reach the model.
   *
   * It did originally, and measurement showed the model tracked it almost
   * linearly — holding the indicators constant and changing only the supplied
   * composite moved the model's own conviction with it:
   *
   *   composite 58.3 -> conviction 58, 61
   *   composite 12.0 -> conviction 24, 18
   *   composite 94.0 -> conviction 84, 82  (direction flipped to "long")
   *   composite omitted -> conviction 56, 61
   *
   * With the composite present the "model half" was largely a restatement of
   * the deterministic half, so blending them 60/40 double-counted one signal
   * while presenting it as corroboration. These assertions exist so that a
   * well-meaning "give the model more context" change cannot silently
   * reintroduce it.
   */
  const prompt = buildUserPrompt(ticker, technical);

  it("does not mention the composite score", () => {
    expect(prompt).not.toMatch(/composite/i);
    expect(prompt).not.toContain("58.3");
  });

  it("does not leak the weighted component breakdown", () => {
    expect(prompt).not.toMatch(/momentum/i);
    expect(prompt).not.toMatch(/participation/i);
  });

  it("still supplies the raw evidence the indicators are computed from", () => {
    // The model should see what the indicators saw — just not the conclusion.
    expect(prompt).toContain("60.93"); // RSI
    expect(prompt).toContain("1.06x"); // volume ratio
    expect(prompt).toContain("1.67%"); // volatility
    expect(prompt).toContain("BTCUSDT");
    expect(prompt).toContain("77776.01");
  });
});

describe("extractJson", () => {
  const valid = '{"conviction":58,"direction":"flat"}';

  it("parses a bare JSON object", () => {
    expect(extractJson(valid)).toEqual({ conviction: 58, direction: "flat" });
  });

  it("unwraps a markdown fence", () => {
    // Observed from free models despite an explicit "no markdown" instruction.
    expect(extractJson("```json\n" + valid + "\n```")).toEqual({
      conviction: 58,
      direction: "flat",
    });
  });

  it("unwraps an unlabelled fence", () => {
    expect(extractJson("```\n" + valid + "\n```")).toEqual({
      conviction: 58,
      direction: "flat",
    });
  });

  it("ignores prose around the object", () => {
    expect(extractJson(`Here is my analysis:\n${valid}\nHope that helps.`)).toEqual({
      conviction: 58,
      direction: "flat",
    });
  });

  it("tolerates a doubled opening brace from an interrupted generation", () => {
    // nvidia/nemotron-3-super emitted exactly this when truncated.
    expect(extractJson(`{ ${valid}`)).toEqual({
      conviction: 58,
      direction: "flat",
    });
  });

  it("returns undefined rather than throwing on unparseable input", () => {
    expect(extractJson("")).toBeUndefined();
    expect(extractJson("no json here at all")).toBeUndefined();
    expect(extractJson('{"truncated": ')).toBeUndefined();
  });
});

describe("analysisSchema", () => {
  const good = {
    conviction: 58,
    direction: "flat" as const,
    rationale: "RSI is mid-range and volume is unremarkable, so there is no edge here.",
    risks: ["A volume spike could invalidate this."],
    confidence: "low" as const,
  };

  it("accepts a well-formed analysis", () => {
    expect(analysisSchema.safeParse(good).success).toBe(true);
  });

  it("rejects a conviction outside 0-100", () => {
    expect(analysisSchema.safeParse({ ...good, conviction: 101 }).success).toBe(false);
    expect(analysisSchema.safeParse({ ...good, conviction: -1 }).success).toBe(false);
  });

  it("rejects a non-integer conviction", () => {
    expect(analysisSchema.safeParse({ ...good, conviction: 58.5 }).success).toBe(false);
  });

  it("rejects an unknown direction", () => {
    expect(analysisSchema.safeParse({ ...good, direction: "sideways" }).success).toBe(
      false,
    );
  });

  it("rejects an empty or stub rationale", () => {
    // A free model returned `"rationale": ""` while still satisfying the
    // provider's own schema check, so the length floor is load-bearing.
    expect(analysisSchema.safeParse({ ...good, rationale: "" }).success).toBe(false);
    expect(analysisSchema.safeParse({ ...good, rationale: "ok" }).success).toBe(false);
  });

  it("rejects risks that are not strings", () => {
    expect(analysisSchema.safeParse({ ...good, risks: [null] }).success).toBe(false);
  });
});

describe("ANALYSIS_JSON_SCHEMA", () => {
  it("forbids additional properties", () => {
    expect(ANALYSIS_JSON_SCHEMA.additionalProperties).toBe(false);
  });

  it("requires every field the Zod schema requires", () => {
    // The two must not drift: the JSON Schema constrains generation, the Zod
    // schema validates arrival. A field required by one and not the other is
    // a gap.
    expect([...ANALYSIS_JSON_SCHEMA.required].sort()).toEqual(
      Object.keys(analysisSchema.shape).sort(),
    );
  });
});

describe("DEFAULT_MODEL_CHAIN", () => {
  it("has more than one model so a single failure is survivable", () => {
    // Free models measured at roughly 50-100% individual success on this task;
    // the chain is what makes that dependable.
    expect(DEFAULT_MODEL_CHAIN.length).toBeGreaterThan(1);
  });

  it("contains no duplicates", () => {
    expect(new Set(DEFAULT_MODEL_CHAIN).size).toBe(DEFAULT_MODEL_CHAIN.length);
  });

  it("uses only free model slugs", () => {
    // A paid slug slipping in would silently start charging.
    for (const model of DEFAULT_MODEL_CHAIN) {
      expect(model).toMatch(/:free$/);
    }
  });
});
