import { expect, it, vi } from "vitest";
import { selectNativeSearch } from "#src/native-search.ts";
import { performSearch } from "#src/search.ts";

const active = { provider: "other", api: "other", id: "active", baseUrl: "https://example.com" };
const first = { provider: "openai-codex", api: "openai-codex-responses", id: "unsupported", baseUrl: "https://chatgpt.com" };
const second = { ...first, id: "supported" };
const registry = (oauth: boolean) => ({
  getAvailable: () => [first, second], isUsingOAuth: () => oauth,
  getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test" }),
});
const transport = Symbol.for("pi-web-search.runtime-transport");
const fetcher = vi.fn(async () => Response.json({ models: [
  { slug: "unsupported", supports_search_tool: false }, { slug: "supported", supports_search_tool: true },
] }));

it("selects a supported subscription model independently of the active model", async () => {
  const selected = await selectNativeSearch({ model: active, modelRegistry: registry(true) as never, signal: new AbortController().signal, fetch: fetcher as never });
  expect(selected?.model.id).toBe("supported");
  expect(selected?.adapter.id).toBe("openai-codex-responses");
});
it("does not use a Codex API key as a subscription", async () => {
  const selected = await selectNativeSearch({ model: active, modelRegistry: registry(false) as never, signal: new AbortController().signal, fetch: fetcher as never });
  expect(selected).toBeUndefined();
});

it("combines subscription output with one external provider even when another model is active", async () => {
  const original = (globalThis as Record<symbol, unknown>)[transport];
  const complete = vi.fn(async (_model: unknown) => ({ content: [{ type: "text", text: "Codex answer" }] }));
  (globalThis as Record<symbol, unknown>)[transport] = async (url: string | URL | Request) => String(url).includes("/models?")
    ? fetcher()
    : Response.json({ web: { results: [{ title: "Page", url: "https://example.com/page" }] } });
  try {
    const result = await performSearch({ providers: [{ provider: "brave", apiKey: "key" }], strategy: "priority", fallback: true }, { query: "q", maxResults: 5 }, undefined, { activeModel: active, modelRegistry: { ...registry(true), complete } });
    expect(complete).toHaveBeenCalledOnce();
    expect(complete.mock.calls[0]?.[0]).toEqual(second);
    expect(result.native).toMatchObject({ status: "success", provider: "openai-codex", model: "supported" });
    expect(result.results).toHaveLength(1);
    expect((result as { answer?: string }).answer).toBe("Codex answer");
  } finally {
    if (original === undefined) delete (globalThis as Record<symbol, unknown>)[transport];
    else (globalThis as Record<symbol, unknown>)[transport] = original;
  }
});