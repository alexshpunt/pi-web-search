import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import { expectNativePromptContract } from "./support/native-prompt-contract.js";

type ActiveModel = {
  provider: string;
  api: string;
  id: string;
  baseUrl: string;
  headers?: Record<string, string>;
};

type NativeSearchResult = {
  text: string;
  provider: string;
  model: string;
};

type NativeAdapter = {
  id: string;
  search(input: {
    query: string;
    model: ActiveModel;
    signal: AbortSignal;
    modelRegistry: ModelRegistry;
    fetch: typeof fetch;
  }): Promise<NativeSearchResult>;
};

type NativeSearchModule = {
  STATIC_NATIVE_SEARCH_MODEL_IDS: Readonly<Record<string, readonly string[]>>;
  resolveNativeSearchAdapter(model: ActiveModel): NativeAdapter | undefined;
};

// This package-owned seam keeps capability and payload rules independently executable.
// The actual request must still cross Pi's public ModelRegistry boundary.
const nativeModuleSpecifier = "#src/native-search.ts";
const nativeModule = import(nativeModuleSpecifier)
  .then((loaded) => loaded as unknown as Partial<NativeSearchModule>)
  .catch(() => ({} as Partial<NativeSearchModule>));

const query = "native adapter contract";

const baseUrls: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  "openai-codex": "https://chatgpt.com/backend-api",
  anthropic: "https://api.anthropic.com",
  google: "https://generativelanguage.googleapis.com/v1beta",
  xai: "https://api.x.ai/v1",
  deepseek: "https://api.deepseek.com",
  xiaomi: "https://api.xiaomimimo.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  opencode: "https://opencode.ai/zen/v1",
  "opencode-go": "https://opencode.ai/go/v1",
};

function model(provider: string, api: string, id: string): ActiveModel {
  return { provider, api, id, baseUrl: baseUrls[provider] ?? "https://provider.example.test" };
}

type EligibilityExample = {
  model: ActiveModel;
};

interface AdapterCase {
  name: string;
  adapterId: string;
  supported: EligibilityExample[];
  unsupported: EligibilityExample[];
  basePayload: Record<string, unknown>;
  expectedPayload: Record<string, unknown>;
  execution?: "registered-provider" | "resolved-fetch";
  eligibility?: "exact" | "provider-api";
}

