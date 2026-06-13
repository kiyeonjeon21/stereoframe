import { describe, expect, test } from "bun:test";
import { getLLMProvider } from "../src/llm";

describe("getLLMProvider", () => {
  test("defaults to openai", () => {
    const p = getLLMProvider();
    expect(p.name).toBe("openai");
    expect(p.defaultModel).toMatch(/gpt/);
  });
  test("returns anthropic when asked", () => {
    const p = getLLMProvider("anthropic");
    expect(p.name).toBe("anthropic");
    expect(p.defaultModel).toMatch(/claude/);
  });
  test("rejects unknown providers", () => {
    expect(() => getLLMProvider("gemini")).toThrow(/unknown llm provider/);
  });
});
