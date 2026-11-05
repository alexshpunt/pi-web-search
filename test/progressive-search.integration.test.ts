import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assistantMessage, getToolExecution, getToolExecutionDetails, PiIntegrationTest, testArtifactsDir, text, toolCall } from "pi-coding-agent-test";
import { expect, test } from "vitest";

// The fixture replaces only HTTP, including Codex metadata and its SSE endpoint.
// A closed loopback WebSocket port forces the SDK's normal SSE fallback.
const fixtureSource = `
export default function fixture(pi) {
  let models = [];
  let release;
  let released = false;
  function releaseNative() { released = true; if (release) release(); }
  pi.on("session_start", (_event, ctx) => {
    models = ctx.modelRegistry.getAvailable().filter(m => m.provider === "openai-codex").map(m => m.id);
  });
  let timer;
  const nativeResponse = () => {
    const item = { id: "msg_test", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "NATIVE_EVIDENCE", annotations: [] }] };
    const events = [
      { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
      { type: "response.output_text.delta", output_index: 0, delta: "NATIVE_EVIDENCE" },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id: "resp_test", status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } },
    ];
    return new Response(events.map(event => 'data: ' + JSON.stringify(event) + '\\n\\n').join(''), { headers: { "content-type": "text/event-stream" } });
  };
  globalThis[Symbol.for("pi-web-search.runtime-transport")] = async (input, init) => {
    const url = String(input);
    if (url.includes("/codex/models")) return Response.json({ models: models.map(slug => ({ slug, supports_search_tool: true })) });
    if (url.includes("/codex/responses")) {
      timer = setTimeout(releaseNative, 2500);
      if (!released) await new Promise((resolve, reject) => {
        release = resolve;
        init?.signal?.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      });
      return nativeResponse();
    }
    if (url.includes("google.serper.dev")) return Response.json({ organic: [{ title: "EXTERNAL_EVIDENCE", link: "https://example.com/evidence" }] });
    throw new Error("Unexpected request " + url);
  };
  pi.on("tool_execution_start", event => { if (event.toolName === "wait_for_web_searches") releaseNative(); });
  pi.on("session_shutdown", () => clearTimeout(timer));
}
`;

test("returns external evidence before native completion and delivers native evidence once to its originating call", async () => {
  await mkdir(path.resolve(".tmp"), { recursive: true });
  const cwd = await mkdtemp(path.resolve(".tmp/progressive-search-"));
  const agent = await mkdtemp(path.resolve(".tmp/progressive-agent-"));
  try {
    await mkdir(path.join(cwd, ".pi"), { recursive: true });
    await writeFile(path.join(cwd, ".pi", "websearch.json"), JSON.stringify({ providers: [{ provider: "serper", apiKey: "test-key" }], sourceTimeoutMs: 5000, aggregateDeadlineMs: 6000 }));
    const token = `x.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } })).toString("base64url")}.x`;
    await writeFile(path.join(agent, "auth.json"), JSON.stringify({ "openai-codex": { type: "oauth", access: token, refresh: "unused", expires: Date.now() + 3_600_000 } }));
    await writeFile(path.join(agent, "models.json"), JSON.stringify({ providers: { "openai-codex": { baseUrl: "http://127.0.0.1:1/backend-api" } } }));
    const fixture = path.join(cwd, "fixture.ts");
    await writeFile(fixture, fixtureSource);
    const result = await new PiIntegrationTest({
      piCommand: path.resolve("node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
      testName: "progressive-search-foreground", artifactsDir: testArtifactsDir(import.meta.filename), cwd,
      extensions: [fixture, path.resolve("index.ts")], tools: ["web_search", "wait_for_web_searches"],
      isolateUserResources: true, rawMode: false,
      environment: { PI_CODING_AGENT_DIR: agent, HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "" },
      conversation: [
        assistantMessage([toolCall({ id: "search-call", name: "web_search", arguments: { query: "progressive query" } })], { stopReason: "toolUse" }),
        assistantMessage([toolCall({ id: "consume-late", name: "wait_for_web_searches", arguments: {} })], { stopReason: "toolUse" }),
        assistantMessage([toolCall({ id: "consume-again", name: "wait_for_web_searches", arguments: {} })], { stopReason: "toolUse" }),
        assistantMessage([text("Done")]),
      ],
    }).run("Search and use each source as it finishes");
    const first = getToolExecutionDetails(getToolExecution(result, "search-call")) as { results: Array<{ title: string }>; answer?: string };
    expect(first.results.map(item => item.title)).toContain("EXTERNAL_EVIDENCE");
    expect(first.answer).toBeUndefined();
    const later = getToolExecutionDetails(getToolExecution(result, "consume-late")) as { results: Array<{ requestId: string; parentToolCallId?: string; query: string; search?: { answer?: string; results: unknown[] } }> };
    expect(later.results).toHaveLength(1);
    expect(later.results[0]).toMatchObject({ requestId: "search-call", parentToolCallId: "search-call", query: "progressive query", search: { answer: "NATIVE_EVIDENCE", results: [] } });
    expect(getToolExecutionDetails(getToolExecution(result, "consume-again"))).toMatchObject({ results: [] });
  } finally {
    await Promise.all([cwd, agent].map(directory => rm(directory, { recursive: true, force: true })));
  }
}, 30_000);
