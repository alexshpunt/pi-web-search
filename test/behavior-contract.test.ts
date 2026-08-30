import { afterEach, describe, expect, it, vi } from "vitest";

import { formatSearchText } from "#src/search-format.ts";
import { performSearch } from "#src/search.ts";
import type { SearchDetails, WebsearchConfig } from "#src/types.ts";

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


const baseDetails = (overrides: Partial<SearchDetails> = {}): SearchDetails => ({
  provider: "serper",
  query: "query",
  results: [],
  durationMs: 1,
  truncated: false,
  native: { status: "ineligible" },
  ...overrides,
});

const externalResult = {
  title: "External result",
  url: "https://example.com/external",
  snippet: "External snippet.",
  sources: ["serper/first", "brave/second"],
};

describe("native and external public output availability", () => {
  it("returns unchanged native prose without headings or model metadata when only native output is usable", () => {
    const answer = "  Native answer with intentional spacing.\nSecond line.  ";
    expect(formatSearchText(baseDetails({
      answer,
      native: { status: "success", provider: "openai", model: "gpt-5.6-luna" },
    }))).toBe(answer);
  });

  it("returns only the numbered external list when native output is unavailable", () => {
    expect(formatSearchText(baseDetails({ results: [externalResult] }))).toBe([
      "1. External result",
      "   https://example.com/external",
      "   Excerpt: “External snippet.”",
      "   Sources: serper/first, brave/second",
    ].join("\n"));
  });

  it("puts unchanged native prose first and the external list second with one blank-line boundary", () => {
    const answer = "Native answer exactly as returned.";
    expect(formatSearchText(baseDetails({
      answer,
      native: { status: "success", provider: "openrouter", model: "openai/gpt-5.6" },
      results: [externalResult],
    }))).toBe([
      answer,
      "",
      "1. External result",
      "   https://example.com/external",
      "   Excerpt: “External snippet.”",
      "   Sources: serper/first, brave/second",
    ].join("\n"));
  });

  it("omits whitespace-only native text when external output is usable", () => {
    expect(formatSearchText(baseDetails({
      answer: " \n\t ",
      native: { status: "empty", provider: "openai", model: "gpt-5.6-luna" },
      results: [externalResult],
    }))).toBe([
      "1. External result",
      "   https://example.com/external",
      "   Excerpt: “External snippet.”",
      "   Sources: serper/first, brave/second",
    ].join("\n"));
  });
});
describe("external snippet public formatting", () => {
  it("sanitizes markup, links, headings, and embedded lists into one literal excerpt", () => {
    const snippet = "# Heading\n\nSee [NASA](https://nasa.gov) and **bold** text.\n<ul><li>One</li><li>Two</li></ul>";
    const output = formatSearchText(baseDetails({
      results: [{ ...externalResult, snippet }],
    }));

    expect(output).toBe([
      "1. External result",
      "   https://example.com/external",
      "   Excerpt: “Heading See NASA and bold text. One Two”",
      "   Sources: serper/first, brave/second",
    ].join("\n"));
    expect(output).not.toContain("<");
    expect(output).not.toContain("**");
    expect(output).not.toContain("[NASA]");
  });

  it("preserves complete source content after sanitation without adding truncation", () => {
    const snippet = "Complete source text ... with [a link](https://example.com) and <em>all</em> details.";
    const output = formatSearchText(baseDetails({ results: [{ ...externalResult, snippet }] }));

    expect(output).toContain("Excerpt: “Complete source text ... with a link and all details.”");
    expect(output.match(/\.\.\./g)).toHaveLength(1);
    expect(output).not.toContain("[…]");
    expect(output).not.toContain("…");
  });

  it("decodes common and numeric entities and removes complete script/style blocks", () => {
    const snippet = "Readable&nbsp;text &hellip; it&rsquo;s &#169; &#x1F642;. <script>alert('hidden')</script><style>.hidden { display: none }</style> &lt;script&gt;encoded hidden&lt;/script&gt; remains.";
    const output = formatSearchText(baseDetails({ results: [{ ...externalResult, snippet }] }));

    expect(output).toContain("Excerpt: “Readable text … it’s © 🙂. remains.”");
    expect(output).not.toContain("alert");
    expect(output).not.toContain("display: none");
    expect(output).not.toContain("encoded hidden");
    expect(output).not.toContain("&nbsp;");
    expect(output).not.toContain("&hellip;");
    expect(output).not.toContain("&#169;");
    expect(output).not.toContain("&#x1F642;");
  });

  it("drops numeric terminal and other unsafe controls while normalizing referenced whitespace", () => {
    const snippet = "Before&#27;[31mred&#x1b;[0m&#0;&#127;&#x80;&#x85;&#9;&#10;after";
    const output = formatSearchText(baseDetails({ results: [{ ...externalResult, snippet }] }));

    expect(output).toContain("Excerpt: “Before31mred0m after”");
    expect(output).not.toMatch(/[\u0000-\u0008\u000e-\u001f\u007f-\u0084\u0086-\u009f]/u);
  });

  it("drops bidi direction and isolate controls without changing ordinary Unicode", () => {
    const snippet = "Left &#x202e;spoof&#x202c; middle &#x2066;isolated&#x2069; right &#x03a9;🙂";
    const output = formatSearchText(baseDetails({ results: [{ ...externalResult, snippet }] }));

    expect(output).toContain("Excerpt: “Left spoof middle isolated right Ω🙂”");
    expect(output).not.toMatch(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u);
  });

  it("preserves invalid, out-of-range, surrogate, and noncharacter references literally", () => {
    const snippet = "invalid &#x; out-of-range &#1114112; surrogate &#55296; noncharacter &#64976; &#xFFFF; malformed &#xnope;";
    const output = formatSearchText(baseDetails({ results: [{ ...externalResult, snippet }] }));

    expect(output).toContain("Excerpt: “invalid &#x; out-of-range &#1114112; surrogate &#55296; noncharacter &#64976; &#xFFFF; malformed &#xnope;”");
  });

  it("decodes valid numeric references without losing Unicode", () => {
    const snippet = "Copyright &#169; smile &#x1F642; omega &#x03A9;";
    const output = formatSearchText(baseDetails({ results: [{ ...externalResult, snippet }] }));

    expect(output).toContain("Excerpt: “Copyright © smile 🙂 omega Ω”");
  });
});

describe("preserved WebSearch behavior", () => {
  it("sanitizes provider controls in titles, URLs, and provenance while preserving Unicode", () => {
    const output = formatSearchText(baseDetails({
      results: [{
        ...externalResult,
        title: "Résumé \u001b[31mred\u0000 \u0080 \u202e spo\u2066of\u2069 Ω🙂",
        url: "https://example.com/page\u001b\u0085",
        sources: ["serper/\u0080\u202eprimary"],
      }],
    }));

    expect(output).toContain("1. Résumé [31mred   spoof Ω🙂");
    expect(output).toContain("https://example.com/page");
    expect(output).toContain("Sources: serper/primary");
    expect(output).not.toMatch(/[\u0000-\u0008\u000e-\u001f\u007f-\u0084\u0086-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u);
  });

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
    expect(formatSearchText(details)).toContain("1. One\n   https://example.com/one\n   Excerpt: “Snippet”");
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
