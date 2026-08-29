import { describe, expect, it } from "vitest";

import { defaultProviderUrl } from "#src/providers/endpoints.ts";
import { buildSearchRequest } from "#src/providers/request.ts";
import { normalizeSearchResponse } from "#src/providers/response.ts";
import type { SearchProvider, SearchProviderConfig } from "#src/types.ts";

const query = "provider contract";
const request = { query, maxResults: 7 };

const providerConfigs: readonly SearchProviderConfig[] = [
  { provider: "exa", apiKey: "key" },
  { provider: "tavily", apiKey: "key" },
  { provider: "brave", apiKey: "key" },
  { provider: "duckduckgo-html" },
  { provider: "serper", apiKey: "key" },
  { provider: "parallel", apiKey: "key" },
  { provider: "google-cse", apiKey: "key", searchEngineId: "engine" },
  { provider: "z-ai", apiKey: "key" },
  { provider: "z-ai", apiKey: "key", model: "glm" },
  { provider: "openai", apiKey: "key", model: "gpt" },
  { provider: "codex", apiKey: "key", codexMode: "cached" },
  { provider: "anthropic", apiKey: "key", model: "claude" },
  { provider: "perplexity", apiKey: "key" },
  { provider: "perplexity", apiKey: "key", model: "sonar" },
  { provider: "xai", apiKey: "key" },
  { provider: "kimi", apiKey: "key" },
];

describe("provider request contracts", () => {
  it.each(providerConfigs)("builds a valid $provider request", (config) => {
    const built = buildSearchRequest(config, request);
    expect(new URL(built.url).origin + new URL(built.url).pathname).toBe(defaultProviderUrl(config.provider));
    expect(built.init.method).toMatch(/^(GET|POST)$/);
    expect(built.init.headers.Accept).toBeDefined();

    if (built.init.method === "POST") {
      expect(built.body).toBeDefined();
      expect(JSON.stringify(built.body)).toContain(query);
    } else {
      expect(built.url).toContain("q=");
    }
  });

  it("applies provider-specific request fields and safe domain filters", () => {
    const exa = buildSearchRequest(
      { provider: "exa", apiKey: "key", allowedDomains: ["example.com"] },
      request,
    );
    expect(exa.body).toMatchObject({ query, numResults: 7, includeDomains: ["example.com"] });

    const brave = buildSearchRequest(
      { provider: "brave", apiKey: "key", blockedDomains: ["ads.example"] },
      request,
    );
    expect(brave.url).toContain("-site%3Aads.example");

    const google = buildSearchRequest(
      { provider: "google-cse", apiKey: "key", searchEngineId: "engine" },
      request,
    );
    expect(google.url).toContain("key=key");
    expect(google.url).toContain("cx=engine");

    const openai = buildSearchRequest(
      { provider: "openai", apiKey: "key", userLocation: { country: "US" } },
      request,
    );
    expect(openai.body).toMatchObject({ model: "gpt-5.5", tools: [{ type: "web_search" }] });
  });
});

const responseFixtures: Readonly<Record<SearchProvider, unknown>> = {
  exa: { results: [{ title: "Exa", url: "https://example.com/exa", text: "text", score: 0.9 }] },
  tavily: { results: [{ title: "Tavily", url: "https://example.com/tavily", content: "content", score: 0.8 }] },
  brave: { web: { results: [{ title: "Brave", url: "https://example.com/brave", description: "description" }] } },
  "duckduckgo-html": {
    html: '<a class="result__a" href="https://example.com/duck">Duck</a><a class="result__snippet">snippet</a>',
  },
  serper: { organic: [{ title: "Serper", link: "https://example.com/serper", snippet: "snippet" }] },
  parallel: { results: [{ title: "Parallel", url: "https://example.com/parallel", excerpts: ["excerpt"] }] },
  "google-cse": { items: [{ title: "Google", link: "https://example.com/google", snippet: "snippet" }] },
  "z-ai": { search_result: [{ title: "Z.AI", link: "https://example.com/zai", content: "content", media: "web" }] },
  openai: {
    output: [{ type: "message", content: [{ type: "output_text", text: "OpenAI", annotations: [{ type: "url_citation", title: "Citation", url: "https://example.com/openai" }] }] }],
  },
  codex: {
    output: [{ type: "web_search_call", action: { sources: [{ url: "https://example.com/codex" }] } }],
  },
  anthropic: {
    content: [{ type: "web_search_tool_result", content: [{ title: "Anthropic", url: "https://example.com/anthropic", page_age: "today" }] }],
  },
  perplexity: { search_results: [{ title: "Perplexity", url: "https://example.com/perplexity", snippet: "snippet", date: "today" }] },
  xai: { citations: ["https://example.com/xai"] },
  kimi: { search_results: [{ title: "Kimi", url: "https://example.com/kimi", summary: "summary" }] },
};

describe("provider normalized-response contracts", () => {
  it.each(Object.entries(responseFixtures))("normalizes the %s response family", (provider, payload) => {
    const results = normalizeSearchResponse(provider as SearchProvider, payload);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.url).toMatch(/^https:\/\/example\.com\//);
    expect(results[0]?.title).toBeTruthy();
  });

  it("does not turn malformed payloads into results", () => {
    for (const provider of Object.keys(responseFixtures) as SearchProvider[]) {
      expect(normalizeSearchResponse(provider, { unexpected: true })).toEqual([]);
      expect(normalizeSearchResponse(provider, "not an object")).toEqual([]);
    }
  });
});
