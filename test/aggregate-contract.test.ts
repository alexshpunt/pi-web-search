import { afterEach, describe, expect, it, vi } from "vitest";

import { formatSearchText } from "#src/search-format.ts";
import { performSearch } from "#src/search.ts";
import type { SearchDetails, SearchRequest, WebsearchConfig } from "#src/types.ts";

type ActiveModel = { provider: string; api: string; id: string };
type NativeSearchResult = { text: string; provider: string; model: string };
type NativeSource = {
  isEligible(model: ActiveModel): boolean;
  search(input: { query: string; model: ActiveModel; signal: AbortSignal }): Promise<NativeSearchResult>;
};
type AggregateRuntime = {
  activeModel: ActiveModel;
  nativeSource: NativeSource;
  // These legacy fields keep the RED seam safe against the pre-aggregate implementation.
  roundRobinCursor: number;
  successCounts: number[];
};
type AggregateSearch = (
  config: WebsearchConfig,
  request: SearchRequest,
  signal?: AbortSignal,
  runtime?: AggregateRuntime,
) => Promise<SearchDetails>;

// This is the package-owned deterministic seam the aggregate coordinator must implement.
// Production adapters and tests both enter through this boundary; tests never call a live model.
const aggregateSearch = performSearch as unknown as AggregateSearch;

function aggregateConfig(overrides: Record<string, unknown> = {}): WebsearchConfig {
  return {
    strategy: "priority",
    fallback: true,
    providers: [
      { id: "first", provider: "serper", apiKey: "key" },
      { id: "second", provider: "brave", apiKey: "key" },
    ],
    sourceTimeoutMs: 30_000,
    aggregateDeadlineMs: 45_000,
    ...overrides,
  } as unknown as WebsearchConfig;
}

function requestUrl(input: string | URL | Request): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
}


function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
class StartBarrier {
  readonly started = new Set<string>();
  readonly gate: Promise<void>;
  private releaseGate!: () => void;

  constructor(private readonly expected: number) {
    this.gate = new Promise<void>((resolve) => { this.releaseGate = resolve; });
  }

  async arrive(label: string): Promise<void> {
    this.started.add(label);
    if (this.started.size === this.expected) this.releaseGate();
    await this.gate;
  }

  release(): void { this.releaseGate(); }
}

function serper(items: Array<Record<string, unknown>>): Response {
  return new Response(JSON.stringify({ organic: items }));
}

function brave(items: Array<Record<string, unknown>>): Response {
  return new Response(JSON.stringify({ web: { results: items } }));
}

function nativeRuntime(overrides: Partial<NativeSource> = {}): AggregateRuntime {
  const activeModel = { provider: "openai", api: "openai-responses", id: "gpt-5" };
  return {
    activeModel,
    roundRobinCursor: 0,
    successCounts: [0, 0],
    nativeSource: {
      isEligible: () => true,
      search: async () => ({
        provider: "openai",
        model: "gpt-5",
        text: "Native evidence: https://example.com/native-shared?utm_source=model",
      }),
      ...overrides,
    },
  };
}

