import type { SearchDetails } from "./types.ts";
export function formatSearchText(details: SearchDetails): string {
  if (details.error) return details.error;
  const lines: string[] = [];
  if (details.native?.status === "success" && details.answer) {
    lines.push(`${details.native.provider ?? "native"}/${details.native.model ?? "model"}`, "", details.answer);
  }
  if (details.results.length === 0) {
    lines.push(`No web search results found for "${details.query}".`);
    return lines.join("\n");
  }
  lines.push(`${details.query} external`, "");
  for (const [index, item] of details.results.entries()) {
    lines.push(`${index + 1}. ${item.title}`, `   ${item.url}`);
    if (item.snippet) lines.push(`   ${item.snippet}`);
    if (item.sources?.length) lines.push(`   Sources: ${item.sources.join(", ")}`);
  }
  return lines.join("\n");
}
