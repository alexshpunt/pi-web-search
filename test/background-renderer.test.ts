import { initTheme, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { renderBackgroundSearchCard } from "../src/background-renderer.ts";
import { formatBackgroundSearchResult, type BackgroundSearchResult } from "../src/background-search.ts";

const result: BackgroundSearchResult = {
  requestId: "search-1", query: "中文 search 🚀 " + "long query ".repeat(15), status: "completed", durationMs: 4200,
  search: {
    provider: "duckduckgo-html", query: "query", durationMs: 4200, truncated: false,
    answer: "Native answer\n" + "Full answer. ".repeat(100) + "NATIVE_TAIL_MARKER",
    results: [{ title: "Evidence", url: "https://example.com/evidence", snippet: "Full snippet. ".repeat(100) + "SNIPPETTAILMARKER" }],
    attempts: [{ provider: "brave", status: "failure", resultsCount: 0, durationMs: 50, error: "HTTP 503" }],
    native: { status: "success", provider: "fixture", model: "fixture" },
  },
};
initTheme("dark", false);
const theme = new Theme(
  { success: 2, error: 1, accent: 6, muted: 7, dim: 8, text: 7, thinkingXhigh: 6 } as ConstructorParameters<typeof Theme>[0],
  { customMessageBg: 0, selectedBg: 0 } as ConstructorParameters<typeof Theme>[1], "truecolor",
);

describe("background search cards", () => {
  it("keeps collapsed cards compact at narrow widths without losing any agent-facing information", () => {
    for (const width of [24, 40, 100]) {
      const lines = renderBackgroundSearchCard(result, { expanded: false, outputPad: 1 }, theme).render(width);
      expect(lines.length).toBeLessThanOrEqual(8);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      expect(lines.join("\n")).not.toContain("TAIL_MARKER");
      expect(lines.join("\n")).not.toContain("HTTP 503");
    }
    const content = formatBackgroundSearchResult(result);
    expect(content).toContain("NATIVE_TAIL_MARKER");
    expect(content).toContain("SNIPPETTAILMARKER");
    expect(content).toContain("HTTP 503");
    expect(content).toContain(result.query);
  });

  it("expands to the full answer and pages without showing a raw diagnostics dump to the user", () => {
    const lines = renderBackgroundSearchCard(result, { expanded: true, outputPad: 1 }, theme).render(60);
    expect(lines.every((line) => visibleWidth(line) <= 60)).toBe(true);
    const rendered = lines.join("\n");
    expect(rendered).toContain("NATIVE_TAIL_MARKER");
    expect(rendered).toContain("SNIPPETTAILMARKER");
    expect(rendered).toContain("example.com");
    expect(rendered).not.toContain('"attempts"');
  });

  it("shows failures clearly and neutralizes terminal controls in displayed queries and errors", () => {
    const failed: BackgroundSearchResult = { requestId: "error", query: "query\u001b]0;bad\u0007\u202e", status: "failed", durationMs: 1, error: "HTTP 401\u0000\u202e" };
    const rendered = renderBackgroundSearchCard(failed, { expanded: false, outputPad: 1 }, theme).render(60).join("\n");
    expect(rendered).toContain("Failed");
    expect(rendered).toContain("HTTP 401");
    expect(rendered).not.toContain("\u0000");
    expect(rendered).not.toContain("\u202e");
    expect(formatBackgroundSearchResult(failed)).toContain("HTTP 401");
  });
});
