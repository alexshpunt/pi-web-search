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
const description = "Search the public web for information on any topic.";
/** Registers the standalone web_search tool and its user-invoked doctor command. */
export default async function registerWebSearch(pi: ExtensionAPI): Promise<void> {
  pi.registerTool({
    name: "web_search", label: "web_search", description,
    promptSnippet: description,
    promptGuidelines: [
      "Use web_search when the user mentions an external dependency, package, extension, product, service, or other external reference to find what they mean and get current information.",
      "Use web_search to verify external facts and find up-to-date information instead of relying on memory.",
      "When missing factual information can be found online, search with web_search before asking the user to clarify. Ask only if the search does not resolve the uncertainty or the question is about the user's intent or preferences.",
    ],
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