function statuses(details: SearchDetails): unknown[] {
  return (details.attempts ?? []).map((attempt) => (attempt as unknown as { status?: unknown }).status);
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("aggregate external search contract", () => {
  it("waits for the first provider and stops after its successful response on every query", async () => {
    const gate = deferred<Response>();
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      expect(requestUrl(input)).toContain("serper");
      return (await gate.promise).clone();
    });
    vi.stubGlobal("fetch", fetcher);
    const search = aggregateSearch(aggregateConfig(), { query: "first", maxResults: 10 });
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(1);
    gate.resolve(serper([{ title: "First", link: "https://example.com/first" }]));
    const result = await search;
    expect(result.results.map(item => item.title)).toEqual(["First"]);
    expect(result.attempts?.map(item => item.provider)).toEqual(["serper"]);
    const next = await aggregateSearch(aggregateConfig(), { query: "second", maxResults: 10 });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(next.attempts?.map(item => item.provider)).toEqual(["serper"]);
  });

  it("canonicalizes and deduplicates the selected provider's results before limiting", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => serper([
      { title: "First", link: "https://example.com/page/?utm_source=x#fragment" },
      { title: "Duplicate", link: "https://example.com/page" },
      { title: "Second", link: "https://example.com/page?x=1" },
      { title: "Third", link: "https://example.com/page?x=2" },
    ])));
    const result = await aggregateSearch(aggregateConfig(), { query: "q", maxResults: 2 });
    expect(result.results).toMatchObject([
      { title: "First", url: "https://example.com/page", sources: ["serper/first"] },
      { title: "Second", url: "https://example.com/page?x=1", sources: ["serper/first"] },
    ]);
    expect(result.truncated).toBe(true);
    expect(result.attempts?.map(item => item.provider)).toEqual(["serper"]);
  });

  it("skips disabled and unconfigured providers and advances after empty results", async () => {
    const config = aggregateConfig({ providers: [
      { id: "disabled", provider: "serper", apiKey: "key", enabled: false },
      { id: "missing", provider: "serper" },
      { id: "empty", provider: "serper", apiKey: "key" },
      { id: "working", provider: "brave", apiKey: "key" },
    ] });
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = requestUrl(input); calls.push(url);
      return url.includes("serper") ? serper([]) : brave([{ title: "Found", url: "https://example.com/found" }]);
    }));
    const result = await aggregateSearch(config, { query: "q", maxResults: 10 });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("serper");
    expect(calls[1]).toContain("brave");
    expect(result.attempts).toMatchObject([
      { entryId: "empty", status: "empty" },
      { entryId: "working", status: "success" },
    ]);
    expect(result.results.map(item => item.title)).toEqual(["Found"]);
  });

  it("returns partial results but treats completed empty sources as no usable output", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) =>
      requestUrl(input).includes("serper")
        ? new Response("serper private failure", { status: 502 })
        : brave([{ title: "Available", url: "https://example.com/available" }]),
    ));

    const partial = await aggregateSearch(aggregateConfig(), { query: "q", maxResults: 10 });
    expect(partial.error).toBeUndefined();
    expect(partial.results.map((item) => item.title)).toEqual(["Available"]);
    expect(formatSearchText(partial)).not.toContain("serper private failure");
    expect(JSON.stringify(partial.attempts)).toContain("serper private failure");

    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
    const empty = await aggregateSearch(aggregateConfig(), { query: "nothing", maxResults: 10 });
    expect(empty.results).toEqual([]);
    expect(empty.error).toBe("Web search failed: all eligible sources failed or timed out. All configured search providers failed.");
    expect(formatSearchText(empty)).toBe(empty.error);
  });

  it("returns one aggregate failure without leaking individual failures", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const provider = requestUrl(input).includes("serper") ? "serper" : "brave";
      return new Response(`${provider} private failure`, { status: 503 });
    }));

    const details = await aggregateSearch(aggregateConfig(), { query: "q", maxResults: 10 });
    const text = formatSearchText(details);

    expect(details.error).toBeTruthy();
    expect(text.toLowerCase()).toContain("web search failed");
    expect(text).not.toContain("serper private failure");
    expect(text).not.toContain("brave private failure");
    expect(JSON.stringify(details.attempts)).toContain("serper private failure");
    expect(JSON.stringify(details.attempts)).toContain("brave private failure");
  });
});