const cases: AdapterCase[] = [
  {
    name: "OpenAI Responses",
    adapterId: "openai-responses",
    supported: [
      model("openai", "openai-responses", "gpt-5.6"),
      model("openai", "openai-responses", "gpt-5.6-sol"),
      model("openai", "openai-responses", "gpt-5.6-terra"),
      model("openai", "openai-responses", "gpt-5.6-luna"),
      model("openai", "openai-responses", "gpt-5.5"),
      model("openai", "openai-responses", "gpt-5.5-pro"),
      model("openai", "openai-responses", "gpt-5.5-2026-04-23"),
      model("openai", "openai-responses", "gpt-5.5-pro-2026-04-23"),
      model("openai", "openai-responses", "gpt-5.4"),
      model("openai", "openai-responses", "gpt-5.4-pro"),
      model("openai", "openai-responses", "gpt-5.4-mini"),
      model("openai", "openai-responses", "gpt-5.4-nano"),
      model("openai", "openai-responses", "gpt-5.4-2026-03-05"),
      model("openai", "openai-responses", "gpt-5.4-pro-2026-03-05"),
      model("openai", "openai-responses", "gpt-5.4-mini-2026-03-17"),
      model("openai", "openai-responses", "gpt-5.4-nano-2026-03-17"),
      model("openai", "openai-responses", "gpt-4.1"),
      model("openai", "openai-responses", "gpt-4.1-mini"),
      model("openai", "openai-responses", "o4-mini"),
    ].map((activeModel) => ({ model: activeModel })),
    unsupported: [
      { model: model("openai", "openai-responses", "gpt-4o") },
      { model: model("openai", "openai-responses", "gpt-4.1-nano") },
      { model: model("openai", "openai-responses", "o3") },
      { model: model("openai", "openai-responses", "gpt-5.4-ultra") },
      { model: model("openai", "openai-responses", "gpt-5.4-pro-latest") },
      { model: model("openai", "openai-responses", "gpt-5.4-pro-2026-03-06") },
      { model: model("openai", "openai-responses", "gpt-4o-search-preview") },
      { model: model("openai", "openai-completions", "gpt-5.6") },
    ],
    basePayload: { model: "gpt-5.6", input: query, tools: [] },
    expectedPayload: { model: "gpt-5.6", input: query, tools: [{ type: "web_search" }] },
  },

  {
    name: "Anthropic Messages web search",

    adapterId: "anthropic-messages",
    eligibility: "provider-api",
    supported: [
      model("anthropic", "anthropic-messages", "claude-fable-5"),
      model("anthropic", "anthropic-messages", "claude-opus-5"),
      model("anthropic", "anthropic-messages", "claude-opus-4-8"),
      model("anthropic", "anthropic-messages", "claude-opus-4-7"),
      model("anthropic", "anthropic-messages", "claude-opus-4-6"),
      model("anthropic", "anthropic-messages", "claude-opus-4-5-20251101"),
      model("anthropic", "anthropic-messages", "claude-sonnet-5"),
      model("anthropic", "anthropic-messages", "claude-sonnet-4-6"),
      model("anthropic", "anthropic-messages", "claude-sonnet-4-5-20250929"),
      model("anthropic", "anthropic-messages", "claude-haiku-4-5-20251001"),
    ].map((activeModel) => ({ model: activeModel })),
    unsupported: [
      { model: model("anthropic", "openai-responses", "claude-sonnet-4-6") },
      { model: model("opencode", "anthropic-messages", "claude-sonnet-4-6") },
      { model: model("anthropic", "anthropic-messages", "anthropic.claude-sonnet-4-6-v1:0") },
    ],
    basePayload: {
      model: "claude-opus-5",
      max_tokens: 1024,
      messages: [{ role: "user", content: query }],
      tools: [],
    },
    expectedPayload: {
      model: "claude-opus-5",
      max_tokens: 1024,
      messages: [{ role: "user", content: query }],
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 8 }],
    },
  },
  {
    name: "Gemini grounding",
    adapterId: "gemini-google-search",
    supported: [
      model("google", "google-generative-ai", "gemini-2.5-pro"),
      model("google", "google-generative-ai", "gemini-2.5-flash"),
      model("google", "google-generative-ai", "gemini-2.5-flash-lite"),
      model("google", "google-generative-ai", "gemini-3-flash-preview"),
      model("google", "google-generative-ai", "gemini-3-pro-image"),
      model("google", "google-generative-ai", "gemini-3.1-pro-preview"),
      model("google", "google-generative-ai", "gemini-3.1-flash-image"),
      model("google", "google-generative-ai", "gemini-3.1-flash-lite"),
      model("google", "google-generative-ai", "gemini-3.5-flash"),
      model("google", "google-generative-ai", "gemini-3.5-flash-lite"),
      model("google", "google-generative-ai", "gemini-3.6-flash"),
      model("google", "google-generative-ai", "gemini-3.7-flash"),
    ].map((activeModel) => ({ model: activeModel })),
    unsupported: [
      { model: model("google", "google-generative-ai", "gemini-1.5-pro") },
      { model: model("google", "google-generative-ai", "gemini-2.0-pro") },
      { model: model("google", "google-generative-ai", "gemini-2.0-flash") },

      { model: model("google", "google-generative-ai", "gemini-3.1-flash-lite-preview") },

      { model: model("google", "google-generative-ai", "gemini-3.1-flash-image-preview") },
      { model: model("google", "google-generative-ai", "gemini-3-pro-image-preview") },

      { model: model("google", "google-generative-ai", "gemini-2.5-pro-preview-03-25") },
      { model: model("google", "google-generative-ai", "gemini-2.5-flash-preview-09-2025") },
      { model: model("google", "google-generative-ai", "gemini-2.5-ultra") },
      { model: model("google", "google-generative-ai", "gemini-2.5-pro-preview-03-26") },
      { model: model("google", "google-generative-ai", "gemini-2.5-pro-latest") },
      { model: model("google", "google-generative-ai", "gemini-2.5-pro-001") },
      { model: model("opencode", "google-generative-ai", "gemini-2.5-pro") },
    ],
    basePayload: {
      contents: [{ role: "user", parts: [{ text: query }] }],
      tools: [],
    },
    expectedPayload: {
      contents: [{ role: "user", parts: [{ text: query }] }],
      tools: [{ google_search: {} }],
    },
  },
  {
    name: "xAI Responses search",
    adapterId: "xai-responses",
    eligibility: "provider-api",
    supported: [
      model("xai", "openai-responses", "grok-4.6"),
      model("xai", "openai-responses", "grok-4.3"),
      model("xai", "openai-responses", "grok-4.3-latest"),
    ].map((activeModel) => ({ model: activeModel })),
    unsupported: [
      { model: model("xai", "openai-completions", "grok-4.6") },
      { model: model("opencode", "openai-responses", "grok-4.6") },
    ],
    basePayload: { model: "grok-4.6", input: query, tools: [], tool_choice: "auto" },
    expectedPayload: {
      model: "grok-4.6",
      input: query,
      tools: [{ type: "web_search" }],
      tool_choice: "required",
    },
  },
  {
    name: "DeepSeek Responses search",
    adapterId: "deepseek-responses",
    supported: [
      model("deepseek", "openai-completions", "deepseek-v4-flash"),
      model("deepseek", "openai-completions", "deepseek-v4-pro"),
      model("deepseek", "openai-completions", "deepseek-v4-flash-vision-exp"),
      model("deepseek", "openai-responses", "deepseek-v4-flash"),
      model("deepseek", "openai-responses", "deepseek-v4-pro"),
      model("deepseek", "openai-responses", "deepseek-v4-flash-vision-exp"),
    ].map((activeModel) => ({ model: activeModel })),
    unsupported: [
      { model: model("deepseek", "openai-completions", "deepseek-v3") },

      { model: model("deepseek", "openai-completions", "deepseek-v4") },
      { model: model("deepseek", "openai-completions", "deepseek-v4-flash-0731") },
      { model: model("deepseek", "openai-completions", "deepseek-v4-pro-0813") },
      { model: model("deepseek", "openai-completions", "deepseek-v4-ultra") },
      { model: model("opencode", "openai-responses", "deepseek-v4-pro") },
    ],
    basePayload: { model: "deepseek-v4-flash", input: query, tools: [] },
    expectedPayload: {
      model: "deepseek-v4-flash",
      input: query,
      tools: [{ type: "web_search" }],
      tool_choice: "required",
    },
    execution: "resolved-fetch",
  },
  {
    name: "Xiaomi MiMo web search",
    adapterId: "xiaomi-mimo",
    supported: [
      model("xiaomi", "openai-completions", "mimo-v2.5"),
      model("xiaomi", "openai-completions", "mimo-v2.5-pro"),
    ].map((activeModel) => ({ model: activeModel })),
    unsupported: [
      { model: model("xiaomi", "openai-completions", "mimo-v2") },

      { model: model("xiaomi", "openai-completions", "mimo-v2.5-pro[1m]") },
      { model: model("xiaomi", "openai-completions", "mimo-v2.5-pro-1m") },
      { model: model("xiaomi", "openai-completions", "mimo-v2.5-2026-08-29") },
      { model: model("xiaomi", "openai-completions", "mimo-v2.5-flash") },
      { model: model("xiaomi", "openai-responses", "mimo-v2.5") },
    ],
    basePayload: {
      model: "mimo-v2.5",
      messages: [{ role: "user", content: query }],
      tools: [],
      tool_choice: "auto",
    },
    expectedPayload: {
      model: "mimo-v2.5",
      messages: [{ role: "user", content: query }],
      tools: [{ type: "web_search" }],
      tool_choice: "auto",
    },
  },
];

