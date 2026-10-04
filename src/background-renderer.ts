import { getMarkdownTheme, type MessageRenderOptions, type Theme } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { formatSearchText, sanitizePresentationControls } from "./search-format.ts";
import type { BackgroundSearchResult } from "./background-search.ts";

/** Renders a compact completion card; expansion changes presentation, never agent content. */
export function renderBackgroundSearchCard(result: BackgroundSearchResult, options: MessageRenderOptions, theme: Theme): Component {
  const box = new Box(options.outputPad, 1, (line) => theme.bg("customMessageBg", line));
  box.addChild({
    render(width) {
      const safe = sanitizePresentationControls;
      const error = result.error ?? result.search?.error;
      const failed = result.status === "failed";
      const title = `${theme.fg(failed ? "error" : "success", failed ? "✗" : "✓")} ${theme.bold("Web search")} · ${failed ? "Failed" : "Completed"} · ${(result.durationMs / 1000).toFixed(1)}s`;
      const lines = [truncateToWidth(title, width)];
      const query = theme.fg("accent", `Query: ${safe(result.query)}`);
      lines.push(...(options.expanded ? new Text(query, 0, 0).render(width) : [truncateToWidth(query, width)]));
      if (error) {
        const text = theme.fg("error", safe(error));
        lines.push(...(options.expanded ? new Text(text, 0, 0).render(width) : [truncateToWidth(text, width)]));
      } else if (result.search) {
        const search = result.search;
        const parts = [`${search.results.length} ${search.results.length === 1 ? "page" : "pages"}`];
        if (search.answer) parts.push("native answer");
        if (search.attempts?.some((attempt) => attempt.status === "failure" || attempt.status === "timeout") || search.native?.status === "failure" || search.native?.status === "timeout") parts.push("partial sources");
        lines.push(truncateToWidth(theme.fg("muted", parts.join(" · ")), width));
        const domains = [...new Set(search.results.map((item) => new URL(item.url).hostname))];
        if (domains.length) lines.push(truncateToWidth(theme.fg("muted", `Sources: ${domains.join(", ")}`), width));
        if (options.expanded) {
          const body = formatSearchText(search).split("\n").map(safe).join("\n");
          lines.push("", ...new Markdown(body, 0, 0, getMarkdownTheme()).render(width));
        }
      }
      const reference = theme.fg("dim", `Request: ${safe(result.requestId)}${options.expanded ? "" : " · expand for details"}`);
      lines.push(...(options.expanded ? new Text(reference, 0, 0).render(width) : [truncateToWidth(reference, width)]));
      return lines;
    },
    invalidate() {},
  });
  return box;
}