describe("raw native-first aggregate contract", () => {
  it("runs native and the first external provider concurrently and keeps both outputs", async () => {
    const barrier = new StartBarrier(2);
    const nativeAnswer = "Native evidence: https://example.com/native-shared?utm_source=model";
    const runtime = nativeRuntime({
      search: async () => {
        await barrier.arrive("native");
        return { provider: "openai", model: "gpt-5", text: nativeAnswer };
      },
    });
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const provider = requestUrl(input).includes("serper") ? "serper" : "brave";
      await barrier.arrive(provider);
      return serper([
        { title: "Shared title", link: "https://example.com/native-shared?fbclid=x", snippet: "Shared evidence." },
        { title: "Serper only", link: "https://example.com/serper-only" },
      ]);
    });
    vi.stubGlobal("fetch", fetcher);
    const search = aggregateSearch(aggregateConfig(), { query: "q", maxResults: 20 }, undefined, runtime);
    await settle();
    const started = [...barrier.started].sort();
    barrier.release();
    const details = await search;
    expect(started).toEqual(["native", "serper"]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(details.native).toMatchObject({ status: "success", provider: "openai", model: "gpt-5" });
    expect(details.answer).toBe(nativeAnswer);
    expect(details.attempts?.map(item => item.provider)).toEqual(["serper"]);
    expect(formatSearchText(details)).toBe([
      nativeAnswer, "", "1. Shared title", "   https://example.com/native-shared",
      "   Excerpt: “Shared evidence.”", "   Sources: serper/first",
      "2. Serper only", "   https://example.com/serper-only", "   Sources: serper/first",
    ].join("\n"));
  });

  it("classifies whitespace-only native prose as unusable without hiding external output", async () => {
    const runtime = nativeRuntime({
      search: async () => ({ provider: "openai", model: "gpt-5", text: " \n\t " }),
    });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) =>
      requestUrl(input).includes("serper")
        ? serper([{ title: "External survives", link: "https://example.com/external" }])
        : brave([]),
    ));

    const details = await aggregateSearch(aggregateConfig(), { query: "q", maxResults: 10 }, undefined, runtime);

    expect(details.answer).toBeUndefined();
    expect(details.native).toMatchObject({ status: "empty", provider: "openai", model: "gpt-5" });
    expect(formatSearchText(details)).toBe([
      "1. External survives",
      "   https://example.com/external",
      "   Sources: serper/first",
    ].join("\n"));
  });

  it("does not invoke the native seam when the active model is not eligible", async () => {
    const searchNative = vi.fn<NativeSource["search"]>();
    const isEligible = vi.fn(() => false);
    const runtime = nativeRuntime({ isEligible, search: searchNative });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) =>
      requestUrl(input).includes("serper") ? serper([]) : brave([]),
    ));

    const details = await aggregateSearch(aggregateConfig(), { query: "q", maxResults: 10 }, undefined, runtime);

    expect(searchNative).not.toHaveBeenCalled();

    expect(isEligible).toHaveBeenCalledWith({ provider: "openai", api: "openai-responses", id: "gpt-5" });
    expect(details).toMatchObject({ native: { status: "ineligible" } });
  });

  it("keeps a native failure out of successful text and preserves bounded duration diagnostics", async () => {
    const longFailure = "native private failure ".repeat(100);
    const runtime = nativeRuntime({ search: async () => { throw new Error(longFailure); } });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) =>
      requestUrl(input).includes("serper")
        ? serper([{ title: "External", link: "https://example.com/external" }])
        : brave([]),
    ));

    const details = await aggregateSearch(aggregateConfig(), { query: "q", maxResults: 10 }, undefined, runtime);
    const output = formatSearchText(details);

    expect(output).toContain("External");
    expect(output).not.toContain("native private failure");
    expect(details.native).toMatchObject({ status: "failure", provider: "openai", model: "gpt-5" });
    expect(details.native?.durationMs).toBeGreaterThanOrEqual(0);
    expect(details.native?.error?.length).toBeLessThanOrEqual(500);
  });
});

