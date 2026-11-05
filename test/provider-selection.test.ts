import { afterEach, expect, it, vi } from "vitest";
import { performSearch } from "#src/search.ts";
import type { WebsearchConfig } from "#src/types.ts";

const config: WebsearchConfig = {
  strategy: "priority", fallback: true,
  providers: [
    { provider: "serper", apiKey: "key" },
    { provider: "brave", apiKey: "key" },
    { provider: "tavily", apiKey: "key" },
  ],
  sourceTimeoutMs: 100, aggregateDeadlineMs: 1000,
};
afterEach(() => vi.unstubAllGlobals());

it("tries providers in order until one returns results, then stops", async () => {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const url = String(input); calls.push(url);
    if (url.includes("serper")) return new Response("failed", { status: 402 });
    if (url.includes("brave")) return Response.json({ web: { results: [{ title: "Found", url: "https://example.com/found" }] } });
    throw new Error("unexpected provider");
  }));
  const result = await performSearch(config, { query: "q", maxResults: 10 });
  expect(calls).toHaveLength(2);
  expect(calls[0]).toContain("serper");
  expect(calls[1]).toContain("brave");
  expect(result.results.map(item => item.url)).toEqual(["https://example.com/found"]);
  expect(result.attempts?.map(attempt => attempt.status)).toEqual(["failure", "success"]);
});

it("tries the next provider after an empty result", async () => {
  const fetcher = vi.fn(async (input: string | URL | Request) => String(input).includes("serper")
    ? Response.json({ organic: [] })
    : Response.json({ web: { results: [{ title: "Found", url: "https://example.com/found" }] } }));
  vi.stubGlobal("fetch", fetcher);
  const result = await performSearch(config, { query: "q", maxResults: 10 });
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(result.attempts?.map(attempt => attempt.status)).toEqual(["empty", "success"]);
});
