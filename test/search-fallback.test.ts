import { afterEach, describe, expect, it, vi } from "vitest";

import { performSearch } from "#src/search.ts";
import type { JsonObject, WebsearchConfig } from "#src/types.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("web search fallback", () => {
  it.each([
    ["empty results", { organic: [] }],
    [
      "a non-web result URL",
      { organic: [{ title: "Broken result", link: "javascript:alert(1)" }] },
    ],
  ])("tries the next provider after %s", async (_caseName, firstPayload) => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const payload: JsonObject = url.startsWith("https://google.serper.dev/")
        ? firstPayload
        : { web: { results: [{ title: "Useful result", url: "https://example.com/result" }] } };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const config: WebsearchConfig = {
      strategy: "priority",
      fallback: true,
      providers: [
        { provider: "serper", apiKey: "serper-key" },
        { provider: "brave", apiKey: "brave-key" },
      ],
    };

    const details = await performSearch(config, { query: "fallback", maxResults: 5 });

    expect(details.provider).toBe("brave");
    expect(details.results).toEqual([
      { title: "Useful result", url: "https://example.com/result" },
    ]);
    expect(
      details.attempts?.map(({ provider, resultsCount }) => ({ provider, resultsCount })),
    ).toEqual([
      { provider: "serper", resultsCount: 0 },
      { provider: "brave", resultsCount: 1 },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
