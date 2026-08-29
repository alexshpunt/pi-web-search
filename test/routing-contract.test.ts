import { afterEach, describe, expect, it, vi } from "vitest";

import { performSearch, createSearchRoutingState } from "#src/search.ts";
import type { WebsearchConfig } from "#src/types.ts";

const config = (strategy: WebsearchConfig["strategy"]): WebsearchConfig => ({
  strategy,
  fallback: true,
  providers: [
    { id: "first", provider: "serper", apiKey: "key" },
    { id: "second", provider: "brave", apiKey: "key" },
  ],
});

function responseFor(url: string): Response {
  if (url.includes("serper")) {
    return new Response(JSON.stringify({ organic: [{ title: "Serper", link: "https://example.com/serper" }] }));
  }
  return new Response(JSON.stringify({ web: { results: [{ title: "Brave", url: "https://example.com/brave" }] } }));
}

afterEach(() => vi.unstubAllGlobals());

describe("routing strategy contracts", () => {
  it("uses configured priority order", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return responseFor(url);
    });
    vi.stubGlobal("fetch", fetchMock);
    const details = await performSearch(config("priority"), { query: "q", maxResults: 2 });
    expect(details.provider).toBe("serper");
    expect(fetchMock.mock.calls[0]?.[0]).toContain("serper");
  });

  it("rotates round-robin state and keeps state isolated", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return responseFor(url);
    });
    vi.stubGlobal("fetch", fetchMock);
    const firstState = createSearchRoutingState(2);
    const secondState = createSearchRoutingState(2);
    await performSearch(config("round-robin"), { query: "q", maxResults: 1 }, undefined, firstState);
    await performSearch(config("round-robin"), { query: "q", maxResults: 1 }, undefined, firstState);
    await performSearch(config("round-robin"), { query: "q", maxResults: 1 }, undefined, secondState);
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      expect.stringContaining("serper"),
      expect.stringContaining("brave"),
      expect.stringContaining("serper"),
    ]);
  });

  it("fill-first combines unique URLs and truncates at the configured limit", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("serper")) {
        return new Response(JSON.stringify({ organic: [
          { title: "One", link: "https://example.com/one" },
          { title: "Duplicate", link: "https://example.com/two" },
        ] }));
      }
      return new Response(JSON.stringify({ web: { results: [
        { title: "Duplicate", url: "https://example.com/two" },
        { title: "Three", url: "https://example.com/three" },
      ] } }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const details = await performSearch(config("fill-first"), { query: "q", maxResults: 2 });
    expect(details.results.map((item) => item.url)).toEqual([
      "https://example.com/one",
      "https://example.com/two",
    ]);
    expect(details.truncated).toBe(true);
    expect(details.attempts).toHaveLength(1);
  });
});

describe("failure and cancellation contracts", () => {
  it("reports malformed and network failures, including all providers", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("serper")) return new Response("not-json", { status: 200 });
      throw new Error("network down");
    }));
    const details = await performSearch(config("priority"), { query: "q", maxResults: 1 });
    expect(details.error).toContain("All configured search providers failed");
    expect(details.attempts?.[0]?.error).toBeUndefined();
    expect(details.attempts?.[1]?.error).toContain("network down");
  });

  it("passes abort to fetch and rethrows cancellation", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      receivedSignal = init?.signal ?? undefined;
      controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 0));
      throw new Error("aborted request");
    }));
    await expect(performSearch(config("priority"), { query: "q", maxResults: 1 }, controller.signal)).rejects.toThrow();
    expect(receivedSignal).toBe(controller.signal);
  });
});
