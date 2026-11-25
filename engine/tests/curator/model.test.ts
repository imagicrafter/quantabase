import { afterEach, describe, expect, it, vi } from "vitest";
import { OUTPUT_TOKENS_CEILING, ModelError, doInference } from "../../src/curator/model.js";
import { keyPrefix, loadTemplates } from "../../src/entities/templates.js";

const ok = (content: string, finish = "stop") =>
  new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200 });

afterEach(() => vi.unstubAllGlobals());

describe("doInference (DigitalOcean serverless inference)", () => {
  it("posts the chat in JSON mode with the bearer key and the model from settings", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok('{"updates":[]}'));
    vi.stubGlobal("fetch", fetchMock);
    const reply = await doInference("deepseek-v4.1-flash", "k-123").complete("sys", "user", 99999);
    expect(reply).toEqual({ text: '{"updates":[]}', finish: "stop", inputTokens: 10, outputTokens: 5 });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://inference.do-ai.run/v1/chat/completions");
    expect(init.headers.Authorization).toBe("Bearer k-123");
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ model: "deepseek-v4.1-flash", max_tokens: OUTPUT_TOKENS_CEILING, temperature: 0, response_format: { type: "json_object" } });
    expect(body.messages).toEqual([{ role: "system", content: "sys" }, { role: "user", content: "user" }]);
  });

  it("marks the system prompt for caching on Anthropic models and reads cache counts", async () => {
    const res = new Response(JSON.stringify({
      choices: [{ message: { content: "{}" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 800, completion_tokens: 50, cache_read_input_tokens: 6000, cache_created_input_tokens: 0 },
    }), { status: 200 });
    const fetchMock = vi.fn().mockResolvedValue(res);
    vi.stubGlobal("fetch", fetchMock);
    const reply = await doInference("anthropic-claude-5.5-haiku", "k").complete("static rules", "item");
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body.messages[0]).toEqual({ role: "system", content: [{ type: "text", text: "static rules", cache_control: { type: "ephemeral" } }] });
    expect(reply).toMatchObject({ inputTokens: 800, outputTokens: 50, cacheReadTokens: 6000 });
    expect(reply.cacheWriteTokens).toBeUndefined();
  });

  it("takes OpenAI-style cached tokens out of prompt_tokens so nothing is counted twice", async () => {
    const res = new Response(JSON.stringify({
      choices: [{ message: { content: "{}" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1000, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 600 } },
    }), { status: 200 });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(res));
    const reply = await doInference("openai-gpt-oss-120b", "k").complete("s", "u");
    expect(reply).toMatchObject({ inputTokens: 400, cacheReadTokens: 600 });
  });

  it("retries once without JSON mode on HTTP 400", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response("bad", { status: 400 })).mockResolvedValueOnce(ok("{}"));
    vi.stubGlobal("fetch", fetchMock);
    await doInference("openai-gpt-oss-120b", "k").complete("s", "u");
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body).response_format).toBeUndefined();
  });

  it("raises a ModelError that never carries the key", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 401 })));
    const err = await doInference("openai-gpt-oss-120b", "secret-key-xyz").complete("s", "u").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelError);
    expect(String((err as Error).message)).toBe("model answered HTTP 401");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("secret-key-xyz in a stack")));
    const err2 = await doInference("openai-gpt-oss-120b", "secret-key-xyz").complete("s", "u").catch((e: unknown) => e);
    expect(String((err2 as Error).message)).not.toContain("secret-key-xyz");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 200 })));
    await expect(doInference("m", "k").complete("s", "u")).rejects.toThrow("no choices");
  });
});

describe("templates carry what the curator needs", () => {
  it("every slug and source-id drawer has a key prefix", () => {
    const drawers = [...loadTemplates().values()].flatMap((t) => t.drawers);
    for (const d of drawers) {
      if (d.key_rule.kind === "slug" || d.key_rule.kind === "source_id") expect(keyPrefix(d), d.id).toMatch(/^[a-z-]+$/);
      else expect(keyPrefix(d)).toBeNull();
    }
  });

  it("no shipped drawer holds a new page or a field for a yes: the curator applies by default", () => {
    const drawers = [...loadTemplates().values()].flatMap((t) => t.drawers);
    expect(drawers.filter((d) => d.curator?.new_page === "needs_yes").map((d) => d.id)).toEqual([]);
    expect(drawers.filter((d) => d.update_rules.needs_yes.length > 0).map((d) => d.id)).toEqual([]);
    // Every declared field is automatic.
    for (const d of drawers) expect([...d.update_rules.auto].sort(), d.id).toEqual(d.fields.map((f) => f.name).sort());
  });
});
