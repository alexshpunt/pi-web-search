import { writeFileSync } from "node:fs";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const demoHtml = `
<html>
    <body>
        <a class="result__a" href="https://example.com/pi-search-resolvers?fbclid=fixture">Weaker duplicate title</a>
        <a class="result__snippet">Weaker duplicate snippet.</a>
        <a class="result__a" href="https://example.com/external-only">External-only result</a>
        <a class="result__snippet">A second deterministic external result.</a>
    </body>
</html>
`;

const nativeSourceSymbol = Symbol.for("pi-web-search.native-source");
const runtimeTransportSymbol = Symbol.for("pi-web-search.runtime-transport");

type TransportReport = {
    staticResolverCalls: number;
    started: string[];
    aborted: string[];
    activeModels: Array<{ provider: string; api: string; id: string }>;
    metadataCalls: number;
    externalCalls: number;
    nativeCompletionCalls: number;
    completionUsedTransport: boolean;
    nativePrompts: string[];
};


type FixtureModel = { provider: string; api: string; id: string };
type FixtureContext = {
    messages: Array<{
        role: string;
        content?: string | Array<{ type?: string; text?: string }>;
    }>;
};
type FixtureOptions = { fetch?: typeof fetch };

function fixtureMessage(model: FixtureModel, content: unknown[], stopReason: "stop" | "toolUse")
{
    return {
        role: "assistant" as const,
        content,
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason,
        timestamp: Date.now(),
    };
}

function messageText(message: FixtureContext["messages"][number] | undefined): string
{
    if (typeof message?.content === "string") return message.content;
    if (!Array.isArray(message?.content)) return "";
    return message.content
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("\n");
}

function fixtureStream(message: ReturnType<typeof fixtureMessage>)
{
    const start = { ...message, content: [], stopReason: "pending" as const };
    const events = [
        { type: "start" as const, partial: start },
        { type: "done" as const, reason: message.stopReason, message },
    ];
    return {
        async *[Symbol.asyncIterator]()
        {
            for (const event of events) yield event;
        },
        result: async () => message,
    };
}