const expectedStaticModelIds = Object.fromEntries(
  cases
    .filter((adapterCase) => (adapterCase.eligibility ?? "exact") === "exact")
    .map((adapterCase) => [
      adapterCase.adapterId,
      adapterCase.supported.map(({ model: activeModel }) => `${activeModel.provider}:${activeModel.api}:${activeModel.id}`),
    ]),
);

async function resolver(): Promise<NativeSearchModule["resolveNativeSearchAdapter"] | undefined> {
  const loaded = await nativeModule;
  expect(typeof loaded.resolveNativeSearchAdapter).toBe("function");
  return loaded.resolveNativeSearchAdapter;
}

function createRegistryDouble(basePayload: Record<string, unknown>, responseText: string): {
  registry: ModelRegistry;
  complete: ReturnType<typeof vi.fn>;
  getApiKeyAndHeaders: ReturnType<typeof vi.fn>;
  payload: () => unknown;
  options: () => Record<string, unknown> | undefined;
} {
  let capturedPayload: unknown;
  let capturedOptions: Record<string, unknown> | undefined;
  const getApiKeyAndHeaders = vi.fn(async () => ({
    ok: true as const,
    apiKey: "runtime-owned-secret",
    headers: { Authorization: "Bearer runtime-owned", "x-runtime": "pi" },
    baseUrl: "https://runtime-owned.example.test",
  }));
  const complete = vi.fn(async (activeModel: ActiveModel, _context: unknown, options?: {
    signal?: AbortSignal;
    onPayload?: (payload: unknown, model: ActiveModel) => unknown | undefined | Promise<unknown | undefined>;
    headers?: Record<string, string>;
    apiKey?: string;
    baseUrl?: string;
  }) => {
    capturedOptions = options as Record<string, unknown> | undefined;
    const initial = structuredClone(basePayload);
    capturedPayload = (await options?.onPayload?.(initial, activeModel)) ?? initial;
    return {
      role: "assistant",
      content: [{ type: "text", text: responseText }],
      api: activeModel.api,
      provider: activeModel.provider,
      model: activeModel.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: Date.now(),
    };
  });
  const registry = {
    complete,
    getApiKeyAndHeaders,
    getProvider: vi.fn((provider: string) => ({ id: provider, baseUrl: baseUrls[provider] })),
    getRegisteredNativeProvider: vi.fn(),
    getRegisteredProviderConfig: vi.fn(),
  } as unknown as ModelRegistry;
  return {
    registry,
    complete,
    getApiKeyAndHeaders,
    payload: () => capturedPayload,
    options: () => capturedOptions,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("native adapter capability contracts", () => {
  it("exports the complete fail-closed table of exact static model IDs", async () => {
    const loaded = await nativeModule;
    expect(loaded.STATIC_NATIVE_SEARCH_MODEL_IDS).toEqual(expectedStaticModelIds);
  });

  it.each(cases)("uses the evidence-backed eligibility policy for $name", async (adapterCase) => {
    const resolve = await resolver();
    if (resolve === undefined) return;

    for (const supported of adapterCase.supported) {
      expect(resolve(supported.model)?.id).toBe(adapterCase.adapterId);
    }
    for (const unsupported of adapterCase.unsupported) {
      expect(resolve(unsupported.model)).toBeUndefined();
    }
  });

  it("lets direct Anthropic and xAI provider paths fail at runtime instead of maintaining incomplete model allow-lists", async () => {
    const resolve = await resolver();
    if (resolve === undefined) return;

    expect(resolve(model("anthropic", "anthropic-messages", "claude-future-model"))?.id).toBe("anthropic-messages");
    expect(resolve(model("xai", "openai-responses", "grok-future-model"))?.id).toBe("xai-responses");
  });

  it("fails closed for OpenCode gateway shapes without a documented hosted-search contract", async () => {
    const resolve = await resolver();
    if (resolve === undefined) return;

    expect(resolve(model("opencode", "openai-responses", "gpt-5.6"))).toBeUndefined();
    expect(resolve(model("opencode-go", "anthropic-messages", "claude-sonnet-4"))).toBeUndefined();
    expect(resolve(model("opencode", "google-generative-ai", "gemini-2.5-pro"))).toBeUndefined();
  });
});

describe("native adapter Pi runtime and request contracts", () => {
  it.each(cases.filter((adapterCase) => adapterCase.execution !== "resolved-fetch"))(
    "runs $name through Pi's active ModelRegistry model and exact native payload",
    async (adapterCase) => {
    const resolve = await resolver();
    if (resolve === undefined) return;

    const supported = adapterCase.supported[0];
    expect(supported).toBeDefined();
    if (supported === undefined) return;
    const adapter = resolve(supported.model);
    expect(adapter?.id).toBe(adapterCase.adapterId);
    if (adapter === undefined) return;

    const globalFetch = vi.fn(() => {
      throw new Error("native adapter used global fetch");
    });
    const providerFetch = vi.fn(() => {
      throw new Error("the Pi provider runtime should own this mocked transport");
    });
    vi.stubGlobal("fetch", globalFetch);

    const nativeText = `${adapterCase.name} native text`;
    const runtime = createRegistryDouble(adapterCase.basePayload, nativeText);
    const signal = new AbortController().signal;
    const result = await adapter.search({
      query,
      model: supported.model,
      signal,
      modelRegistry: runtime.registry,
      fetch: providerFetch as unknown as typeof fetch,
    });

    expect(runtime.complete).toHaveBeenCalledTimes(1);
    const [sentModel, sentContext, sentOptions] = runtime.complete.mock.calls[0] ?? [];
    expect(sentModel).toBe(supported.model);
    expect(sentContext).toMatchObject({
      messages: [{ role: "user", content: expect.any(String) }],
    });
    const sentPrompt = (sentContext as { messages?: Array<{ content?: unknown }> }).messages?.[0]?.content;
    expectNativePromptContract(sentPrompt, query);
    expect(sentOptions).toMatchObject({
      signal,
      fetch: providerFetch,
      onPayload: expect.any(Function),
    });
    expect(runtime.payload()).toEqual(adapterCase.expectedPayload);
    expect(runtime.getApiKeyAndHeaders).not.toHaveBeenCalled();
    expect(runtime.options()).not.toMatchObject({
      apiKey: expect.anything(),
      headers: expect.anything(),
      baseUrl: expect.anything(),
    });
    expect(providerFetch).not.toHaveBeenCalled();
    expect(globalFetch).not.toHaveBeenCalled();
    expect(result).toEqual({
      text: nativeText,
      provider: supported.model.provider,
      model: supported.model.id,
    });
  });

  it("uses Pi-resolved DeepSeek auth and base URL for the documented Responses endpoint", async () => {
    const resolve = await resolver();
    if (resolve === undefined) return;

    const activeModel = model("deepseek", "openai-completions", "deepseek-v4-flash");
    const adapter = resolve(activeModel);
    expect(adapter?.id).toBe("deepseek-responses");
    if (adapter === undefined) return;

    const signal = new AbortController().signal;
    const nativeText = "DeepSeek native text";
    const getApiKeyAndHeaders = vi.fn(async () => ({
      ok: true as const,
      apiKey: "pi-resolved-deepseek-key",
      headers: { Authorization: "Bearer pi-resolved-deepseek-key", "x-pi-runtime": "configured" },
      baseUrl: "https://api.deepseek.com",
    }));
    const complete = vi.fn(() => {
      throw new Error("the active Chat Completions runtime cannot issue DeepSeek Responses");
    });
    const registry = { getApiKeyAndHeaders, complete } as unknown as ModelRegistry;
    const providerFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      output: [{
        type: "message",
        content: [{ type: "output_text", text: nativeText }],
      }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const globalFetch = vi.fn(() => {
      throw new Error("native adapter used global fetch");
    });
    vi.stubGlobal("fetch", globalFetch);

    const result = await adapter.search({
      query,
      model: activeModel,
      signal,
      modelRegistry: registry,
      fetch: providerFetch as unknown as typeof fetch,
    });

    expect(getApiKeyAndHeaders).toHaveBeenCalledOnce();
    expect(getApiKeyAndHeaders).toHaveBeenCalledWith(activeModel);
    expect(complete).not.toHaveBeenCalled();
    expect(providerFetch).toHaveBeenCalledOnce();
    const [url, init] = providerFetch.mock.calls[0] ?? [];
    expect(url).toBe("https://api.deepseek.com/responses");
    expect(init).toMatchObject({
      method: "POST",
      signal,
      headers: {
        Authorization: "Bearer pi-resolved-deepseek-key",
        "x-pi-runtime": "configured",
        "content-type": "application/json",
      },
    });
    const body = JSON.parse(String((init as RequestInit | undefined)?.body)) as Record<string, unknown>;
    expectNativePromptContract(body.input, query);
    expect(body).toEqual({
      model: "deepseek-v4-flash",
      input: expect.any(String),
      tools: [{ type: "web_search" }],
      tool_choice: "required",
    });
    expect(globalFetch).not.toHaveBeenCalled();
    expect(result).toEqual({ text: nativeText, provider: "deepseek", model: "deepseek-v4-flash" });
  });

  it.each([
    {
      name: "resolved base URL without a trailing slash",
      modelBaseUrl: "https://model.deepseek.test/root",
      auth: {
        ok: true as const,
        headers: { Authorization: "Bearer resolved-secret", "x-runtime": "pi" },
        baseUrl: "https://resolved.deepseek.test/api",
      },
      expectedUrl: "https://resolved.deepseek.test/api/responses",
    },
    {
      name: "resolved base URL with a trailing slash",
      modelBaseUrl: "https://model.deepseek.test/root",
      auth: {
        ok: true as const,
        headers: { Authorization: "Bearer resolved-secret", "x-runtime": "pi" },
        baseUrl: "https://resolved.deepseek.test/api/",
      },
      expectedUrl: "https://resolved.deepseek.test/api/responses",
    },
    {
      name: "active model base URL when resolved base URL is absent",
      modelBaseUrl: "https://model.deepseek.test/root/",
      auth: {
        ok: true as const,
        headers: { Authorization: "Bearer resolved-secret", "x-runtime": "pi" },
      },
      expectedUrl: "https://model.deepseek.test/root/responses",
    },
  ])("joins the DeepSeek Responses URL safely from the $name", async ({ modelBaseUrl, auth, expectedUrl }) => {
    const resolve = await resolver();
    if (resolve === undefined) return;

    const activeModel = { ...model("deepseek", "openai-completions", "deepseek-v4-flash"), baseUrl: modelBaseUrl };
    const adapter = resolve(activeModel);
    expect(adapter?.id).toBe("deepseek-responses");
    if (adapter === undefined) return;

    const getApiKeyAndHeaders = vi.fn(async () => auth);
    const providerFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      output: [{ type: "message", content: [{ type: "output_text", text: "DeepSeek text" }] }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    await adapter.search({
      query,
      model: activeModel,
      signal: new AbortController().signal,
      modelRegistry: { getApiKeyAndHeaders, complete: vi.fn() } as unknown as ModelRegistry,
      fetch: providerFetch as unknown as typeof fetch,
    });

    expect(providerFetch.mock.calls[0]?.[0]).toBe(expectedUrl);
    expect(providerFetch.mock.calls[0]?.[1]).toMatchObject({
      headers: {
        Authorization: "Bearer resolved-secret",
        "x-runtime": "pi",
        "content-type": "application/json",
      },
    });
  });

  it("uses Pi's resolved DeepSeek API key when resolved headers are absent", async () => {
    const resolve = await resolver();
    if (resolve === undefined) return;

    const activeModel = model("deepseek", "openai-completions", "deepseek-v4-pro");
    const adapter = resolve(activeModel);
    expect(adapter?.id).toBe("deepseek-responses");
    if (adapter === undefined) return;

    const providerFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      output: [{ type: "message", content: [{ type: "output_text", text: "DeepSeek text" }] }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    await adapter.search({
      query,
      model: activeModel,
      signal: new AbortController().signal,
      modelRegistry: {
        getApiKeyAndHeaders: vi.fn(async () => ({ ok: true as const, apiKey: "resolved-api-key" })),
        complete: vi.fn(),
      } as unknown as ModelRegistry,
      fetch: providerFetch as unknown as typeof fetch,
    });

    expect(providerFetch.mock.calls[0]?.[1]).toMatchObject({
      headers: {
        Authorization: "Bearer resolved-api-key",
        "content-type": "application/json",
      },
    });
  });

  it.each([
    {
      name: "API key plus non-auth headers",
      auth: { ok: true as const, apiKey: "resolved-key", headers: { "x-runtime": "pi" } },
      expectedAuthorization: "Bearer resolved-key",
    },
    {
      name: "lower-case authorization",
      auth: { ok: true as const, apiKey: "ignored-key", headers: { authorization: "Basic existing-lower", "x-runtime": "pi" } },
      expectedAuthorization: "Basic existing-lower",
    },
    {
      name: "mixed-case authorization",
      auth: { ok: true as const, apiKey: "ignored-key", headers: { AuThOrIzAtIoN: "Token existing-mixed", "x-runtime": "pi" } },
      expectedAuthorization: "Token existing-mixed",
    },
    {
      name: "header-only auth",
      auth: { ok: true as const, headers: { Authorization: "Bearer header-only", "x-runtime": "pi" } },
      expectedAuthorization: "Bearer header-only",
    },
  ])("preserves DeepSeek resolved auth case-insensitively for $name", async ({ auth, expectedAuthorization }) => {
    const resolve = await resolver();
    if (resolve === undefined) return;
    const activeModel = model("deepseek", "openai-completions", "deepseek-v4-pro");
    const adapter = resolve(activeModel);
    expect(adapter?.id).toBe("deepseek-responses");
    if (adapter === undefined) return;

    const providerFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      output: [{ type: "message", content: [{ type: "output_text", text: "DeepSeek text" }] }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    await adapter.search({
      query,
      model: activeModel,
      signal: new AbortController().signal,
      modelRegistry: {
        getApiKeyAndHeaders: vi.fn(async () => auth),
        complete: vi.fn(),
      } as unknown as ModelRegistry,
      fetch: providerFetch as unknown as typeof fetch,
    });

    const headers = new Headers(providerFetch.mock.calls[0]?.[1]?.headers);
    expect(headers.get("authorization")).toBe(expectedAuthorization);
    expect(headers.get("x-runtime")).toBe("pi");
    expect(headers.get("content-type")).toBe("application/json");
    expect([...headers.keys()].filter((name) => name.toLowerCase() === "authorization")).toHaveLength(1);
  });

  it("fails clearly without a DeepSeek request when Pi auth resolution fails", async () => {
    const resolve = await resolver();
    if (resolve === undefined) return;

    const activeModel = model("deepseek", "openai-completions", "deepseek-v4-pro");
    const adapter = resolve(activeModel);
    expect(adapter?.id).toBe("deepseek-responses");
    if (adapter === undefined) return;

    const secret = "credential-that-must-not-leak";
    const providerFetch = vi.fn();
    const complete = vi.fn();
    const promise = adapter.search({
      query,
      model: activeModel,
      signal: new AbortController().signal,
      modelRegistry: {
        getApiKeyAndHeaders: vi.fn(async () => ({ ok: false as const, error: `auth failed ${secret}` })),
        complete,
      } as unknown as ModelRegistry,
      fetch: providerFetch as unknown as typeof fetch,
    });

    const failure = await promise.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain("Unable to resolve DeepSeek authentication");
    expect(String(failure)).not.toContain(secret);
    expect(providerFetch).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it.each([
    ["non-2xx", () => new Response("secret-provider-body", { status: 503 })],
    ["malformed JSON", () => new Response("secret-malformed-body", { status: 200 })],
  ])("does not log or return DeepSeek credentials, request bodies, or response bodies on %s", async (_name, response) => {
    const resolve = await resolver();
    if (resolve === undefined) return;
    const activeModel = model("deepseek", "openai-completions", "deepseek-v4-pro");
    const adapter = resolve(activeModel);
    expect(adapter?.id).toBe("deepseek-responses");
    if (adapter === undefined) return;

    const credential = "deepseek-secret-key";
    const privateQuery = "private-query-body";
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failure = await adapter.search({
      query: privateQuery,
      model: activeModel,
      signal: new AbortController().signal,
      modelRegistry: {
        getApiKeyAndHeaders: vi.fn(async () => ({ ok: true as const, apiKey: credential })),
        complete: vi.fn(),
      } as unknown as ModelRegistry,
      fetch: vi.fn(async () => response()) as unknown as typeof fetch,
    }).catch((caught: unknown) => caught);

    expect(failure).toBeInstanceOf(Error);
    const observable = JSON.stringify([String(failure), log.mock.calls, warn.mock.calls, error.mock.calls]);
    expect(observable).not.toContain(credential);
    expect(observable).not.toContain(privateQuery);
    expect(observable).not.toContain("secret-provider-body");
    expect(observable).not.toContain("secret-malformed-body");
  });

  it("runs an active DeepSeek Responses model through ModelRegistry.complete", async () => {
    const resolve = await resolver();
    if (resolve === undefined) return;

    const activeModel = model("deepseek", "openai-responses", "deepseek-v4-pro");
    const adapter = resolve(activeModel);
    expect(adapter?.id).toBe("deepseek-responses");
    if (adapter === undefined) return;

    const runtime = createRegistryDouble(
      { model: activeModel.id, input: query, tools: [] },
      "DeepSeek Responses native text",
    );
    const signal = new AbortController().signal;
    const providerFetch = vi.fn(() => {
      throw new Error("Pi must own the Responses transport");
    });

    const result = await adapter.search({
      query,
      model: activeModel,
      signal,
      modelRegistry: runtime.registry,
      fetch: providerFetch as unknown as typeof fetch,
    });

    expect(runtime.complete).toHaveBeenCalledOnce();
    expect(runtime.complete.mock.calls[0]?.[0]).toBe(activeModel);
    const context = runtime.complete.mock.calls[0]?.[1] as { messages?: Array<{ content?: unknown }> } | undefined;
    expectNativePromptContract(context?.messages?.[0]?.content, query);
    expect(runtime.complete.mock.calls[0]?.[2]).toMatchObject({
      signal,
      fetch: providerFetch,
      onPayload: expect.any(Function),
    });
    expect(runtime.getApiKeyAndHeaders).not.toHaveBeenCalled();
    expect(runtime.payload()).toEqual({
      model: activeModel.id,
      input: query,
      tools: [{ type: "web_search" }],
      tool_choice: "required",
    });
    expect(providerFetch).not.toHaveBeenCalled();
    expect(result).toEqual({
      text: "DeepSeek Responses native text",
      provider: "deepseek",
      model: activeModel.id,
    });
  });

  it.each(cases.filter((adapterCase) => adapterCase.execution !== "resolved-fetch"))(
    "keeps a $name provider rejection as one native failure without model substitution",
    async (adapterCase) => {
    const resolve = await resolver();
    if (resolve === undefined) return;

    const supported = adapterCase.supported[0];
    expect(supported).toBeDefined();
    if (supported === undefined) return;
    const adapter = resolve(supported.model);
    expect(adapter?.id).toBe(adapterCase.adapterId);
    if (adapter === undefined) return;

    const rejection = new Error(`${adapterCase.adapterId} rejected native search`);
    const complete = vi.fn(async (_activeModel: ActiveModel) => {
      throw rejection;
    });
    const registry = { complete } as unknown as ModelRegistry;

    await expect(adapter.search({
      query,
      model: supported.model,
      signal: new AbortController().signal,
      modelRegistry: registry,
      fetch: vi.fn() as unknown as typeof fetch,
    })).rejects.toBe(rejection);

    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0]?.[0]).toBe(supported.model);
  });

  it("keeps a DeepSeek Responses rejection as one native failure without model substitution", async () => {
    const resolve = await resolver();
    if (resolve === undefined) return;

    const activeModel = model("deepseek", "openai-completions", "deepseek-v4-pro");
    const adapter = resolve(activeModel);
    expect(adapter?.id).toBe("deepseek-responses");
    if (adapter === undefined) return;

    const rejection = new Error("deepseek rejected native search");
    const getApiKeyAndHeaders = vi.fn(async () => ({
      ok: true as const,
      headers: { Authorization: "Bearer pi-resolved-deepseek-key" },
      baseUrl: "https://api.deepseek.com",
    }));
    const providerFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      throw rejection;
    });
    const complete = vi.fn();

    await expect(adapter.search({
      query,
      model: activeModel,
      signal: new AbortController().signal,
      modelRegistry: { getApiKeyAndHeaders, complete } as unknown as ModelRegistry,
      fetch: providerFetch as unknown as typeof fetch,
    })).rejects.toBe(rejection);

    expect(getApiKeyAndHeaders).toHaveBeenCalledWith(activeModel);
    expect(providerFetch).toHaveBeenCalledOnce();
    expect(complete).not.toHaveBeenCalled();
    expect(JSON.parse(String((providerFetch.mock.calls[0]?.[1] as RequestInit | undefined)?.body))).toMatchObject({
      model: "deepseek-v4-pro",
    });
  });

});
