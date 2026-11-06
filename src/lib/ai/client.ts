/**
 * Minimal client for any OpenAI-compatible chat-completions endpoint (OpenAI, Groq, Mistral, OpenRouter,
 * Gemini's compatibility endpoint, self-hosted vLLM or Ollama). Classification is a tiny task, so the
 * cheapest model the provider offers is enough. Configured with AI_BASE_URL, AI_API_KEY and AI_MODEL.
 *
 * The response is always parsed against a schema before use: event titles are untrusted text, and a model
 * can only ever answer with ids from the list it was given.
 */
import type { z } from "zod";

const DEFAULT_TIMEOUT_MS = 25_000;

export function aiConfigured() {
  return !!(process.env.AI_API_KEY && process.env.AI_MODEL);
}

export const AI_PROVIDER_NAME = process.env.AI_PROVIDER_NAME || "the configured AI provider";

function config() {
  const key = process.env.AI_API_KEY;
  const model = process.env.AI_MODEL;
  if (!key || !model) throw new Error("AI_API_KEY / AI_MODEL are not set");
  return { key, model, baseUrl: (process.env.AI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "") };
}

export type Usage = { inputTokens: number; outputTokens: number };

/**
 * Extra request fields that pin down where the data may go. On OpenRouter: only providers that don't
 * collect or train on data, and only the model's own vendor (for OpenAI models, OpenAI itself or Microsoft's
 * Azure OpenAI Service, which hosts the same models under the same no-training terms). Other endpoints get
 * nothing extra, since OpenAI-style APIs reject unknown fields. AI_ROUTE_PROVIDERS overrides the list.
 */
export function routingFor(baseUrl: string, model: string): Record<string, unknown> {
  let host = "";
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    return {};
  }
  if (host !== "openrouter.ai") return {};
  const vendor = model.split("/")[0];
  const defaults = vendor === "openai" ? "openai,azure" : vendor;
  const only = (process.env.AI_ROUTE_PROVIDERS ?? defaults).split(",").map((s) => s.trim()).filter(Boolean);
  return { provider: { data_collection: "deny", ...(only.length ? { only } : {}) } };
}

type Completion = {
  choices?: { message?: { content?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
};

async function complete(body: Record<string, unknown>, timeoutMs: number): Promise<{ status: number; data: Completion }> {
  const { key, baseUrl } = config();
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    // The two X- headers are OpenRouter's optional app attribution; other providers ignore them.
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "HTTP-Referer": "https://midore.app", "X-Title": "Midore" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let data: Completion = {};
  try {
    data = text ? (JSON.parse(text) as Completion) : {};
  } catch {
    data = { error: { message: text.slice(0, 200) } };
  }
  return { status: res.status, data };
}

/**
 * Ask for JSON matching `schema`. Tries the provider's JSON-schema mode first; providers that don't
 * support it fall back to plain JSON mode with the schema spelled out in the prompt.
 */
export async function completeJson<T>(opts: {
  name: string;
  schema: z.ZodType<T>;
  jsonSchema: Record<string, unknown>;
  system: string;
  user: string;
  maxTokens: number;
  timeoutMs?: number;
}): Promise<{ data: T; usage: Usage }> {
  const { model } = config();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const base = {
    model,
    ...routingFor(config().baseUrl, model),
    temperature: 0,
    max_tokens: opts.maxTokens,
    messages: [
      { role: "system", content: opts.system },
      { role: "user", content: opts.user },
    ],
  };
  let { status, data } = await complete({
    ...base,
    response_format: { type: "json_schema", json_schema: { name: opts.name, schema: opts.jsonSchema, strict: true } },
  }, timeoutMs);
  if (status === 400) {
    ({ status, data } = await complete({
      ...base,
      messages: [
        { role: "system", content: `${opts.system}\n\nAnswer with JSON only, matching this JSON schema:\n${JSON.stringify(opts.jsonSchema)}` },
        { role: "user", content: opts.user },
      ],
      response_format: { type: "json_object" },
    }, timeoutMs));
  }
  // Gateways can answer 200 with an error body (e.g. the upstream provider is unavailable).
  if (status >= 300 || data.error) throw new Error(`AI provider ${data.error ? "error" : status}: ${data.error?.message ?? "request failed"}`);
  const content = data.choices?.[0]?.message?.content ?? "";
  const json = content.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("AI provider returned something other than JSON");
  }
  const result = opts.schema.safeParse(parsed);
  if (!result.success) throw new Error(`AI answer did not match the expected shape: ${result.error.issues[0]?.message ?? "invalid"}`);
  return {
    data: result.data,
    usage: { inputTokens: data.usage?.prompt_tokens ?? 0, outputTokens: data.usage?.completion_tokens ?? 0 },
  };
}

// --- Chat with tools (Dori) -------------------------------------------------------------------------------

export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
/** Parts of a user message with attachments (OpenAI-style; OpenRouter passes files through). */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "file"; file: { filename: string; file_data: string } };
export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | ContentPart[] }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };
export type ToolDef = { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } };

type ChatCompletion = {
  choices?: { message?: { content?: string | null; tool_calls?: ToolCall[] } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
};

/** The model Dori uses: DORI_MODEL if set, else the categorisation model. */
export function doriModel() {
  return process.env.DORI_MODEL || process.env.AI_MODEL || "";
}

/**
 * How hard a reasoning model thinks before answering. Dori's tool calls are routine, and long thinking made
 * turns slow, so the default is "low". DORI_REASONING=medium|high|minimal changes it. Sent in each provider's
 * own form; providers without the setting get nothing extra.
 */
function reasoningFor(baseUrl: string): Record<string, unknown> {
  const effort = process.env.DORI_REASONING || "low";
  if (effort === "default") return {};
  let host = "";
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    return {};
  }
  if (host === "openrouter.ai") return { reasoning: { effort } };
  if (host === "api.openai.com") return { reasoning_effort: effort };
  return {};
}

/** One chat-completions round with tools. The caller runs any tool calls and calls again with the results. */
export async function chatWithTools(opts: { messages: ChatMessage[]; tools: ToolDef[]; maxTokens: number; timeoutMs?: number }): Promise<{ message: { content: string | null; tool_calls?: ToolCall[] }; usage: Usage }> {
  const { key, baseUrl } = config();
  const model = doriModel();
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "HTTP-Referer": "https://midore.app", "X-Title": "Midore" },
    body: JSON.stringify({ model, ...routingFor(baseUrl, model), ...reasoningFor(baseUrl), max_tokens: opts.maxTokens, messages: opts.messages, tools: opts.tools, tool_choice: "auto", parallel_tool_calls: true }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
  });
  const text = await res.text();
  let data: ChatCompletion = {};
  try {
    data = text ? (JSON.parse(text) as ChatCompletion) : {};
  } catch {
    data = { error: { message: text.slice(0, 200) } };
  }
  if (!res.ok || data.error) throw new Error(`AI provider ${data.error ? "error" : res.status}: ${data.error?.message ?? "request failed"}`);
  const message = data.choices?.[0]?.message ?? { content: "" };
  return { message: { content: message.content ?? null, tool_calls: message.tool_calls }, usage: { inputTokens: data.usage?.prompt_tokens ?? 0, outputTokens: data.usage?.completion_tokens ?? 0 } };
}
