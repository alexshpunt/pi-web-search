import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

type ActiveModel = {
  provider: string;
  api: string;
  id: string;
  baseUrl: string;
};

type NativeAdapter = {
  id: string;
  search(input: {
    query: string;
    model: ActiveModel;
    modelRegistry: ModelRegistry;
    signal: AbortSignal;
    fetch: typeof fetch;
  }): Promise<{ text: string; provider: string; model: string }>;
};

type NativeSearchCompatibility = {
  codexClientVersion?: string;
};

type NativeSearchModule = {
  CODEX_CLIENT_VERSION: string;
  acquireNativeSearchAdapter(input: {
    model: ActiveModel;
    modelRegistry: ModelRegistry;
    signal: AbortSignal;
    fetch: typeof fetch;
    compatibility?: NativeSearchCompatibility;
  }): Promise<NativeAdapter | undefined>;
};

const PINNED_CODEX_CLIENT_VERSION = "0.151.0";
// Pinned Codex source: official rust-v0.151.0 release at
// 78c290807ce710180111df227df3b7a4fe845452. Its Cargo.toml owns 0.151.0;
// models-manager/src/lib.rs derives that whole value for the model catalog.

const nativeModuleSpecifier = "#src/native-search.ts";
const nativeModule = import(nativeModuleSpecifier)
  .then((loaded) => loaded as unknown as Partial<NativeSearchModule>)
  .catch(() => ({} as Partial<NativeSearchModule>));

async function acquire(input: Parameters<NativeSearchModule["acquireNativeSearchAdapter"]>[0]) {
  const loaded = await nativeModule;
  expect(typeof loaded.acquireNativeSearchAdapter).toBe("function");
  return loaded.acquireNativeSearchAdapter?.(input);
}

function registryWithAuth(auth: unknown) {
  const getApiKeyAndHeaders = vi.fn(async () => auth);
  return {
    registry: { getApiKeyAndHeaders } as unknown as ModelRegistry,
    getApiKeyAndHeaders,
  };
}

const codexModel: ActiveModel = {
  provider: "openai-codex",
  api: "openai-codex-responses",
  id: "gpt-5.3-codex",
  baseUrl: "https://chatgpt.com/backend-api",
};

