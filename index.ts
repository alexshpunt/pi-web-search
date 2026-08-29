import { Type, type Static } from "typebox";

import { loadWebsearchConfig } from "#src/config.ts";
import { formatWebSearchDoctorReport } from "#src/doctor.ts";
import { formatSearchText } from "#src/search-format.ts";
import { createSearchRoutingState, performSearch, type SearchRoutingState } from "#src/search.ts";

import type { SearchDetails } from "#src/types.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Keep the query behind a JSON Schema ref so Pi does not coerce numbers into strings.
const webSearchSchema = Type.Unsafe<{ query: string }>({
  type: "object",
  required: ["query"],
  properties: { query: { $ref: "#/$defs/WebSearchQuery" } },
  additionalProperties: false,
  $defs: { WebSearchQuery: { type: "string", minLength: 1, description: "Plain web search query" } },
});
type WebSearchParameters = Static<typeof webSearchSchema>;

const description =
  "Search the public web when workspace search cannot answer a question, such as current documentation, library versions, errors, or news. Pass plain unprefixed text in `query`; do not add a selector. Result count is controlled by the websearch.json configuration. Use returned titles, URLs, and snippets as citation sources. Reading a known URL is a separate task handled by an HTTP URL reader when one is installed.";

/** Registers the standalone web_search tool and its user-invoked doctor command. */
export default async function registerWebSearch(pi: ExtensionAPI): Promise<void> {
  let routingState: SearchRoutingState | undefined;
  let routingKey = "";

  pi.registerTool({
    name: "web_search",
    label: "web_search",
    description,
    promptSnippet: "Search the public web with a plain query and return citable results",
    parameters: webSearchSchema,
    async execute(_toolCallId, parameters: WebSearchParameters, signal, _onUpdate, context) {
      const loaded = await loadWebsearchConfig({ cwd: context.cwd });
      if (parameters.query.trim().length === 0) {
        throw new Error("Web search query must not be empty");
      }

      if (!loaded.ok) {
        throw new Error(loaded.message);
      }

      const config = loaded.config;
      const nextKey = `${config.strategy}:${config.providers
        .map((provider) => provider.id ?? provider.provider)
        .join("|")}`;
      if (
        routingState === undefined ||
        routingKey !== nextKey ||
        routingState.successCounts.length !== config.providers.length
      ) {
        routingState = createSearchRoutingState(config.providers.length);
        routingKey = nextKey;
      }

      const maxResults = Math.min(config.providers[0]?.maxResults ?? 10, 1000);
      const details = await performSearch(
        config,
        { query: parameters.query, maxResults },
        signal,
        routingState,
      );
      return {
        content: [{ type: "text", text: formatSearchText(details) }],
        details,
      } satisfies { content: [{ type: "text"; text: string }]; details: SearchDetails };
    },
  });

  pi.registerCommand("pi-web-search-doctor", {
    description: "Check WebSearch configuration and provider credentials",
    handler: async (_arguments, context) => {
      const report = await formatWebSearchDoctorReport(context.cwd, process.env);
      pi.sendMessage(
        { customType: "pi-web-search-doctor", content: report, display: true },
        { triggerTurn: false },
      );
    },
  });
}