export default function registerWebSearchDemoTransport(pi: ExtensionAPI): void
{
    const originalFetch = fetch;
    const cancellationMode = process.env.PI_WEB_SEARCH_FIXTURE_MODE === "cancel";
    const nativeMode = process.env.PI_WEB_SEARCH_FIXTURE_MODE === "native";
    const reportPath = process.env.PI_WEB_SEARCH_TRANSPORT_REPORT;
    const report: TransportReport = {
        staticResolverCalls: 0,
        started: [],
        aborted: [],
        activeModels: [],
        metadataCalls: 0,
        externalCalls: 0,
        nativeCompletionCalls: 0,
        completionUsedTransport: false,
        nativePrompts: [],
    };
    let abortCurrent: (() => void) | undefined;
    let fallbackAbort: ReturnType<typeof setTimeout> | undefined;

    const persist = (): void =>
    {
        if (reportPath !== undefined)
        {
            writeFileSync(reportPath, JSON.stringify(report), "utf8");
        }
    };
    const record = (field: "started" | "aborted", label: string): void =>
    {
        if (!report[field].includes(label)) report[field].push(label);
        report[field].sort();
        persist();
    };
    const abortWhenAllStarted = (): void =>
    {
        if (cancellationMode && report.started.length === 2)
        {
            if (fallbackAbort !== undefined) clearTimeout(fallbackAbort);
            queueMicrotask(() => abortCurrent?.());
        }
    };

    // Legacy injection trap: the installed package must ignore this and use its
    // package-owned capability acquisition path instead.
    const nativeSource = {
        isEligible: (): boolean =>
        {
            report.staticResolverCalls += 1;
            persist();
            return true;
        },
        search: (): never =>
        {
            report.staticResolverCalls += 1;
            persist();
            throw new Error("legacy native source must not run");
        },
    };

    const demoFetch: typeof fetch = (input, init) =>
    {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const provider = url.startsWith("https://google.serper.dev/")
            ? "serper"
            : url.startsWith("https://api.search.brave.com/")
                ? "brave"
                : undefined;

        if (url.includes("/models/openai/gpt-5.6/endpoints"))
        {
            report.metadataCalls += 1;
            record("started", "metadata");
            return Promise.resolve(new Response(JSON.stringify({
                data: {
                    id: "openai/gpt-5.6",
                    endpoints: [{ model_id: "openai/gpt-5.6", supported_parameters: ["tools", "tool_choice"] }],
                },
            }), { status: 200, headers: { "content-type": "application/json" } }));
        }

        if (provider !== undefined || url.startsWith("https://html.duckduckgo.com/html/"))
        {
            report.externalCalls += 1;
            persist();
        }

        if (cancellationMode && provider !== undefined)
        {
            return new Promise<never>((_resolve, reject) =>
            {
                init?.signal?.addEventListener("abort", () =>
                {
                    record("aborted", provider);
                    reject(init.signal?.reason ?? new Error(`${provider} cancelled`));
                }, { once: true });
                record("started", provider);
                abortWhenAllStarted();
            });
        }

        if (provider === "serper")
        {
            return Promise.resolve(
                new Response(JSON.stringify({
                    organic: [{
                        title: "Pi Search resolver architecture",
                        link: "https://example.com/pi-search-resolvers?utm_source=fixture#overview",
                        snippet: "One Search tool routes text, semantic, web, language, and structural queries.",
                    }],
                }), {
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


    if (nativeMode)
    {
        let providerCall = 0;
        pi.registerProvider("openrouter", {
            name: "Deterministic installed-package OpenRouter fixture",
            baseUrl: "https://openrouter.ai/api/v1",
            apiKey: "fixture-key",
            api: "openai-completions",
            models: [{
                id: "openai/gpt-5.6",
                name: "OpenRouter GPT-5.6 fixture",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128000,
                maxTokens: 4096,
            }],
            streamSimple: (model: FixtureModel, context: FixtureContext, options?: FixtureOptions) =>
            {
                report.activeModels.push({ provider: model.provider, api: model.api, id: model.id });
                const isFinalAgentTurn = context.messages.some((message) => message.role === "toolResult");
                const call = providerCall;
                providerCall += 1;
                if (call === 0)
                {
                    persist();
                    return fixtureStream(fixtureMessage(model, [{
                        type: "toolCall",
                        id: "native-first",
                        name: "web_search",
                        arguments: { query: "Pi Search resolver architecture" },
                    }], "toolUse"));
                }
                if (!isFinalAgentTurn)
                {
                    report.nativeCompletionCalls += 1;
                    const nativeUserMessage = [...context.messages].reverse().find((message) => message.role === "user");
                    report.nativePrompts.push(messageText(nativeUserMessage));
                    report.completionUsedTransport = options?.fetch === demoFetch;
                    record("started", "native");
                    return fixtureStream(fixtureMessage(model, [{
                        type: "text",
                        text: "Native model evidence: https://example.com/pi-search-resolvers?utm_source=native",
                    }], "stop"));
                }
                persist();
                return fixtureStream(fixtureMessage(model, [{ type: "text", text: "Search completed" }], "stop"));
            },
        } as never);
    }

    const globalFetchTrap: typeof fetch = () => Promise.reject(new Error("installed package bypassed runtime transport seam"));
    globalThis.fetch = nativeMode ? globalFetchTrap : demoFetch;
    (globalThis as Record<symbol, unknown>)[runtimeTransportSymbol] = demoFetch;
    (globalThis as Record<symbol, unknown>)[nativeSourceSymbol] = nativeSource;
    persist();

    pi.on("tool_execution_start", (event, ctx) =>
    {
        if (!cancellationMode || event.toolName !== "web_search") return;
        abortCurrent = () => ctx.abort();
        fallbackAbort = setTimeout(() => abortCurrent?.(), 3_000);
    });
    pi.on("session_start", () =>
    {
        const surfaceReportPath = process.env.PI_WEB_SEARCH_SURFACE_REPORT;
        if (surfaceReportPath === undefined) return;

        writeFileSync(
            surfaceReportPath,
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
        if (fallbackAbort !== undefined) clearTimeout(fallbackAbort);
        if (fetch === demoFetch || fetch === globalFetchTrap) globalThis.fetch = originalFetch;
        delete (globalThis as Record<symbol, unknown>)[runtimeTransportSymbol];
        delete (globalThis as Record<symbol, unknown>)[nativeSourceSymbol];
    });
}
