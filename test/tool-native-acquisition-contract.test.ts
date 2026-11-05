import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import registerWebSearch from "../index.ts";

const oldNativeSourceSymbol = Symbol.for("pi-web-search.native-source");
// Package-owned test seam: the registered tool must resolve this exact callable
// transport and pass it unchanged to capability, external, and native work.
const runtimeTransportSymbol = Symbol.for("pi-web-search.runtime-transport");

type ActiveModel = {
  provider: string;
  api: string;
  id: string;
  baseUrl: string;
};

type SearchResult = { native?: { status?: string; timeoutReason?: string }; results?: Array<{ title?: string }>; answer?: string; attempts?: unknown[]; error?: string };
type ToolResult = { content: Array<{ type: string; text: string }>; details: SearchResult };
type CapturedTool = {
  execute(toolCallId: string, parameters: { query: string; limit?: number }, signal: AbortSignal, onUpdate: (result: unknown) => void,
    context: { cwd: string; model: ActiveModel; modelRegistry: ModelRegistry }): Promise<ToolResult>;
  wait(): Promise<Array<{ requestId: string; query: string; search?: SearchResult }>>;
};

const workspaces: string[] = [];
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

class StartBarrier {
  readonly started = new Set<string>();
  private readonly gate: Promise<void>;
  private releaseGate!: () => void;

  constructor(private readonly expected: number) {
    this.gate = new Promise<void>((resolve) => { this.releaseGate = resolve; });
  }

  async arrive(label: string): Promise<void> {
    this.started.add(label);
    if (this.started.size === this.expected) this.releaseGate();
    await this.gate;
  }
}


async function settle(): Promise<void> {
  for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function captureTool(): Promise<CapturedTool> {
  let captured: CapturedTool | undefined;
  let waitTool: { execute(...args: unknown[]): Promise<{ details: { results: Array<{ requestId: string; query: string; search?: SearchResult }> } }> } | undefined;
  await registerWebSearch({
    on: vi.fn(),
    sendMessage: vi.fn(),
    appendEntry: vi.fn(),
    registerMessageRenderer: vi.fn(),
    registerEntryRenderer: vi.fn(),
    registerTool: (tool: CapturedTool & { name: string }) => {
      if (tool.name === "web_search") captured = tool;
      if (tool.name === "wait_for_web_searches") waitTool = tool as unknown as typeof waitTool;
    },
    registerCommand: vi.fn(),
  } as unknown as Parameters<typeof registerWebSearch>[0]);
  expect(captured).toBeDefined();
  expect(waitTool).toBeDefined();
  return {
    execute: (id, parameters, signal, update, context) => captured!.execute(id, parameters, signal, update, {
      ...context, ui: { setStatus: vi.fn() }, isIdle: () => false,
    } as typeof context),
    wait: async () => (await waitTool!.execute("wait", {}, undefined)).details.results,
  };
}

async function workspace(overrides: Record<string, unknown> = {}): Promise<string> {
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-web-search-acquisition-"));
  workspaces.push(cwd);
  await mkdir(path.join(cwd, ".pi"), { recursive: true });
  await writeFile(path.join(cwd, ".pi", "websearch.json"), JSON.stringify({
    providers: [{ id: "external", provider: "serper", apiKey: "external-key" }],
    ...overrides,
  }));
  return cwd;
}

function assistant(text: string, activeModel = codexModel) {
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
}

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (globalThis as Record<symbol, unknown>)[oldNativeSourceSymbol];
  delete (globalThis as Record<symbol, unknown>)[runtimeTransportSymbol];
  await Promise.all(workspaces.splice(0).map((cwd) => rm(cwd, { recursive: true, force: true })));
});