const openRouterModel: ActiveModel = {
  provider: "openrouter",
  api: "openai-completions",
  id: "openai/gpt-5.6",
  baseUrl: "https://openrouter.ai/api/v1",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function codexCatalog(slug = codexModel.id) {
  return {
    models: [{
      slug,
      supports_search_tool: true,
    }],
  };
}

function openRouterCatalog(id = openRouterModel.id, parameters = ["tools", "tool_choice"]) {
  return {
    data: {
      id,
      endpoints: [{ model_id: id, supported_parameters: parameters }],
    },
  };
}


function runtimeForAcquisitionAndCompletion(auth: unknown, basePayload: Record<string, unknown>, text: string) {
  let payload: unknown;
  const getApiKeyAndHeaders = vi.fn(async () => auth);
  const complete = vi.fn(async (activeModel: ActiveModel, _context: unknown, options?: {
    onPayload?: (payload: unknown, model: ActiveModel) => unknown | Promise<unknown>;
  }) => {
    payload = await options?.onPayload?.(structuredClone(basePayload), activeModel) ?? basePayload;
    return {
      role: "assistant",
      content: [{ type: "text", text }],
      api: activeModel.api,
      provider: activeModel.provider,
      model: activeModel.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: Date.now(),
    };
  });
  return {
    registry: { getApiKeyAndHeaders, complete } as unknown as ModelRegistry,
    getApiKeyAndHeaders,
    complete,
    payload: () => payload,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Codex capability metadata acquisition", () => {
  it("gets the exact active Codex model from the authenticated ChatGPT catalog", async () => {
    const signal = new AbortController().signal;
    const runtimeHeaders = {
      Authorization: "Bearer refreshed-codex-token",
      "ChatGPT-Account-ID": "account-id",
    };
    const runtime = registryWithAuth({ ok: true, headers: runtimeHeaders });
    const providerFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse(codexCatalog()));
    const globalFetch = vi.fn(() => { throw new Error("global fetch must not run"); });
    vi.stubGlobal("fetch", globalFetch);

    const loaded = await nativeModule;
    expect(loaded.CODEX_CLIENT_VERSION).toBe(PINNED_CODEX_CLIENT_VERSION);
    const adapter = await acquire({
      model: codexModel,
      modelRegistry: runtime.registry,
      signal,
      fetch: providerFetch as unknown as typeof fetch,
    });

    expect(runtime.getApiKeyAndHeaders).toHaveBeenCalledOnce();
    expect(runtime.getApiKeyAndHeaders).toHaveBeenCalledWith(codexModel);
    expect(providerFetch).toHaveBeenCalledOnce();
    const [input, init] = providerFetch.mock.calls[0] ?? [];
    const url = new URL(String(input));
    expect(`${url.origin}${url.pathname}`).toBe("https://chatgpt.com/backend-api/codex/models");
    expect(url.searchParams.get("client_version")).toBe(PINNED_CODEX_CLIENT_VERSION);
    expect(init).toMatchObject({ method: "GET", signal, headers: runtimeHeaders });
    expect(globalFetch).not.toHaveBeenCalled();
    expect(adapter?.id).toBe("openai-codex-responses");
  });

  it.each([undefined, "", "0.151", "0.151.0-beta", "not-a-version"])(
    "fails closed before auth or transport when the Codex client version is unavailable or invalid: %s",
    async (codexClientVersion) => {
      const runtime = registryWithAuth({ ok: true, headers: { Authorization: "Bearer runtime-token" } });
      const providerFetch = vi.fn();

      expect(await acquire({
        model: codexModel,
        modelRegistry: runtime.registry,
        signal: new AbortController().signal,
        fetch: providerFetch as unknown as typeof fetch,
        compatibility: { codexClientVersion },
      })).toBeUndefined();
      expect(runtime.getApiKeyAndHeaders).not.toHaveBeenCalled();
      expect(providerFetch).not.toHaveBeenCalled();
    },
  );

  it("uses acquired Codex capability for the exact active model and Pi-owned Codex request", async () => {
    const signal = new AbortController().signal;
    const runtime = runtimeForAcquisitionAndCompletion(
      { ok: true, headers: { Authorization: "Bearer refreshed-codex-token" } },
      {
        model: codexModel.id,
        instructions: "You are a helpful assistant.",
        input: [{ role: "user", content: [{ type: "input_text", text: "native query" }] }],
        tools: [],
        tool_choice: "auto",
        parallel_tool_calls: true,
        store: false,
        stream: true,
        include: ["reasoning.encrypted_content"],
      },
      "Codex native text",
    );
    const providerFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse(codexCatalog()));
    const adapter = await acquire({ model: codexModel, modelRegistry: runtime.registry, signal, fetch: providerFetch });
    expect(adapter?.id).toBe("openai-codex-responses");
    if (adapter === undefined) return;

    const result = await adapter.search({
      query: "native query",
      model: codexModel,
      modelRegistry: runtime.registry,
      signal,
      fetch: providerFetch,
    });

    expect(runtime.complete).toHaveBeenCalledOnce();
    expect(runtime.complete.mock.calls[0]?.[0]).toBe(codexModel);
    expect(runtime.complete.mock.calls[0]?.[2]).toMatchObject({ signal, fetch: providerFetch, onPayload: expect.any(Function) });
    expect(runtime.payload()).toMatchObject({
      model: codexModel.id,
      store: false,
      stream: true,
      tools: [{ type: "web_search", external_web_access: true }],
      tool_choice: "auto",
      parallel_tool_calls: true,
      include: ["reasoning.encrypted_content"],
    });
    expect(result).toEqual({ text: "Codex native text", provider: codexModel.provider, model: codexModel.id });
  });

  it("reacquires Codex metadata and fails closed for stale or mismatched model records", async () => {
    const runtime = registryWithAuth({ ok: true, headers: { Authorization: "Bearer runtime-token" } });
    const providerFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(codexCatalog()))
      .mockResolvedValueOnce(jsonResponse(codexCatalog("gpt-other-model")));
    const input = {
      model: codexModel,
      modelRegistry: runtime.registry,
      signal: new AbortController().signal,
      fetch: providerFetch as unknown as typeof fetch,
    };

    expect((await acquire(input))?.id).toBe("openai-codex-responses");
    expect(await acquire(input)).toBeUndefined();
    expect(providerFetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["missing models", {}],
    ["non-array models", { models: {} }],
    ["missing capability", { models: [{ slug: codexModel.id }] }],
    ["disabled search", { models: [{ slug: codexModel.id, supports_search_tool: false }] }],
    ["duplicate active model", { models: [codexCatalog().models[0], codexCatalog().models[0]] }],
  ])("classifies %s in the Codex catalog", async (name, body) => {
    const runtime = registryWithAuth({ ok: true, headers: { Authorization: "Bearer runtime-token" } });
    const providerFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse(body));
    const operation = acquire({ model: codexModel, modelRegistry: runtime.registry, signal: new AbortController().signal, fetch: providerFetch as unknown as typeof fetch });
    if (["missing models", "non-array models", "missing capability", "duplicate active model"].includes(name)) await expect(operation).rejects.toThrow(/malformed|duplicate|active model/);
    else expect(await operation).toBeUndefined();
  });

  it("correlates the active model across valid and malformed unrelated catalog records", async () => {
    const runtime = registryWithAuth({ ok: true, headers: { Authorization: "Bearer runtime-token" } });
    const body = {
      models: [
        { slug: "other-before", supports_search_tool: "not-a-boolean" },
        { slug: codexModel.id, supports_search_tool: true },
        null,
        { slug: "other-after" },
      ],
    };
    const adapter = await acquire({ model: codexModel, modelRegistry: runtime.registry, signal: new AbortController().signal, fetch: vi.fn(async () => jsonResponse(body)) as unknown as typeof fetch });
    expect(adapter?.id).toBe("openai-codex-responses");
  });

  it("fails on duplicate exact Codex records even when separated by unrelated records", async () => {
    const runtime = registryWithAuth({ ok: true, headers: { Authorization: "Bearer runtime-token" } });
    const body = { models: [{ slug: codexModel.id, supports_search_tool: true }, { slug: "other", supports_search_tool: true }, { slug: codexModel.id, supports_search_tool: false }] };
    await expect(acquire({ model: codexModel, modelRegistry: runtime.registry, signal: new AbortController().signal, fetch: vi.fn(async () => jsonResponse(body)) as unknown as typeof fetch })).rejects.toThrow(/duplicate/);
  });

  it("returns ineligible for a disabled or absent exact Codex record", async () => {
    const runtime = registryWithAuth({ ok: true, headers: { Authorization: "Bearer runtime-token" } });
    for (const body of [
      { models: [{ slug: "other", supports_search_tool: true }, { slug: codexModel.id, supports_search_tool: false }] },
      { models: [{ slug: "other", supports_search_tool: true }] },
    ]) {
      await expect(acquire({ model: codexModel, modelRegistry: runtime.registry, signal: new AbortController().signal, fetch: vi.fn(async () => jsonResponse(body)) as unknown as typeof fetch })).resolves.toBeUndefined();
    }
  });

  it("fails on malformed exact Codex metadata while ignoring malformed unrelated records", async () => {
    const runtime = registryWithAuth({ ok: true, headers: { Authorization: "Bearer runtime-token" } });
    const body = { models: [{ slug: "other", supports_search_tool: "bad" }, { slug: codexModel.id, supports_search_tool: "true" }] };
    await expect(acquire({ model: codexModel, modelRegistry: runtime.registry, signal: new AbortController().signal, fetch: vi.fn(async () => jsonResponse(body)) as unknown as typeof fetch })).rejects.toThrow(/malformed active model/);
  });
});

