import { writeFileSync } from "node:fs";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const demoHtml = `
<html>
    <body>
        <a class="result__a" href="https://example.com/pi-search-resolvers">Pi Search resolver architecture</a>
        <a class="result__snippet">One Search tool routes text, semantic, web, language, and structural queries.</a>
    </body>
</html>
`;

export default function registerWebSearchDemoTransport(pi: ExtensionAPI): void
{
    const originalFetch = fetch;
    const demoFetch: typeof fetch = (input, init) =>
    {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

        if (url.startsWith("https://google.serper.dev/"))
        {
            return Promise.resolve(
                new Response("{}", {
                    status: 200,
                    headers: { "content-type": "application/json" },
                }),
            );
        }

        if (url.startsWith("https://html.duckduckgo.com/html/"))
        {
            return Promise.resolve(
                new Response(demoHtml, {
                    status: 200,
                    headers: { "content-type": "text/html; charset=utf-8" },
                }),
            );
        }

        return originalFetch(input, init);
    };

    globalThis.fetch = demoFetch;
    pi.on("session_start", () =>
    {
        const reportPath = process.env.PI_WEB_SEARCH_SURFACE_REPORT;
        if (reportPath === undefined)
        {
            return;
        }

        writeFileSync(
            reportPath,
            JSON.stringify({
                tools: pi.getAllTools().map((tool) => ({
                    name: tool.name,
                    description: tool.description,
                    promptGuidelines: tool.promptGuidelines,
                    sourceInfo: tool.sourceInfo,
                })),
                commands: pi.getCommands().map((command) => ({ name: command.name, sourceInfo: command.sourceInfo })),
            }),
            "utf8",
        );
    });
    pi.on("session_shutdown", () =>
    {
        if (fetch === demoFetch)
        {
            globalThis.fetch = originalFetch;
        }
    });
}