describe("real tool/coordinator native capability acquisition", () => {
  it.each([
    { provider: "openai", api: "openai-responses", id: "gpt-5.4", baseUrl: "https://api.openai.com/v1" },
    { provider: "anthropic", api: "anthropic-messages", id: "claude", baseUrl: "https://api.anthropic.com" },
    codexModel,
  ])("does not search with active $provider without a Codex subscription", async (model) => {
    const cwd = await workspace({ providers: [] });
    const tool = await captureTool();
    const complete = vi.fn(async (activeModel: ActiveModel) => assistant("Unexpected native answer", activeModel));
    const metadataFetch = vi.fn(async () => Response.json({ models: [{ slug: codexModel.id, supports_search_tool: true }] }));
    (globalThis as Record<symbol, unknown>)[runtimeTransportSymbol] = metadataFetch;
    const result = await tool.execute("call", { query: "q" }, new AbortController().signal, vi.fn(), {
      cwd, model,
      modelRegistry: { complete, getAvailable: () => [codexModel], isUsingOAuth: () => false, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "not-oauth" }) } as unknown as ModelRegistry,
    });
    expect(complete).not.toHaveBeenCalled();
    expect(metadataFetch).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({ native: { status: "ineligible" }, results: [], attempts: [] });
  });

  it("returns external results without invoking the active model when there is no subscription", async () => {
    const cwd = await workspace();
    const tool = await captureTool();
    const complete = vi.fn();
    const transport = vi.fn(async () => Response.json({ organic: [{ title: "External", link: "https://example.com/external" }] }));
    (globalThis as Record<symbol, unknown>)[runtimeTransportSymbol] = transport;
    const model = { provider: "openai", api: "openai-responses", id: "gpt-5.4", baseUrl: "https://api.openai.com/v1" };
    const result = await tool.execute("call", { query: "q" }, new AbortController().signal, vi.fn(), {
      cwd, model, modelRegistry: { complete, getAvailable: () => [], isUsingOAuth: () => false } as unknown as ModelRegistry,
    });
    expect(complete).not.toHaveBeenCalled();
    expect(transport).toHaveBeenCalledOnce();
    expect(result.details).toMatchObject({ results: [{ title: "External" }] });
    expect(await tool.wait()).toEqual([]);
  });
  it("returns the detailed no-usable-output result with empty providers and an ineligible active model", async () => {
    const cwd = await workspace({ providers: [] });
    const tool = await captureTool();
    const model: ActiveModel = {
      provider: "opencode-go",
      api: "openai-completions",
      id: "opencode-go-model",
      baseUrl: "https://opencode.ai/api/v1",
    };

    const result = await tool.execute("call", { query: "q" }, new AbortController().signal, vi.fn(), {
      cwd,
      model,
      modelRegistry: {} as ModelRegistry,
    });

    expect(result.content[0]?.text).toBe(
      "Web search failed: all eligible sources failed or timed out. All configured search providers failed.",
    );
    expect(result.details).toMatchObject({
      native: { status: "ineligible" },
      results: [],
      attempts: [],
    });
  });

  it("uses the subscription model with another active model while the external search runs", async () => {
    const cwd = await workspace();
    const tool = await captureTool();
    const signal = new AbortController().signal;
    const barrier = new StartBarrier(2);
    const auth = { ok: true as const, apiKey: "codex-secret", headers: { "x-pi-runtime": "configured" } };
    const getApiKeyAndHeaders = vi.fn(async () => auth);
    let completionOptions: Record<string, unknown> | undefined;
    const complete = vi.fn(async (model: ActiveModel, _context: unknown, options?: Record<string, unknown>) => {
      completionOptions = options;
      await barrier.arrive("native");
      return assistant(`Codex evidence from ${model.id}`);
    });
    const modelRegistry = { getAvailable: () => [codexModel], isUsingOAuth: () => true, getApiKeyAndHeaders, complete } as unknown as ModelRegistry;
    const metadataCalls: Array<{ input: string; init?: RequestInit }> = [];
    const injectedTransport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/codex/models")) {
        metadataCalls.push({ input: url, init });
        return new Response(JSON.stringify({ models: [{ slug: codexModel.id, supports_search_tool: true }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.startsWith("https://google.serper.dev/")) {
        await barrier.arrive("external");
        return new Response(JSON.stringify({ organic: [{ title: "External success", link: "https://example.com/external" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected transport URL: ${url}`);
    });
    const globalFetch = vi.fn(() => { throw new Error("registered tool bypassed runtime transport seam"); });
    vi.stubGlobal("fetch", globalFetch);
    (globalThis as Record<symbol, unknown>)[runtimeTransportSymbol] = injectedTransport;
    const bypassSearch = vi.fn(async () => ({ provider: "bypass", model: "wrong", text: "must not run" }));
    (globalThis as Record<symbol, unknown>)[oldNativeSourceSymbol] = { isEligible: () => true, search: bypassSearch };

    const result = await tool.execute("call", { query: "q" }, signal, vi.fn(), {
      cwd,
      model: openRouterModel,
      modelRegistry,
    });

    expect(metadataCalls).toHaveLength(1);
    expect(new URL(metadataCalls[0]!.input).searchParams.get("client_version")).toBe("0.151.0");
    expect(metadataCalls[0]!.init?.signal).toBeDefined();
    expect(metadataCalls[0]!.init?.signal).not.toBe(signal);
    expect(getApiKeyAndHeaders).toHaveBeenCalledOnce();
    expect(getApiKeyAndHeaders).toHaveBeenCalledWith(codexModel);
    expect(complete).toHaveBeenCalledOnce();
    expect(complete.mock.calls[0]?.[0]).toBe(codexModel);
    expect(completionOptions).toMatchObject({ onPayload: expect.any(Function) });
    expect(completionOptions?.fetch).toBe(injectedTransport);
    expect(injectedTransport.mock.calls.map(([input]) => String(input))).toEqual(expect.arrayContaining([
      expect.stringContaining("/codex/models"),
      expect.stringMatching(/^https:\/\/google\.serper\.dev\//),
    ]));
    expect(globalFetch).not.toHaveBeenCalled();
    expect([...barrier.started].sort()).toEqual(["external", "native"]);
    expect(bypassSearch).not.toHaveBeenCalled();
    expect(result.content[0]?.text).toContain("Codex evidence");
    expect(result.details.native).toMatchObject({ status: "success" });
    expect(await tool.wait()).toMatchObject([{ requestId: "call", query: "q", search: { results: [{ title: "External success" }] } }]);
  });


  it("starts external work before metadata resolves and delivers each source independently", async () => {
    const cwd = await workspace();
    const tool = await captureTool();
    const signal = new AbortController().signal;
    const metadata = deferred<Response>();
    const external = deferred<Response>();
    const native = deferred<ReturnType<typeof assistant>>();
    const metadataStarted = deferred<void>();
    const externalStarted = deferred<void>();
    const started: string[] = [];
    const complete = vi.fn(async (_model: ActiveModel, _context: unknown, _options?: Record<string, unknown>) => {
      started.push("native");
      return native.promise;
    });
    const modelRegistry = {
      getAvailable: () => [codexModel], isUsingOAuth: () => true,
      getApiKeyAndHeaders: vi.fn(async () => ({ ok: true as const, apiKey: "codex-secret" })),
      complete,
    } as unknown as ModelRegistry;
    const transport = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/codex/models")) {
        started.push("metadata");
        metadataStarted.resolve(undefined);
        return metadata.promise;
      }
      if (url.startsWith("https://google.serper.dev/")) {
        started.push("external");
        externalStarted.resolve(undefined);
        return external.promise;
      }
      throw new Error(`unexpected transport URL: ${url}`);
    });
    (globalThis as Record<symbol, unknown>)[runtimeTransportSymbol] = transport;
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("global fetch must not run"); }));

    const pending = tool.execute("call", { query: "q" }, signal, vi.fn(), { cwd, model: codexModel, modelRegistry });
    await Promise.race([
      Promise.all([metadataStarted.promise, externalStarted.promise]),
      pending.then(() => undefined),
    ]);
    expect(started).toEqual(expect.arrayContaining(["metadata", "external"]));
    expect(complete).not.toHaveBeenCalled();

    metadata.resolve(new Response(JSON.stringify({ models: [{ slug: codexModel.id, supports_search_tool: true }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    await settle();
    expect(started).toEqual(expect.arrayContaining(["metadata", "external", "native"]));
    expect(complete).toHaveBeenCalledOnce();
    expect(complete.mock.calls[0]?.[2]?.fetch).toBe(transport);

    native.resolve(assistant("Native joins while external remains outstanding"));
    external.resolve(new Response(JSON.stringify({ organic: [{ title: "External finishes", link: "https://example.com/external" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const result = await pending;
    expect(result.content[0]?.text).toContain("Native joins");
    expect(await tool.wait()).toMatchObject([{ requestId: "call", query: "q", search: { results: [{ title: "External finishes" }] } }]);
  });

  it("shares caller cancellation with metadata, native completion, and external work", async () => {
    const cwd = await workspace();
    const tool = await captureTool();
    const controller = new AbortController();
    const started = new Set<string>();
    const aborted = new Set<string>();
    const nativeStarted = deferred<void>();
    const externalStarted = deferred<void>();
    let metadataSignal: AbortSignal | undefined;
    let nativeSignal: AbortSignal | undefined;
    let externalSignal: AbortSignal | undefined;
    const complete = vi.fn(async (_model: ActiveModel, _context: unknown, options?: Record<string, unknown>) => {
      started.add("native");
      nativeStarted.resolve(undefined);
      nativeSignal = options?.signal as AbortSignal | undefined;
      return new Promise<ReturnType<typeof assistant>>((_resolve, reject) => {
        nativeSignal?.addEventListener("abort", () => { aborted.add("native"); reject(nativeSignal?.reason); }, { once: true });
      });
    });
    const modelRegistry = {
      getAvailable: () => [codexModel], isUsingOAuth: () => true,
      getApiKeyAndHeaders: vi.fn(async () => ({ ok: true as const, apiKey: "codex-secret" })),
      complete,
    } as unknown as ModelRegistry;
    const transport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/codex/models")) {
        started.add("metadata");
        metadataSignal = init?.signal ?? undefined;
        return new Response(JSON.stringify({ models: [{ slug: codexModel.id, supports_search_tool: true }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.startsWith("https://google.serper.dev/")) {
        started.add("external");
        externalStarted.resolve(undefined);
        externalSignal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          externalSignal?.addEventListener("abort", () => { aborted.add("external"); reject(externalSignal?.reason); }, { once: true });
        });
      }
      throw new Error(`unexpected transport URL: ${url}`);
    });
    (globalThis as Record<symbol, unknown>)[runtimeTransportSymbol] = transport;
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("global fetch must not run"); }));

    const pending = tool.execute("call", { query: "q" }, controller.signal, vi.fn(), {
      cwd,
      model: codexModel,
      modelRegistry,
    });
    await Promise.race([
      Promise.all([externalStarted.promise, nativeStarted.promise]),
      pending.then(() => undefined),
    ]);
    expect([...started].sort()).toEqual(["external", "metadata", "native"]);
    expect(metadataSignal).toBeDefined();
    expect(metadataSignal).not.toBe(controller.signal);
    controller.abort(new Error("caller cancelled"));
    const failure = await pending.catch((error: unknown) => error);

    expect(nativeSignal?.aborted).toBe(true);
    expect(externalSignal?.aborted).toBe(true);
    expect([...aborted].sort()).toEqual(["external", "native"]);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).toBe(controller.signal.reason);
  });


  it("applies the aggregate deadline to pending metadata and external work before native can start", async () => {
    vi.useFakeTimers();
    const cwd = await workspace({ sourceTimeoutMs: 60_000, aggregateDeadlineMs: 45_000 });
    const tool = await captureTool();
    const aborted = new Set<string>();
    const metadataStarted = deferred<void>();
    const externalStarted = deferred<void>();
    const complete = vi.fn();
    const modelRegistry = {
      getAvailable: () => [codexModel], isUsingOAuth: () => true,
      getApiKeyAndHeaders: vi.fn(async () => ({ ok: true as const, apiKey: "codex-secret" })),
      complete,
    } as unknown as ModelRegistry;
    const transport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const label = url.includes("/codex/models") ? "metadata" : "external";
      (label === "metadata" ? metadataStarted : externalStarted).resolve(undefined);
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborted.add(label);
          reject(init.signal?.reason);
        }, { once: true });
      });
    });
    (globalThis as Record<symbol, unknown>)[runtimeTransportSymbol] = transport;
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("global fetch must not run"); }));

    const pending = tool.execute("call", { query: "q" }, new AbortController().signal, vi.fn(), {
      cwd,
      model: codexModel,
      modelRegistry,
    });
    await Promise.race([
      Promise.all([metadataStarted.promise, externalStarted.promise]),
      pending.then(() => undefined),
    ]);
    await vi.advanceTimersByTimeAsync(45_000);
    const result = await pending;

    expect([...aborted].sort()).toEqual(["external", "metadata"]);
    expect(complete).not.toHaveBeenCalled();
    expect(result.details.native).toMatchObject({ status: "timeout", timeoutReason: "aggregate-deadline" });
    expect(result.content[0]?.text).toMatch(/web search failed/i);
  });

  it.each([
    ["failed", () => new Response("private metadata body", { status: 503 })],
    ["malformed", () => new Response("not-json", { status: 200 })],
    ["wrong model", () => new Response(JSON.stringify({ models: [{ slug: "other-model", supports_search_tool: true }] }), { status: 200 })],
  ])("classifies native acquisition after %s while external search still succeeds", async (name, metadataResponse) => {
    const cwd = await workspace();
    const tool = await captureTool();
    const signal = new AbortController().signal;
    const complete = vi.fn();
    const modelRegistry = {
      getAvailable: () => [codexModel], isUsingOAuth: () => true,
      getApiKeyAndHeaders: vi.fn(async () => ({ ok: true as const, apiKey: "codex-secret" })),
      complete,
    } as unknown as ModelRegistry;
    const injectedTransport = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/codex/models")) return metadataResponse();
      if (url.startsWith("https://google.serper.dev/")) {
        return new Response(JSON.stringify({ organic: [{ title: "External survives", link: "https://example.com/survives" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected transport URL: ${url}`);
    });
    const globalFetch = vi.fn(() => { throw new Error("registered tool bypassed runtime transport seam"); });
    vi.stubGlobal("fetch", globalFetch);
    (globalThis as Record<symbol, unknown>)[runtimeTransportSymbol] = injectedTransport;
    const bypassSearch = vi.fn(async () => ({ provider: "bypass", model: "wrong", text: "must not run" }));
    (globalThis as Record<symbol, unknown>)[oldNativeSourceSymbol] = { isEligible: () => true, search: bypassSearch };

    const result = await tool.execute("call", { query: "q" }, signal, vi.fn(), { cwd, model: codexModel, modelRegistry });

    expect(complete).not.toHaveBeenCalled();
    expect(bypassSearch).not.toHaveBeenCalled();
    expect(result.content[0]?.text).toContain("External survives");
    expect(result.content[0]?.text).not.toContain("private metadata body");
    const late = await tool.wait();
    if (name === "wrong model") {
      expect(late).toEqual([]);
    } else {
      expect(late).toMatchObject([{ requestId: "call", query: "q", search: { native: { status: "failure" } } }]);
      expect(JSON.stringify(late)).not.toContain("private metadata body");
    }
    expect(result.details.results?.map((item) => item.title)).toEqual(["External survives"]);
    expect(globalFetch).not.toHaveBeenCalled();
  });
});