describe("OpenRouter capability metadata acquisition", () => {
  it("gets endpoint metadata for the exact active OpenRouter model through Pi-resolved auth", async () => {
    const signal = new AbortController().signal;
    const runtimeHeaders = { Authorization: "Bearer refreshed-openrouter-token", "x-runtime": "pi" };
    const runtime = registryWithAuth({
      ok: true,
      headers: runtimeHeaders,
      baseUrl: "https://router.runtime.test/api/v1/",
    });
    const providerFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse(openRouterCatalog()));

    const adapter = await acquire({
      model: openRouterModel,
      modelRegistry: runtime.registry,
      signal,
      fetch: providerFetch as unknown as typeof fetch,
    });

    expect(runtime.getApiKeyAndHeaders).toHaveBeenCalledWith(openRouterModel);
    const [url, init] = providerFetch.mock.calls[0] ?? [];
    expect(url).toBe("https://router.runtime.test/api/v1/models/openai/gpt-5.6/endpoints");
    expect(init).toMatchObject({ method: "GET", signal, headers: runtimeHeaders });
    expect(adapter?.id).toBe("openrouter-server-search");
  });

  it("uses the active model base URL when Pi auth does not resolve one", async () => {
    const runtime = registryWithAuth({ ok: true, headers: { Authorization: "Bearer runtime-token" } });
    const providerFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse(openRouterCatalog()));
    await acquire({
      model: { ...openRouterModel, baseUrl: "https://openrouter.ai/api/v1/" },
      modelRegistry: runtime.registry,
      signal: new AbortController().signal,
      fetch: providerFetch as unknown as typeof fetch,
    });
    expect(providerFetch.mock.calls[0]?.[0]).toBe(
      "https://openrouter.ai/api/v1/models/openai/gpt-5.6/endpoints",
    );
  });

  it("reacquires OpenRouter metadata and rejects stale identity or an absent active endpoint", async () => {
    const runtime = registryWithAuth({ ok: true, headers: { Authorization: "Bearer runtime-token" } });
    const providerFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(openRouterCatalog()))
      .mockResolvedValueOnce(jsonResponse(openRouterCatalog("openai/old-model")))
      .mockResolvedValueOnce(jsonResponse({ data: { id: openRouterModel.id, endpoints: [] } }));
    const input = {
      model: openRouterModel,
      modelRegistry: runtime.registry,
      signal: new AbortController().signal,
      fetch: providerFetch as unknown as typeof fetch,
    };

    expect((await acquire(input))?.id).toBe("openrouter-server-search");
    expect(await acquire(input)).toBeUndefined();
    expect(await acquire(input)).toBeUndefined();
    expect(providerFetch).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["missing data", {}],
    ["wrong data identity", { data: { id: "other/model", endpoints: [] } }],
    ["missing endpoints", { data: { id: openRouterModel.id } }],
    ["non-array endpoints", { data: { id: openRouterModel.id, endpoints: {} } }],
    ["empty endpoints", { data: { id: openRouterModel.id, endpoints: [] } }],
    ["missing supported parameters", { data: { id: openRouterModel.id, endpoints: [{ model_id: openRouterModel.id }] } }],
    ["non-array supported parameters", { data: { id: openRouterModel.id, endpoints: [{ model_id: openRouterModel.id, supported_parameters: "tools" }] } }],
    ["tools not supported", { data: { id: openRouterModel.id, endpoints: [{ model_id: openRouterModel.id, supported_parameters: ["temperature"] }] } }],
    ["mismatched endpoint identity", { data: { id: openRouterModel.id, endpoints: [{ model_id: "other/model", supported_parameters: ["tools"] }] } }],
  ])("classifies %s in OpenRouter metadata", async (name, body) => {
    const runtime = registryWithAuth({ ok: true, headers: { Authorization: "Bearer runtime-token" } });
    const operation = acquire({ model: openRouterModel, modelRegistry: runtime.registry, signal: new AbortController().signal, fetch: vi.fn(async () => jsonResponse(body)) as unknown as typeof fetch });
    if (["missing data", "missing endpoints", "non-array endpoints", "missing supported parameters", "non-array supported parameters"].includes(name)) await expect(operation).rejects.toThrow(/malformed/);
    else expect(await operation).toBeUndefined();
  });

  it("uses acquired OpenRouter metadata for the exact active model request", async () => {
    const signal = new AbortController().signal;
    const runtime = runtimeForAcquisitionAndCompletion(
      { ok: true, headers: { Authorization: "Bearer refreshed-openrouter-token" } },
      { model: openRouterModel.id, messages: [{ role: "user", content: "native query" }], tools: [] },
      "OpenRouter native text",
    );
    const providerFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse(openRouterCatalog()));
    const adapter = await acquire({ model: openRouterModel, modelRegistry: runtime.registry, signal, fetch: providerFetch });
    expect(adapter?.id).toBe("openrouter-server-search");
    if (adapter === undefined) return;

    const result = await adapter.search({
      query: "native query",
      model: openRouterModel,
      modelRegistry: runtime.registry,
      signal,
      fetch: providerFetch,
    });

    expect(runtime.complete).toHaveBeenCalledOnce();
    expect(runtime.complete.mock.calls[0]?.[0]).toBe(openRouterModel);
    expect(runtime.payload()).toEqual({
      model: openRouterModel.id,
      messages: [{ role: "user", content: "native query" }],
      tools: [{ type: "openrouter:web_search" }],
    });
    expect(result).toEqual({ text: "OpenRouter native text", provider: openRouterModel.provider, model: openRouterModel.id });
  });
});

