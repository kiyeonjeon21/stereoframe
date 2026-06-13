/**
 * LLM provider seam for the directing layer (`brief`). Default OpenAI (the key is
 * commonly present); Anthropic is a drop-in. Both take the same chat messages and
 * return the assistant's text — the brief layer parses JSON out of it (with a
 * repair round), so neither needs a hard JSON mode.
 */
import { resolveEnvKey } from "./gen";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMProvider {
  name: string;
  defaultModel: string;
  chat(messages: ChatMessage[], opts: { projectDir: string; key?: string; model?: string }): Promise<string>;
}

const openaiProvider: LLMProvider = {
  name: "openai",
  defaultModel: "gpt-4o",
  async chat(messages, opts) {
    const key = resolveEnvKey("OPENAI_API_KEY", opts.projectDir, opts.key);
    if (!key) throw new Error("no OPENAI_API_KEY (shell or project .env), or pass --llm-key.");
    const model = opts.model ?? process.env.OPENAI_MODEL ?? this.defaultModel;
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages, temperature: 0.8, response_format: { type: "json_object" } }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${text.slice(0, 400)}`);
    const content = JSON.parse(text).choices?.[0]?.message?.content;
    if (!content) throw new Error("OpenAI returned no content");
    return content;
  },
};

const anthropicProvider: LLMProvider = {
  name: "anthropic",
  defaultModel: "claude-sonnet-4-6",
  async chat(messages, opts) {
    const key = resolveEnvKey("ANTHROPIC_API_KEY", opts.projectDir, opts.key);
    if (!key) throw new Error("no ANTHROPIC_API_KEY (shell or project .env), or pass --llm-key.");
    const model = opts.model ?? process.env.ANTHROPIC_MODEL ?? this.defaultModel;
    // Anthropic separates the system prompt from the message turns.
    const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
    const turns = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content }));
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: 4096, system, messages: turns }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${text.slice(0, 400)}`);
    const blocks = JSON.parse(text).content as Array<{ type: string; text?: string }> | undefined;
    const content = blocks?.find((b) => b.type === "text")?.text;
    if (!content) throw new Error("Anthropic returned no content");
    return content;
  },
};

export function getLLMProvider(name = "openai"): LLMProvider {
  if (name === "openai") return openaiProvider;
  if (name === "anthropic") return anthropicProvider;
  throw new Error(`unknown llm provider "${name}" (available: openai, anthropic)`);
}