describe("aggregate lifecycle contract with controlled time", () => {
  it("keeps one source timeout budget across acquisition and native completion", async () => {
    vi.useFakeTimers();
    const model = { provider: "openai-codex", api: "openai-codex-responses", id: "gpt-5.3-codex", baseUrl: "https://chatgpt.com/backend-api" };
    const completionStarted = deferred<void>();
    let completionSignal: AbortSignal | undefined;
    const complete = vi.fn(async (_model: unknown, _context: unknown, options?: Record<string, unknown>) => {
      completionSignal = options?.signal as AbortSignal | undefined;
      completionStarted.resolve(undefined);
      return new Promise<{ content: Array<{ type: string; text: string }> }>((resolve) => {
        completionSignal?.addEventListener("abort", () => resolve({ content: [{ type: "text", text: "late native completion" }] }), { once: true });
      });
    });
    const runtime = {
      activeModel: model,
      modelRegistry: {
        getApiKeyAndHeaders: vi.fn(async () => ({ ok: true as const, apiKey: "codex-secret" })),
        complete,
      },
    } as unknown as AggregateRuntime;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = requestUrl(input);
      if (url.includes("/codex/models")) {
        await new Promise<void>((resolve) => setTimeout(resolve, 29_000));
        return new Response(JSON.stringify({ models: [{ slug: model.id, supports_search_tool: true }] }));
      }
      return url.includes("serper")
        ? serper([{ title: "External survives", link: "https://example.com/external" }])
        : brave([]);
    }));

    const search = aggregateSearch(aggregateConfig(), { query: "q", maxResults: 10 }, undefined, runtime);
    await settle();
    await vi.advanceTimersByTimeAsync(29_000);
    await settle();
    await completionStarted.promise;
    expect(complete).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1_000);
    const details = await search;

    expect(completionSignal?.aborted).toBe(true);
    expect(details.native).toMatchObject({
      status: "timeout",
      provider: model.provider,
      model: model.id,
      timeoutReason: "source-timeout",
    });
    expect(details.results.map((item) => item.title)).toEqual(["External survives"]);
  });

  it("applies the source timeout to native work without losing external success", async () => {
    vi.useFakeTimers();
    let nativeAborted = false;
    let releaseNative!: () => void;
    const runtime = nativeRuntime({
      search: ({ signal }) => new Promise<NativeSearchResult>((resolve) => {
        releaseNative = () => resolve({ text: "late", provider: "openai", model: "gpt-5" });
        signal.addEventListener("abort", () => { nativeAborted = true; releaseNative(); }, { once: true });
      }),
    });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) =>
      requestUrl(input).includes("serper")
        ? serper([{ title: "Fast", link: "https://example.com/fast" }])
        : brave([]),
    ));

    const search = aggregateSearch(
      aggregateConfig({ sourceTimeoutMs: 30_000, aggregateDeadlineMs: 45_000 }),
      { query: "q", maxResults: 10 },
      undefined,
      runtime,
    );
    await settle();
    await vi.advanceTimersByTimeAsync(30_000);
    const abortedAtTimeout = nativeAborted;
    releaseNative?.();
    const details = await search;

    expect(abortedAtTimeout).toBe(true);
    expect(details.results.map((item) => item.title)).toEqual(["Fast"]);
    expect(details).toMatchObject({ native: { status: "timeout" } });
  });

  it("applies the source timeout to one external source without losing another success", async () => {
    vi.useFakeTimers();
    let slowAborted = false;
    let releaseSlow!: () => void;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (requestUrl(input).includes("brave")) {
        return brave([{ title: "Fast", url: "https://example.com/fast" }]);
      }
      return new Promise<Response>((resolve) => {
        releaseSlow = () => resolve(new Response("late", { status: 503 }));
        init?.signal?.addEventListener("abort", () => { slowAborted = true; releaseSlow(); }, { once: true });
      });
    }));

    const search = aggregateSearch(
      aggregateConfig({ sourceTimeoutMs: 30_000, aggregateDeadlineMs: 45_000 }),
      { query: "q", maxResults: 10 },
    );
    await settle();
    await vi.advanceTimersByTimeAsync(30_000);
    const abortedAtTimeout = slowAborted;
    releaseSlow?.();
    const details = await search;

    expect(abortedAtTimeout).toBe(true);
    expect(details.results.map((item) => item.title)).toEqual(["Fast"]);
    expect(statuses(details)).toEqual(["timeout", "success"]);
  });

  it("records a source timeout then the aggregate deadline for the active fallback only", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async () => new Promise<Response>(() => undefined));
    vi.stubGlobal("fetch", fetcher);
    const config = aggregateConfig({ sourceTimeoutMs: 1_000, aggregateDeadlineMs: 1_500, providers: [
      { id: "one", provider: "serper", apiKey: "key" },
      { id: "two", provider: "brave", apiKey: "key" },
      { id: "never", provider: "tavily", apiKey: "key" },
    ] });
    const search = aggregateSearch(config, { query: "q", maxResults: 10 });
    await settle();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(500);
    const details = await search;
    expect(details.attempts).toMatchObject([
      { entryId: "one", status: "timeout", timeoutReason: "source-timeout" },
      { entryId: "two", status: "timeout", timeoutReason: "aggregate-deadline" },
    ]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("turns every unfinished source into one private aggregate-deadline failure", async () => {
    vi.useFakeTimers();
    const aborted = new Set<string>();
    const releases: Array<() => void> = [];
    let forceReleased = false;
    const runtime = nativeRuntime({
      search: ({ signal }) => new Promise<NativeSearchResult>((resolve) => {
        const release = () => resolve({
          text: "native private late result",
          provider: "openai",
          model: "gpt-5",
        });
        releases.push(release);
        signal.addEventListener("abort", () => { aborted.add("native"); release(); }, { once: true });
      }),
    });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const provider = requestUrl(input).includes("serper") ? "serper" : "brave";
      if (forceReleased) return new Response(`${provider} private late result`, { status: 503 });
      return new Promise<Response>((resolve) => {
        const release = () => resolve(new Response(`${provider} private late result`, { status: 503 }));
        releases.push(release);
        init?.signal?.addEventListener("abort", () => { aborted.add(provider); release(); }, { once: true });
      });
    }));

    const search = aggregateSearch(
      aggregateConfig({ sourceTimeoutMs: 60_000, aggregateDeadlineMs: 45_000 }),
      { query: "q", maxResults: 10 },
      undefined,
      runtime,
    );
    await settle();
    await vi.advanceTimersByTimeAsync(45_000);
    const abortedAtDeadline = [...aborted].sort();
    forceReleased = true;
    for (const release of releases) release();
    const details = await search;
    const output = formatSearchText(details);

    expect(abortedAtDeadline).toEqual(["native", "serper"]);
    expect(details.results).toEqual([]);
    expect(details.error).toBeTruthy();
    expect(details).toMatchObject({
      native: {
        status: "timeout",
        provider: "openai",
        model: "gpt-5",
        timeoutReason: "aggregate-deadline",
      },
      attempts: [
        expect.objectContaining({ provider: "serper", status: "timeout", timeoutReason: "aggregate-deadline" }),
      ],
    });
    expect(output.match(/web search failed/gi)).toHaveLength(1);
    expect(output).not.toContain("native private late result");
    expect(output).not.toContain("serper private late result");
    expect(output).not.toContain("brave private late result");
  });

  it("propagates caller cancellation to native work and the attempted external fetch and rejects partial output", async () => {
    const controller = new AbortController();
    const barrier = new StartBarrier(2);
    const aborted = new Set<string>();
    const runtime = nativeRuntime({
      search: async ({ signal }) => {
        await barrier.arrive("native");
        return new Promise<NativeSearchResult>((_resolve, reject) => {
          signal.addEventListener("abort", () => { aborted.add("native"); reject(signal.reason); }, { once: true });
        });
      },
    });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const provider = requestUrl(input).includes("serper") ? "serper" : "brave";
      await barrier.arrive(provider);
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => { aborted.add(provider); reject(init.signal?.reason); }, { once: true });
      });
    }));

    const search = aggregateSearch(aggregateConfig(), { query: "q", maxResults: 10 }, controller.signal, runtime);
    await settle();
    const started = [...barrier.started].sort();
    barrier.release();
    await settle();
    controller.abort(new Error("caller cancelled"));
    const rejection = await search.then(() => undefined, (error: unknown) => error);

    expect(started).toEqual(["native", "serper"]);
    expect([...aborted].sort()).toEqual(["native", "serper"]);
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toContain("caller cancelled");
  });
});