it.each([
    ["tools second", [
      { model_id: openRouterModel.id, supported_parameters: ["temperature"] },
      { model_id: openRouterModel.id, supported_parameters: ["tools"] },
    ], true],
    ["tools first", [
      { model_id: openRouterModel.id, supported_parameters: ["tools"] },
      { model_id: openRouterModel.id, supported_parameters: ["temperature"] },
    ], true],
    ["all valid unsupported", [
      { model_id: openRouterModel.id, supported_parameters: ["temperature"] },
      { model_id: openRouterModel.id, supported_parameters: ["stream"] },
    ], false],
  ] as const)("evaluates every exact OpenRouter endpoint (%s)", async (_name, endpoints, eligible) => {
    const runtime = registryWithAuth({ ok: true, headers: { Authorization: "Bearer runtime-token" } });
    const body = { data: { id: openRouterModel.id, endpoints } };
    const adapter = await acquire({ model: openRouterModel, modelRegistry: runtime.registry, signal: new AbortController().signal, fetch: vi.fn(async () => jsonResponse(body)) as unknown as typeof fetch });
    expect(adapter?.id).toBe(eligible ? "openrouter-server-search" : undefined);
  });

  it.each([
    ["malformed before valid", [
      { model_id: openRouterModel.id, supported_parameters: "tools" },
      { model_id: openRouterModel.id, supported_parameters: ["tools"] },
    ]],
    ["malformed after valid", [
      { model_id: openRouterModel.id, supported_parameters: ["tools"] },
      { model_id: openRouterModel.id, supported_parameters: "tools" },
    ]],
  ] as const)("fails consistently for malformed exact OpenRouter endpoint (%s)", async (_name, endpoints) => {
    const runtime = registryWithAuth({ ok: true, headers: { Authorization: "Bearer runtime-token" } });
    const body = { data: { id: openRouterModel.id, endpoints } };
    await expect(acquire({ model: openRouterModel, modelRegistry: runtime.registry, signal: new AbortController().signal, fetch: vi.fn(async () => jsonResponse(body)) as unknown as typeof fetch })).rejects.toThrow(/malformed/);
  });

