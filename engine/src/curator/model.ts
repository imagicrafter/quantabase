import { allowOutboundHost } from "../http/outbound-allowlist.js";

/**
 * The curator's model: a DigitalOcean serverless inference model behind the
 * OpenAI-style chat endpoint. Which model is a database setting
 * (curator_settings.model, held to the floor measured in test A1). The key is
 * read from the vault for each run and is never logged.
 *
 * `ModelBackend` is the seam the tests mock.
 */

export const DO_INFERENCE_HOST = "inference.do-ai.run";
const CHAT_URL = `https://${DO_INFERENCE_HOST}/v1/chat/completions`;
// gpt-oss-120b is capped at 4,096 output tokens on DigitalOcean (A1 finding).
export const MAX_OUTPUT_TOKENS = 4096;
/**
 * Output tokens asked of each model by default. Reasoning models spend much
 * of their budget thinking before the JSON: at 4,096 every deepseek reply in
 * the live A/B (2026-11-21) was cut off. curator_settings.max_output_tokens
 * (0068) overrides any of these per model.
 */
export const DEFAULT_OUTPUT_LIMITS: Readonly<Record<string, number>> = {
  "openai-gpt-oss-120b": MAX_OUTPUT_TOKENS,
  "deepseek-v4.1-flash": 16384,
  "deepseek-v4-pro": 16384,
  "glm-5.3": 16384,
  "anthropic-claude-sonnet-5.5": 16384,
  "anthropic-claude-5.5-haiku": 16384,
};

/** The writer models the owner may pick (curator_settings.writer_model, 0069). */
export const WRITER_MODELS = ["anthropic-claude-sonnet-5.5", "anthropic-claude-5.5-haiku"] as const;
export const DEFAULT_WRITER = "anthropic-claude-sonnet-5.5";
/** The cheap triage model (curator_settings.triage_model). */
export const DEFAULT_TRIAGE = "openai-gpt-oss-120b";

/**
 * Anthropic models on DigitalOcean take a cache_control mark on a content
 * part (docs.digitalocean.com/products/inference/how-to/use-prompt-caching/):
 * the static system prompt is cached, so later items read it at a tenth of
 * the input price. Other models cache by themselves, or not at all.
 */
export const cachesByMark = (model: string): boolean => model.startsWith("anthropic-");
/** No request asks for more than this, whatever the settings say. */
export const OUTPUT_TOKENS_CEILING = 65536;

const clampTokens = (v: number): number => Math.max(1, Math.min(Math.floor(v), OUTPUT_TOKENS_CEILING));

/** The output tokens to ask of a model: the settings' value, else the default, else 4,096. */
export function outputLimit(model: string, overrides: Readonly<Record<string, number>> = {}): number {
  return clampTokens(overrides[model] ?? DEFAULT_OUTPUT_LIMITS[model] ?? MAX_OUTPUT_TOKENS);
}
const TIMEOUT_MS = 120_000;

export type ModelReply = {
  readonly text: string;
  readonly finish: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  /** Input tokens read from the provider's prompt cache (billed cheaply). */
  readonly cacheReadTokens?: number;
  /** Input tokens written to the prompt cache. */
  readonly cacheWriteTokens?: number;
};

export interface ModelBackend {
  complete(system: string, user: string, maxTokens?: number): Promise<ModelReply>;
  /** The output tokens a call asks for when it names none (curate.ts doubles it once on a cut-off). */
  readonly maxOutputTokens?: number;
}

export class ModelError extends Error {}

type ChatBody = {
  model: string;
  messages: Array<{ role: "system" | "user"; content: string | ReadonlyArray<Record<string, unknown>> }>;
  max_tokens: number;
  temperature: number;
  response_format?: { type: "json_object" };
};

async function post(key: string, body: ChatBody): Promise<Response> {
  return fetch(CHAT_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

function num(v: unknown): number | null {
  return typeof v === "number" ? v : null;
}

export type InferenceOptions = { readonly maxOutputTokens?: number };

/** Cache counts from a usage block, present only when the provider sent them. */
function cacheCounts(usage: Record<string, unknown>): Pick<ModelReply, "cacheReadTokens" | "cacheWriteTokens"> {
  const details = (usage["prompt_tokens_details"] ?? {}) as Record<string, unknown>;
  const read = num(usage["cache_read_input_tokens"]) ?? num(details["cached_tokens"]);
  const write = num(usage["cache_created_input_tokens"]) ?? num(usage["cache_creation_input_tokens"]);
  return { ...(read ? { cacheReadTokens: read } : {}), ...(write ? { cacheWriteTokens: write } : {}) };
}

/**
 * Uncached input tokens, so nothing is charged twice. Anthropic-style usage
 * reports cached tokens apart from prompt_tokens; OpenAI-style usage counts
 * them inside it (prompt_tokens_details.cached_tokens), so they are taken out.
 */
function uncached(prompt: number | null, c: Pick<ModelReply, "cacheReadTokens" | "cacheWriteTokens">, anthropic: boolean): number | null {
  if (prompt === null || anthropic) return prompt;
  const cached = (c.cacheReadTokens ?? 0) + (c.cacheWriteTokens ?? 0);
  return prompt >= cached ? prompt - cached : prompt;
}

/** A backend for one DigitalOcean model. JSON mode first; on HTTP 400 once without it. */
export function doInference(model: string, key: string, opts: InferenceOptions = {}): ModelBackend {
  allowOutboundHost(DO_INFERENCE_HOST);
  const limit = opts.maxOutputTokens !== undefined ? clampTokens(opts.maxOutputTokens) : outputLimit(model);
  return {
    maxOutputTokens: limit,
    async complete(system, user, maxTokens = limit) {
      const body: ChatBody = {
        model,
        messages: [
          {
            role: "system",
            content: cachesByMark(model) ? [{ type: "text", text: system, cache_control: { type: "ephemeral" } }] : system,
          },
          { role: "user", content: user },
        ],
        max_tokens: clampTokens(maxTokens),
        temperature: 0,
      };
      let res: Response;
      try {
        res = await post(key, { ...body, response_format: { type: "json_object" } });
        if (res.status === 400) res = await post(key, body);
      } catch (err) {
        throw new ModelError(`model request failed: ${err instanceof Error ? err.name : "error"}`);
      }
      if (!res.ok) throw new ModelError(`model answered HTTP ${res.status}`);
      const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      const choice = Array.isArray(data?.["choices"]) ? (data["choices"][0] as Record<string, unknown>) : null;
      const message = (choice?.["message"] ?? {}) as Record<string, unknown>;
      const usage = (data?.["usage"] ?? {}) as Record<string, unknown>;
      if (!choice) throw new ModelError("model reply had no choices");
      const cache = cacheCounts(usage);
      return {
        text: typeof message["content"] === "string" ? message["content"] : "",
        finish: typeof choice["finish_reason"] === "string" ? choice["finish_reason"] : null,
        inputTokens: uncached(num(usage["prompt_tokens"]), cache, cachesByMark(model)),
        outputTokens: num(usage["completion_tokens"]),
        ...cache,
      };
    },
  };
}
