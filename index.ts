import { Type, type Static } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { loadWebsearchConfig } from "#src/config.ts";
import { formatWebSearchDoctorReport } from "#src/doctor.ts";
import { formatSearchText } from "#src/search-format.ts";
import { performSearch } from "#src/search.ts";
import { BACKGROUND_SEARCH_CARD, BACKGROUND_SEARCH_MESSAGE, BackgroundSearchRuntime, formatBackgroundSearchResult, type BackgroundSearchResult } from "#src/background-search.ts";
import { renderBackgroundSearchCard } from "#src/background-renderer.ts";
import type { JsonObject } from "#src/types.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const webSearchSchema = Type.Unsafe<{ query: string; limit?: number; background?: boolean }>({
  type: "object", required: ["query"], additionalProperties: false,
  properties: {
    query: { $ref: "#/$defs/WebSearchQuery" },
    limit: { type: "integer", minimum: 1, maximum: 20, description: "Maximum external results" },
    background: { type: "boolean", description: "Return a request ID immediately and deliver the full result automatically when ready. Defaults to false." },
  },
  $defs: { WebSearchQuery: { type: "string", minLength: 1, description: "Plain web search query" } },
});
type WebSearchParameters = Static<typeof webSearchSchema>;
const backgroundResultSchema = Type.Unsafe<BackgroundSearchResult>(Type.Object({
  requestId: Type.String(), parentToolCallId: Type.Optional(Type.String()), query: Type.String(), status: Type.Union([Type.Literal("completed"), Type.Literal("failed")]),
  durationMs: Type.Number(), search: Type.Optional(Type.Unknown()), error: Type.Optional(Type.String()),
}));
const description = "Search the public web for information on any topic.";

/** Registers blocking/background search, explicit waiting, result cards, and the doctor command. */
export default async function registerWebSearch(pi: ExtensionAPI): Promise<void> {
  const background = new BackgroundSearchRuntime(pi);
  pi.on("tool_execution_start", (event) => background.executionStarted(event.toolCallId, event.parentToolCallId));
  pi.on("tool_execution_end", (event) => background.executionEnded(event.toolCallId));
  pi.on("session_start", (_event, ctx) => background.reset(ctx));
  pi.on("session_tree", (_event, ctx) => background.reset(ctx));
  pi.on("session_shutdown", () => background.reset());
  pi.on("turn_start", (_event, ctx) => background.resume(ctx));
  pi.on("turn_end", (event, ctx) => { background.setContext(ctx); return background.deliverBoundary(event); });
  pi.on("agent_before_settle", (event, ctx) => { background.setContext(ctx); return background.deliverBoundary(event); });
  pi.on("agent_settled", (_event, ctx) => { background.resume(ctx); background.deliverIdle(); });
  pi.registerMessageRenderer<BackgroundSearchResult>(BACKGROUND_SEARCH_MESSAGE, (message, options, theme) => message.details ? renderBackgroundSearchCard(message.details, options, theme) : undefined);
  pi.registerEntryRenderer<BackgroundSearchResult>(BACKGROUND_SEARCH_CARD, (entry, options, theme) => entry.data ? renderBackgroundSearchCard(entry.data, { ...options, outputPad: 0 }, theme) : undefined);
  pi.registerTool({
    name: "web_search", label: "Web search", description, executionMode: "parallel",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    promptSnippet: description,
    promptGuidelines: [
      "Use web_search when the user mentions an external dependency, package, extension, product, service, or other external reference to find what they mean and get current information.",
      "Use web_search to verify external facts and find up-to-date information instead of relying on memory.",
      "When missing factual information can be found online, search with web_search before asking the user to clarify. Ask only if the search does not resolve the uncertainty or the question is about the user's intent or preferences.",
      "Use web_search with background: true to launch independent searches while doing other work. The launch receipt is not a search result. Each full result or failure arrives as a correlated message at a safe turn boundary and wakes an idle agent.",
      "Wait for search evidence before making decisions that depend on it. When no independent work remains, call wait_for_web_searches after the launch receipts; already delivered results are not repeated.",
    ],
    parameters: webSearchSchema,
    async execute(toolCallId, parameters: WebSearchParameters, signal, _onUpdate, context) {
      if (parameters.query.trim().length === 0) throw new Error("Web search query must not be empty");
      if (parameters.limit !== undefined && (!Number.isInteger(parameters.limit) || parameters.limit < 1 || parameters.limit > 20)) throw new Error("Web search limit must be an integer from 1 to 20");
      const loaded = await loadWebsearchConfig({ cwd: context.cwd });
      if (!loaded.ok) throw new Error(loaded.message);
      signal?.throwIfAborted();
      const config = loaded.config;
      const maxResults = parameters.limit ?? config.maxResults ?? 10;
      const runtime = { activeModel: context.model, modelRegistry: context.modelRegistry };
      const search = (ownedSignal?: AbortSignal) => performSearch(config, { query: parameters.query, maxResults }, ownedSignal, runtime);
      if (parameters.background) {
        const receipt = background.start(toolCallId, parameters.query, search, context);
        return { content: [{ type: "text", text: `${JSON.stringify(receipt)}\nThe full result will arrive automatically. Continue only independent work, or call wait_for_web_searches.` }], details: receipt };
      }
      const details = await search(signal);
      return { content: [{ type: "text", text: formatSearchText(details) }], details };
    },
  });
  pi.registerTool({
    name: "wait_for_web_searches", label: "Wait for web searches", executionMode: "sequential",
    description: "Wait for all outstanding background web searches already launched when this call starts. Returns full results not already delivered automatically. No polling is needed. Searches launched afterward are not included; interrupted waits fail rather than returning partial success.",
    promptSnippet: "Wait for outstanding background web search results.",
    parameters: Type.Object({}, { additionalProperties: false }),
    outputSchema: Type.Object({ results: Type.Array(backgroundResultSchema) }),
    async execute(_id, _args, signal) {
      const results = await background.wait(signal);
      return {
        content: [{ type: "text", text: results.length ? results.map(formatBackgroundSearchResult).join("\n\n") : "No outstanding web search results. Already delivered results are not repeated." }],
        details: { results }, structuredContent: { results } as unknown as JsonObject,
      };
    },
    renderResult(result, _options, theme) {
      const count = result.details?.results.length;
      if (count === undefined) return new Text(result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n"), 0, 0);
      return new Text(theme.fg("muted", count ? `Consumed ${count} web search ${count === 1 ? "result" : "results"}. Cards remain at the original calls.` : "No outstanding web search results."), 0, 0);
    },
  });
  pi.registerCommand("pi-web-search-doctor", {
    description: "Check WebSearch configuration and provider credentials",
    handler: async (_arguments, context) => { const report = await formatWebSearchDoctorReport(context.cwd, process.env); pi.sendMessage({ customType: "pi-web-search-doctor", content: report, display: true }, { triggerTurn: false }); },
  });
}
