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
  it("starts every external source before allowing any source to finish", async () => {
    const barrier = new StartBarrier(2);
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const provider = requestUrl(input).includes("serper") ? "serper" : "brave";
      await barrier.arrive(provider);
      return provider === "serper"
        ? serper([{ title: "Serper", link: "https://example.com/serper" }])
        : brave([{ title: "Brave", url: "https://example.com/brave" }]);
    }));

    const search = aggregateSearch(aggregateConfig(), { query: "q", maxResults: 20 });
    await settle();
    const beforeRelease = [...barrier.started].sort();
    barrier.release();
    await search;

    expect(beforeRelease).toEqual(["brave", "serper"]);
  });

  it("ranks independent canonical results by distinct-source agreement first", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) =>
      requestUrl(input).includes("serper")
        ? serper([
          { title: "Only first", link: "https://example.com/only-first" },
          { title: "Shared", link: "https://example.com/shared?utm_source=first" },
        ])
        : brave([
          { title: "Only second", url: "https://example.com/only-second" },
          { title: "Shared", url: "https://example.com/shared?fbclid=second" },
        ]),
    ));

    const details = await aggregateSearch(aggregateConfig(), { query: "q", maxResults: 20 });

    expect(details.results[0]).toMatchObject({
      title: "Shared",
      sources: ["serper/first", "brave/second"],
    });
  });

  it("merges external URLs that differ only by an empty trailing slash", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) =>
      requestUrl(input).includes("serper")
        ? serper([{ title: "Trailing slash", link: "https://example.com/page/" }])
        : brave([{ title: "Canonical page", url: "https://example.com/page" }]),
    ));

    const details = await aggregateSearch(aggregateConfig(), { query: "q", maxResults: 20 });

    expect(details.results).toHaveLength(1);
    expect(details.results[0]).toMatchObject({
      url: "https://example.com/page",
      sources: ["serper/first", "brave/second"],
    });
  });

  it("keeps root URLs and meaningful path/query distinctions while normalizing one trailing slash", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) =>
      requestUrl(input).includes("serper")
        ? serper([
          { title: "Root", link: "https://example.com/" },
          { title: "Path", link: "https://example.com/a/" },
          { title: "Query one", link: "https://example.com/a?x=1" },
        ])
        : brave([
          { title: "Root duplicate", url: "https://example.com" },
          { title: "Path duplicate", url: "https://example.com/a" },
          { title: "Query two", url: "https://example.com/a?x=2" },
          { title: "Double slash", url: "https://example.com/a//" },
        ]),
    ));

    const details = await aggregateSearch(aggregateConfig(), { query: "q", maxResults: 20 });

    expect(details.results.map((item) => item.url).sort()).toEqual([
      "https://example.com/",
      "https://example.com/a",
      "https://example.com/a/",
      "https://example.com/a?x=1",
      "https://example.com/a?x=2",
    ]);
    expect(details.results.find((item) => item.url === "https://example.com/a")?.sources).toEqual(["serper/first", "brave/second"]);
  });

  it("combines normalized positions across sources after agreement ties", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) =>
      requestUrl(input).includes("serper")
        ? serper([
          { title: "X", link: "https://example.com/x" },
          { title: "Y", link: "https://example.com/y" },
          { title: "Filler A", link: "https://example.com/a" },
        ])
        : brave([
          { title: "Y", url: "https://example.com/y" },
          { title: "Filler B", url: "https://example.com/b" },
          { title: "X", url: "https://example.com/x" },
        ]),
    ));

    const details = await aggregateSearch(aggregateConfig(), { query: "q", maxResults: 20 });

    expect(details.results.slice(0, 2).map((item) => item.url)).toEqual([
      "https://example.com/y",
      "https://example.com/x",
    ]);
  });

  it("uses normalized provider scores alone after agreement and position ties", async () => {
    const config = aggregateConfig({ providers: [
      { id: "exa-one", provider: "exa", apiKey: "one" },
      { id: "exa-two", provider: "exa", apiKey: "two" },
    ] });
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const apiKey = new Headers(init?.headers).get("x-api-key");
      return new Response(JSON.stringify({ results: apiKey === "one"
        ? [
          { title: "Lower score", url: "https://example.com/a-lower", score: 0.2 },
          { title: "Higher score", url: "https://example.com/z-higher", score: 0.9 },
        ]
        : [
          { title: "Higher score", url: "https://example.com/z-higher", score: 0.8 },
          { title: "Lower score", url: "https://example.com/a-lower", score: 0.3 },
        ] }));
    }));

    const details = await aggregateSearch(config, { query: "q", maxResults: 20 });

    expect(details.results.slice(0, 2).map((item) => item.url)).toEqual([
      "https://example.com/z-higher",
      "https://example.com/a-lower",
    ]);
  });

  it("uses optional scores only when comparable and never treats a missing score as zero", async () => {
    const config = aggregateConfig({ providers: [
      { id: "scored", provider: "exa", apiKey: "key" },
      { id: "scoreless", provider: "brave", apiKey: "key" },
    ] });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) =>
      requestUrl(input).includes("exa.ai")
        ? new Response(JSON.stringify({ results: [
          { title: "Has score", url: "https://example.com/z-scored", score: 0.99 },
        ] }))
        : brave([{ title: "No score", url: "https://example.com/a-scoreless" }]),
    ));

    const details = await aggregateSearch(config, { query: "q", maxResults: 20 });

    expect(details.results.map((item) => item.url)).toEqual([
      "https://example.com/a-scoreless",
      "https://example.com/z-scored",
    ]);
  });

  it("uses canonical URL as the final deterministic tie-break", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) =>
      requestUrl(input).includes("serper")
        ? serper([{ title: "Z", link: "https://example.com/z" }])
        : brave([{ title: "A", url: "https://example.com/a" }]),
    ));

    const details = await aggregateSearch(aggregateConfig(), { query: "q", maxResults: 20 });

    expect(details.results.map((item) => item.url)).toEqual([
      "https://example.com/a",
      "https://example.com/z",
    ]);
  });

  it("selects the title and snippet from the strongest-position duplicate variant", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) =>
      requestUrl(input).includes("serper")
        ? serper([
          { title: "Filler", link: "https://example.com/filler" },
          { title: "Weak title", link: "https://example.com/shared?utm_medium=test", snippet: "Weak snippet" },
        ])
        : brave([
          { title: "Strong title", url: "https://example.com/shared?gclid=test", description: "Strong snippet" },
        ]),
    ));

    const details = await aggregateSearch(aggregateConfig(), { query: "q", maxResults: 20 });

    expect(details.results[0]).toMatchObject({ title: "Strong title", snippet: "Strong snippet" });
  });

  it("counts one strongest positional observation per provider when tracking variants repeat", async () => {
    const repeated = Array.from({ length: 9 }, (_, index) => ({
      title: index === 0 ? "Agreed A" : `A tracking variant ${index}`,
      link: `https://example.com/a?utm_source=serper-${index}`,
    }));
    repeated.push({ title: "Agreed B", link: "https://example.com/b" });
    const braveItems = [{ title: "Agreed B", url: "https://example.com/b" }];
    for (let index = 0; index < 8; index += 1) braveItems.push({ title: `Filler ${index}`, url: `https://example.com/filler-${index}` });
    braveItems.push({ title: "Agreed A", url: "https://example.com/a?gclid=brave" });

    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) =>
      requestUrl(input).includes("serper") ? serper(repeated) : brave(braveItems),
    ));

    const details = await aggregateSearch(aggregateConfig(), { query: "q", maxResults: 20 });

    // Both pages occur in both sources. Repeating A in Serper must not make its
    // later variants count as extra positional evidence (or weaken its strongest position).
    expect(details.results.slice(0, 2).map((item) => item.url)).toEqual([
      "https://example.com/b",
      "https://example.com/a",
    ]);
    expect(details.results[0]?.sources).toEqual(["serper/first", "brave/second"]);
  });

  it("keeps ranking stable when repeated canonical variants precede a later unique page", async () => {
    let repeatedVariants = false;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      if (requestUrl(input).includes("serper")) {
        const items = repeatedVariants
          ? [
            { title: "Y strongest", link: "https://example.com/y" },
            { title: "Y tracking 1", link: "https://example.com/y?utm_source=one" },
            { title: "Y tracking 2", link: "https://example.com/y?utm_source=two" },
            { title: "Y tracking 3", link: "https://example.com/y?utm_source=three" },
            { title: "X", link: "https://example.com/x" },
          ]
          : [
            { title: "Y", link: "https://example.com/y" },
            { title: "X", link: "https://example.com/x" },
          ];
        return serper(items);
      }
      return brave([
        { title: "X", url: "https://example.com/x" },
        { title: "Y", url: "https://example.com/y" },
      ]);
    }));

    const baseline = await aggregateSearch(aggregateConfig(), { query: "q", maxResults: 20 });
    repeatedVariants = true;
    const withRepeatedVariants = await aggregateSearch(aggregateConfig(), { query: "q", maxResults: 20 });

    // Both providers have the same unique order in both calls, so inserting
    // repeated Y variants must not reverse the canonical tie-break order. The
    // old full-list denominator ranked Y first in the second call.
    const urls = (details: SearchDetails) => details.results.map((item) => item.url);
    expect(urls(baseline)).toEqual(["https://example.com/x", "https://example.com/y"]);
    expect(urls(withRepeatedVariants)).toEqual(urls(baseline));
  });

  it("applies the final limit only after agreement ranking", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) =>
      requestUrl(input).includes("serper")
        ? serper([
          { title: "Serper only", link: "https://example.com/serper-only" },
          { title: "Shared", link: "https://example.com/shared?utm_campaign=test" },
        ])
        : brave([
          { title: "Brave only", url: "https://example.com/brave-only" },
          { title: "Shared", url: "https://example.com/shared?gclid=test" },
        ]),
    ));

    const details = await aggregateSearch(aggregateConfig(), { query: "q", maxResults: 1 });

    expect(details.results).toHaveLength(1);
    expect(details.results[0]?.title).toBe("Shared");
    expect(details.truncated).toBe(true);
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
  it("keeps native prose unchanged while independently merging and ranking external URLs", async () => {
    const barrier = new StartBarrier(3);
    const nativeAnswer = "Native evidence: https://example.com/native-shared?utm_source=model";
    const runtime = nativeRuntime({
      search: async ({ signal }) => {
        await barrier.arrive("native");
        signal.throwIfAborted();
        return { provider: "openai", model: "gpt-5", text: nativeAnswer };
      },
    });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const provider = requestUrl(input).includes("serper") ? "serper" : "brave";
      await barrier.arrive(provider);
      return provider === "serper"
        ? serper([
          { title: "Strong shared title", link: "https://example.com/native-shared?fbclid=x", snippet: "Shared evidence." },
          { title: "Serper only", link: "https://example.com/serper-only" },
        ])
        : brave([
          { title: "Weaker shared title", url: "https://example.com/native-shared?gclid=x" },
          { title: "External only", url: "https://example.com/external-only" },
        ]);
    }));

    const search = aggregateSearch(aggregateConfig(), { query: "q", maxResults: 20 }, undefined, runtime);
    await settle();
    const beforeRelease = [...barrier.started].sort();
    barrier.release();
    const details = await search;
    const output = formatSearchText(details);

    expect(beforeRelease).toEqual(["brave", "native", "serper"]);
    expect(details.answer).toBe(nativeAnswer);
    expect(details.results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: "Strong shared title",
        url: "https://example.com/native-shared",
        sources: ["serper/first", "brave/second"],
      }),
      expect.objectContaining({ title: "Serper only", sources: ["serper/first"] }),
      expect.objectContaining({ title: "External only", sources: ["brave/second"] }),
    ]));
    expect(details.results.filter((item) => item.url.includes("native-shared"))).toHaveLength(1);
    expect(output).toBe([
      nativeAnswer,
      "",
      "1. Strong shared title",
      "   https://example.com/native-shared",
      "   Excerpt: “Shared evidence.”",
      "   Sources: serper/first, brave/second",
      "2. External only",
      "   https://example.com/external-only",
      "   Sources: brave/second",
      "3. Serper only",
      "   https://example.com/serper-only",
      "   Sources: serper/first",
    ].join("\n"));
    expect(output).not.toMatch(/openai|gpt-5|native\s+search|external\s+results|q external/i);
    expect(details).toMatchObject({
      native: { status: "success", provider: "openai", model: "gpt-5" },
    });
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
    expect(statuses(details)).toContain("timeout");
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

    expect(abortedAtDeadline).toEqual(["brave", "native", "serper"]);
    expect(details.results).toEqual([]);
    expect(details.error).toBeTruthy();
    expect(details).toMatchObject({
      native: {
        status: "timeout",
        provider: "openai",
        model: "gpt-5",
        timeoutReason: "aggregate-deadline",
      },
      attempts: expect.arrayContaining([
        expect.objectContaining({ provider: "serper", status: "timeout", timeoutReason: "aggregate-deadline" }),
        expect.objectContaining({ provider: "brave", status: "timeout", timeoutReason: "aggregate-deadline" }),
      ]),
    });
    expect(output.match(/web search failed/gi)).toHaveLength(1);
    expect(output).not.toContain("native private late result");
    expect(output).not.toContain("serper private late result");
    expect(output).not.toContain("brave private late result");
  });

  it("propagates caller cancellation to native work and every external fetch and rejects partial output", async () => {
    const controller = new AbortController();
    const barrier = new StartBarrier(3);
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

    expect(started).toEqual(["brave", "native", "serper"]);
    expect([...aborted].sort()).toEqual(["brave", "native", "serper"]);
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
    expect(details.attempts).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: "serper", timeoutReason: "aggregate-deadline" }),
      expect.objectContaining({ provider: "brave", timeoutReason: "aggregate-deadline" }),
    ]));
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
    expect(details.attempts).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: "serper", timeoutReason: "aggregate-deadline" }),
      expect.objectContaining({ provider: "brave", timeoutReason: "aggregate-deadline" }),
    ]));
    expect(caller.signal.aborted).toBe(false);
  });
});
