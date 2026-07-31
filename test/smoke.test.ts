import { describe, expect, test } from "bun:test";

import { canonicalModelName, parseDuration } from "../src/core";
import { convertClaudeMessagesRequestToOpenAI } from "../src/requests/anthropic";

describe("core utilities", () => {
  test("parses configured durations", () => {
    expect(parseDuration("15m")).toBe(900000);
    expect(parseDuration("2h")).toBe(7200000);
  });

  test("resolves model aliases", () => {
    expect(canonicalModelName("minimax-m2.7")).toBe("minimax/minimax-m2.7");
  });
});

describe("Anthropic conversion", () => {
  test("converts system and user messages", () => {
    const result = convertClaudeMessagesRequestToOpenAI(
      JSON.stringify({
        model: "minimax-m2.7",
        max_tokens: 32,
        system: "Be concise",
        messages: [{ role: "user", content: "Hello" }],
      }),
    );

    expect(result.payload.messages).toEqual([
      { role: "system", content: "Be concise" },
      { role: "user", content: "Hello" },
    ]);
    expect(result.modelName).toBe("minimax-m2.7");
  });
});
