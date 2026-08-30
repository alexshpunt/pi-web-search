import { Type, type Static } from "typebox";
import { loadWebsearchConfig } from "#src/config.ts";
import { formatWebSearchDoctorReport } from "#src/doctor.ts";
import { formatSearchText } from "#src/search-format.ts";
import { performSearch } from "#src/search.ts";
import type { SearchDetails } from "#src/types.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const webSearchSchema = Type.Unsafe<{ query: string; limit?: number }>({
  type: "object", required: ["query"], additionalProperties: false,
  properties: {
    query: { $ref: "#/$defs/WebSearchQuery" },
    limit: { type: "integer", minimum: 1, maximum: 20, description: "Maximum external results" },
  },
  $defs: { WebSearchQuery: { type: "string", minLength: 1, description: "Plain web search query" } },
});
type WebSearchParameters = Static<typeof webSearchSchema>;
const description = "Search the public web when workspace search cannot answer a question, such as current documentation, library versions, errors, or news. Pass plain unprefixed text in `query`; optional `limit` controls only the ranked external-provider list from 1 to 20. When supported, native model search returns a direct self-contained answer first, followed by an independently ranked numbered list from eligible external sources, according to configuration. Either part may be absent; if neither is usable, the tool reports an aggregate failure. Use returned titles, URLs, snippets, and native citations as evidence. Reading a known URL is a separate task handled by an HTTP URL reader when one is installed.";
/** Registers the standalone web_search tool and its user-invoked doctor command. */
export default async function registerWebSearch(pi: ExtensionAPI): Promise<void> {
  pi.registerTool({
    name: "web_search", label: "web_search", description,
    promptSnippet: "Search the public web with a plain query and return citable results",
    parameters: webSearchSchema,
    async execute(_toolCallId, parameters: WebSearchParameters, signal, _onUpdate, context) {
      if (parameters.query.trim().length === 0) throw new Error("Web search query must not be empty");
      if (parameters.limit !== undefined && (!Number.isInteger(parameters.limit) || parameters.limit < 1 || parameters.limit > 20)) throw new Error("Web search limit must be an integer from 1 to 20");
      const loaded = await loadWebsearchConfig({ cwd: context.cwd });
      if (!loaded.ok) throw new Error(loaded.message);
      const config = loaded.config;
      const maxResults = parameters.limit ?? config.maxResults ?? 10;
      const details = await performSearch(config, { query: parameters.query, maxResults }, signal, {
        activeModel: context.model,
        modelRegistry: context.modelRegistry,
      });
      return { content: [{ type: "text", text: formatSearchText(details) }], details } satisfies { content: [{ type: "text"; text: string }]; details: SearchDetails };
    },
  });
  pi.registerCommand("pi-web-search-doctor", {
    description: "Check WebSearch configuration and provider credentials",
    handler: async (_arguments, context) => { const report = await formatWebSearchDoctorReport(context.cwd, process.env); pi.sendMessage({ customType: "pi-web-search-doctor", content: report, display: true }, { triggerTurn: false }); },
  });
}