describe("case-insensitive resolved auth for metadata acquisition", () => {

  const authCases = [
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
  ];

  it.each([
    { name: "Codex", model: codexModel, body: codexCatalog() },
    { name: "OpenRouter", model: openRouterModel, body: openRouterCatalog() },
  ])("preserves optional auth combinations case-insensitively for $name", async ({ model, body }) => {
    for (const authCase of authCases) {
      const runtime = registryWithAuth(authCase.auth);
      const providerFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse(body));

      const adapter = await acquire({
        model,
        modelRegistry: runtime.registry,
        signal: new AbortController().signal,
        fetch: providerFetch as unknown as typeof fetch,
      });

      expect(adapter, authCase.name).toBeDefined();
      const headers = new Headers(providerFetch.mock.calls[0]?.[1]?.headers);
      expect(headers.get("authorization"), authCase.name).toBe(authCase.expectedAuthorization);
      expect(headers.get("x-runtime"), authCase.name).toBe("pi");
      expect([...headers.keys()].filter((name) => name.toLowerCase() === "authorization"), authCase.name).toHaveLength(1);
    }
  });
});

describe("capability acquisition failures", () => {
  it.each([
    { ...codexModel, api: "openai-responses" },
    { ...openRouterModel, api: "openai-responses" },
    { ...openRouterModel, provider: "opencode" },
  ])("does not acquire metadata for unrelated $provider/$api gateways", async (model) => {
    const runtime = registryWithAuth({ ok: true, headers: { Authorization: "Bearer runtime-token" } });
    const providerFetch = vi.fn();
    expect(await acquire({
      model,
      modelRegistry: runtime.registry,
      signal: new AbortController().signal,
      fetch: providerFetch as unknown as typeof fetch,
    })).toBeUndefined();
    expect(runtime.getApiKeyAndHeaders).not.toHaveBeenCalled();
    expect(providerFetch).not.toHaveBeenCalled();
  });
  it.each([codexModel, openRouterModel])("classifies authentication failure for $provider as operational failure", async (model) => {
    const runtime = registryWithAuth({ ok: false, error: "authentication refresh failed" });
    const providerFetch = vi.fn();
    await expect(acquire({ model, modelRegistry: runtime.registry, signal: new AbortController().signal, fetch: providerFetch as unknown as typeof fetch })).rejects.toThrow(/authentication failed/);
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it.each([
    [codexModel, codexCatalog()],
    [openRouterModel, openRouterCatalog()],
  ] as const)("propagates cancellation while acquiring $provider metadata", async (model, body) => {
    const controller = new AbortController();
    const runtime = registryWithAuth({ ok: true, headers: { Authorization: "Bearer runtime-token" } });
    const providerFetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true });
      void body;
    }));
    const pending = acquire({
      model,
      modelRegistry: runtime.registry,
      signal: controller.signal,
      fetch: providerFetch as unknown as typeof fetch,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it.each([
    ["non-2xx", () => jsonResponse({ error: "secret-response-body" }, 503)],
    ["malformed JSON", () => new Response("secret-malformed-body", { status: 200 })],
  ])("classifies acquisition failure without leaking credentials or response bodies on %s", async (_name, response) => {
    const secret = "credential-must-not-leak";
    const runtime = registryWithAuth({ ok: true, apiKey: secret, headers: { Authorization: `Bearer ${secret}` } });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await acquire({ model: codexModel, modelRegistry: runtime.registry, signal: new AbortController().signal, fetch: vi.fn(async () => response()) as unknown as typeof fetch }).catch((failure: unknown) => failure);
    expect(result).toBeInstanceOf(Error);
    const output = JSON.stringify([log.mock.calls, warn.mock.calls, error.mock.calls, result]);
    expect(output).not.toContain(secret);
    expect(output).not.toContain("secret-response-body");
    expect(output).not.toContain("secret-malformed-body");
  });
});
