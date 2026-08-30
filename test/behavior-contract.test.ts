import { afterEach, describe, expect, it, vi } from "vitest";

import { formatSearchText } from "#src/search-format.ts";
import { performSearch } from "#src/search.ts";
import type { WebsearchConfig } from "#src/types.ts";

const config = (strategy: "priority" | "fill-first" = "priority") =>
  ({
    strategy,
    fallback: true,
    providers: [
      { id: "serper", provider: "serper" as const, apiKey: "key" },
      { id: "brave", provider: "brave" as const, apiKey: "key" },
    ],
  }) satisfies WebsearchConfig;

afterEach(() => vi.unstubAllGlobals());

describe("preserved WebSearch behavior", () => {
  it("keeps numbered text output and structured attempts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              organic: [{ title: "One", link: "https://example.com/one", snippet: "Snippet" }],
            }),
            { status: 200 },
          ),
      ),
    );
    const details = await performSearch(config(), { query: "query", maxResults: 10 });
    expect(formatSearchText(details)).toContain("1. One\n   https://example.com/one\n   Snippet");
    expect(formatSearchText({ ...details, results: [] })).toBe('No web search results found for "query".');
    expect(details).toMatchObject({
      provider: "serper",
      query: "query",
      results: [{ title: "One", url: "https://example.com/one", snippet: "Snippet" }],
      truncated: false,
      strategy: "priority",
    });
    expect(details.durationMs).toBeGreaterThanOrEqual(0);
    expect(details.attempts).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: "serper", resultsCount: 1 }),
      expect.objectContaining({ provider: "brave", resultsCount: 0 }),
    ]));
  });

  it("filters unsafe result URLs and fills first results by unique URL", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const body = url.includes("serper")
          ? {
              organic: [
                { title: "Unsafe", link: "javascript:bad" },
                { title: "One", link: "https://example.com/one" },
              ],
            }
          : {
              web: {
                results: [
                  { title: "Duplicate", url: "https://example.com/one" },
                  { title: "Two", url: "http://example.com/two" },
                ],
              },
            };
        return new Response(JSON.stringify(body), { status: 200 });
      }),
    );
    const details = await performSearch(config("fill-first"), { query: "query", maxResults: 2 });
    expect(details.results.map(({ url }) => url)).toEqual([
      "https://example.com/one",
      "http://example.com/two",
    ]);
    expect(details.truncated).toBe(true);
  });

  it("reports HTTP failures and rethrows cancellation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("bad gateway", { status: 502 })),
    );
    const failed = await performSearch(config(), { query: "query", maxResults: 10 });
    expect(failed.error).toContain("All configured search providers failed");
    expect(failed.attempts?.[0]?.error).toContain("HTTP 502");

    const controller = new AbortController();
    controller.abort();
    await expect(
      performSearch(config(), { query: "query", maxResults: 10 }, controller.signal),
    ).rejects.toThrow("This operation was aborted");
  });
});
