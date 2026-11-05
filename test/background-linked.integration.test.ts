import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { assistantMessage, getToolExecution, getToolExecutionDetails, getToolExecutionResult, getToolResultText, PiIntegrationTest, testArtifactsDir, text, toolCall } from "pi-coding-agent-test";
import { expect, test } from "vitest";

// Cross-extension checks opt into a separately installed, read-only Stereo checkout.
const stereo = process.env.PI_WEB_SEARCH_STEREO_EXTENSION;
const artifactsDir = testArtifactsDir(import.meta.filename);
const clean = (lines: string[]) => lines.map(stripTerminalSequences).join("\n");
type Capture = { panes: Record<string, string[]>; search: Record<string, { text: string }[]>; native: string[]; expanded: string[]; sourceChildrenUnchanged: boolean };
const control = (id: string, query: string) => assistantMessage([toolCall({ id, name: "search_fixture_control", arguments: { action: "release", query } })], { stopReason: "toolUse" });
const wait = (id: string) => assistantMessage([toolCall({ id, name: "wait_for_web_searches", arguments: {} })], { stopReason: "toolUse" });

for (const layout of ["columns", "rows"]) for (const delivery of ["auto", "wait"]) {
  test.skipIf(!stereo)(`links reverse-order direct and Codemode results to original calls in ${layout} with ${delivery} delivery`, async () => {
    await mkdir(path.resolve(".tmp"), { recursive: true });
    const cwd = await mkdtemp(path.resolve(".tmp/linked-search-"));
    const agent = await mkdtemp(path.resolve(".tmp/linked-agent-"));
    const name = `linked-search-${layout}-${delivery}`;
    const captureFile = path.join(artifactsDir, name, "capture.json");
    try {
      await writeFile(path.join(agent, "settings.json"), JSON.stringify({ quietStartup: true }));
      await writeFile(path.join(agent, "transcript.json"), JSON.stringify({ mode: "split", side: "left", chatWidth: 60, layout, chatHeight: 12, zoom: null, showTimestamps: false }));
      const result = await new PiIntegrationTest({
        testName: name, artifactsDir, cwd, rawMode: false, isolateUserResources: false,
        piCommand: path.resolve("test/fixtures/background-linked-host.sh"),
        extensions: [path.resolve("test/fixtures/background-search-transport.ts"), path.resolve("index.ts"), "builtin:codemode", stereo!, path.resolve("test/fixtures/background-linked-probe.ts")],
        tools: ["web_search", "wait_for_web_searches", "search_fixture_control", "search_fixture_nested", "codemode"],
        environment: { PI_CODING_AGENT_DIR: agent, PI_WEB_SEARCH_TEST_CLI: path.resolve("node_modules/@earendil-works/pi-coding-agent/dist/cli.js"), PI_WEB_SEARCH_BACKGROUND_MODE: delivery === "wait" ? "wait" : "parallel", PI_WEB_SEARCH_LINKED_CAPTURE: captureFile },
        conversation: [
          assistantMessage([toolCall({ id: "direct-owner", name: "web_search", arguments: { query: "slow", background: true } })], { stopReason: "toolUse" }),
          assistantMessage([toolCall({ id: "code-owner", name: "codemode", arguments: { code: 'text(await tools.search_fixture_nested({query:"fast"}));' } })], { stopReason: "toolUse" }),
          ...(delivery === "wait" ? [wait("consume")] : [control("release-fast", "fast"), control("release-slow", "slow")]),
          wait("empty"), assistantMessage([text("Search results processed")]),
        ],
      }).run("Launch two owned background searches and consume each complete result once");
      expect(result.exitCode).toBe(0);
      expect(getToolExecution(result, "code-owner").isError, getToolResultText(result, "code-owner")).toBe(false);
      const snapshot = result.traceEvents.findLast((event) => event.type === "session_snapshot")!;
      const entries = snapshot.branch as { type: string; customType?: string; data?: { requestId: string; parentToolCallId?: string; query: string }; display?: boolean; content?: unknown }[];
      const cards = entries.filter((entry) => entry.type === "custom" && entry.customType === "web-search:card");
      expect(cards.map((entry) => entry.data)).toMatchObject([
        { query: "fast", requestId: "code-owner/1/1", parentToolCallId: "code-owner" },
        { query: "slow", requestId: "direct-owner", parentToolCallId: "direct-owner" },
      ]);
      const messages = entries.filter((entry) => entry.type === "custom_message" && entry.customType === "web-search:result");
      expect(messages).toHaveLength(delivery === "auto" ? 2 : 0);
      expect(messages.every((entry) => entry.display === false)).toBe(true);
      if (delivery === "wait") {
        expect(getToolExecutionDetails(getToolExecution(result, "consume"))).toMatchObject({ results: [{ query: "fast" }, { query: "slow" }] });
        const structured = (getToolExecutionResult(result, "consume") as { structuredContent: unknown }).structuredContent;
        expect(JSON.stringify(structured)).toContain("FAST_TAIL_MARKER");
        expect(getToolResultText(result, "consume")).toContain("SLOW_TAIL_MARKER");
      }
      expect(getToolExecutionDetails(getToolExecution(result, "empty"))).toMatchObject({ results: [] });
      const messagesToModel = result.providerRequests.at(-1)!.messages as { content: unknown }[];
      const request = JSON.stringify(messagesToModel.map((message) => message.content));
      for (const marker of ["FAST_TAIL_MARKER", "SLOW_TAIL_MARKER"]) expect(request.split(marker)).toHaveLength(2);
      const capture: Capture = JSON.parse(await readFile(captureFile, "utf8"));
      const activity = clean(capture.panes.activity!), chat = clean(capture.panes.chat!);
      for (const query of ["slow", "fast"]) {
        expect(activity.split(`Query: ${query}`)).toHaveLength(2);
        expect(chat).not.toContain(`Query: ${query}`);
        expect(capture.search.activity!.map((entry) => entry.text).join("\n")).toContain(`Query: ${query}`);
        expect(capture.search.chat!.map((entry) => entry.text).join("\n")).not.toContain(`Query: ${query}`);
      }
      expect(activity.indexOf("Query: slow")).toBeLessThan(activity.indexOf("codemode"));
      expect(activity.indexOf("codemode")).toBeLessThan(activity.indexOf("Query: fast"));
      expect(clean(capture.native).indexOf("Query: fast")).toBeLessThan(clean(capture.native).indexOf("Query: slow"));
      expect(capture.sourceChildrenUnchanged).toBe(true);
      // Excerpt presentation removes Markdown syntax; structured results keep the original bytes.
      expect(clean(capture.expanded)).toContain("FASTTAILMARKER");
      expect(clean(capture.expanded)).toContain("SLOWTAILMARKER");
      if (delivery === "wait") expect(activity).toContain("Consumed 2 web search results.");
      expect(stripTerminalSequences(result.terminalOutput)).toContain("Activity");
    } finally {
      await Promise.all([cwd, agent].map((directory) => rm(directory, { recursive: true, force: true })));
    }
  }, 30_000);
}