describe("aggregate deadline against abort-ignoring work", () => {
  it("settles at the aggregate deadline and never aborts the caller signal", async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const runtime = {
      activeModel: { provider: "openrouter", api: "openai-completions", id: "openai/gpt-5.6", baseUrl: "https://openrouter.ai/api/v1" },
      modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, headers: { Authorization: "Bearer test" } }) },
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Promise<Response>(() => undefined)));
    const search = aggregateSearch(aggregateConfig({ aggregateDeadlineMs: 1_000, sourceTimeoutMs: 60_000 }), { query: "q", maxResults: 10 }, caller.signal, runtime as never);
    await settle();
    await vi.advanceTimersByTimeAsync(1_000);
    const details = await search;
    expect(details.error).toBeTruthy();
    expect(details.attempts).toEqual([
      expect.objectContaining({ provider: "serper", timeoutReason: "aggregate-deadline" }),
    ]);
    expect(details.native).toMatchObject({ status: "timeout", timeoutReason: "aggregate-deadline" });
    expect(caller.signal.aborted).toBe(false);
  });
});


describe("native completion deadline against abort-ignoring work", () => {
  it("returns aggregate diagnostics when native completion and external fetch never settle", async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const runtime = nativeRuntime({ search: async () => new Promise<NativeSearchResult>(() => undefined) });
    vi.stubGlobal("fetch", vi.fn(async () => new Promise<Response>(() => undefined)));
    const search = aggregateSearch(aggregateConfig({ aggregateDeadlineMs: 1_000, sourceTimeoutMs: 60_000 }), { query: "q", maxResults: 10 }, caller.signal, runtime);
    await settle();
    await vi.advanceTimersByTimeAsync(1_000);
    const details = await search;
    expect(details.native).toMatchObject({ status: "timeout", timeoutReason: "aggregate-deadline" });
    expect(details.attempts).toEqual([
      expect.objectContaining({ provider: "serper", timeoutReason: "aggregate-deadline" }),
    ]);
    expect(caller.signal.aborted).toBe(false);
  });
});
