import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { assistantMessage, getToolExecution, getToolExecutionDetails, getToolResultText, PiIntegrationTest, testArtifactsDir, text, toolCall, type PiIntegrationTestOptions } from "pi-coding-agent-test";
import { expect, test } from "vitest";

const extension = path.resolve("index.ts");
const fixture = path.resolve("test/fixtures/background-search-transport.ts");
const call = (id: string, query: string) => toolCall({ id, name: "web_search", arguments: { query, background: true } });
const control = (id: string, action: string, query?: string) => assistantMessage([
  toolCall({ id, name: "search_fixture_control", arguments: { action, ...(query && { query }) } }),
], { stopReason: "toolUse" });
const wait = (id: string) => assistantMessage([toolCall({ id, name: "wait_for_web_searches", arguments: {} })], { stopReason: "toolUse" });

type Report = { started: string[]; completed: string[]; aborted: string[]; work: boolean };
async function run(mode: string, conversation: PiIntegrationTestOptions["conversation"]) {
  const root = path.resolve(".tmp");
  await mkdir(root, { recursive: true });
  const cwd = await mkdtemp(path.join(root, "background-search-"));
  const reportFile = path.join(cwd, "report.json");
  try {
    const result = await new PiIntegrationTest({
      piCommand: path.resolve("node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
      testName: `background-search-${mode}`, artifactsDir: testArtifactsDir(import.meta.filename), cwd,
      extensions: [fixture, extension], tools: ["web_search", "wait_for_web_searches", "search_fixture_control"],
      isolateUserResources: true, rawMode: false, conversation,
      environment: { PI_WEB_SEARCH_BACKGROUND_MODE: mode, PI_WEB_SEARCH_BACKGROUND_REPORT: reportFile },
    }).run(["tree", "new-session", "reload"].includes(mode) ? "/search-fixture-switch" : "Run independent background searches and use their complete results");
    const report = JSON.parse(await readFile(reportFile, "utf8")) as Report;
    return { result, report };
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

function backgroundMessages(result: Awaited<ReturnType<typeof run>>["result"]) {
  const snapshot = result.traceEvents.findLast((event) => event.type === "session_snapshot");
  const entries = snapshot?.branch as Array<{ type: string; customType?: string; content: unknown; details?: { query: string } }>;
  return entries.filter((entry) => entry.type === "custom_message" && entry.customType === "web-search:result");
}

test("launches parallel searches without blocking work and delivers full results once in completion order", async () => {
  const { result, report } = await run("parallel", [
    assistantMessage([call("slow-launch", "slow"), call("fast-launch", "fast")], { stopReason: "toolUse" }),
    control("work", "work"),
    control("release-fast", "release", "fast"),
    control("release-slow", "release", "slow"),
    wait("empty-wait"),
    assistantMessage([text("Searches processed")]),
  ]);
  expect(getToolExecution(result, "slow-launch").isError).toBe(false);
  expect(getToolExecution(result, "fast-launch").isError).toBe(false);
  expect(getToolExecutionDetails(getToolExecution(result, "slow-launch"))).toMatchObject({ status: "running", query: "slow", requestId: expect.any(String) });
  expect(report.work).toBe(true);
  expect(new Set(report.started)).toEqual(new Set(["slow", "fast"]));
  expect(report.completed).toEqual(["fast", "slow"]);
  const messages = backgroundMessages(result);
  expect(messages).toHaveLength(2);
  expect(messages.map((message) => (message.details as { query: string }).query)).toEqual(["fast", "slow"]);
  for (const [index, query] of ["fast", "slow"].entries()) {
    expect(String(messages[index]!.content)).toContain(`${query.toUpperCase()}_TAIL_MARKER`);
    expect(String(messages[index]!.content)).toContain('"native"');
    expect(String(messages[index]!.content)).toContain('"attempts"');
  }
  expect(getToolExecutionDetails(getToolExecution(result, "empty-wait"))).toMatchObject({ results: [] });
  expect(JSON.stringify(result.providerRequests)).toContain("FAST_TAIL_MARKER");
  expect(JSON.stringify(result.providerRequests)).toContain("SLOW_TAIL_MARKER");
  expect(result.tuiRenderedOutput).toContain("Web search");
  expect(result.tuiRenderedOutput).toContain("example.com");
  expect(result.tuiRenderedOutput).not.toContain("FAST_TAIL_MARKER");
  expect(result.tuiRenderedOutput).not.toContain('"attempts"');
}, 30_000);

test("waits for outstanding searches without duplicate automatic delivery or a later repeated result", async () => {
  const { result, report } = await run("wait", [
    assistantMessage([call("slow-launch", "slow"), call("fast-launch", "fast")], { stopReason: "toolUse" }),
    wait("wait-all"), wait("wait-again"), assistantMessage([text("Wait completed")]),
  ]);
  expect(report.completed).toEqual(["fast", "slow"]);
  expect(getToolExecution(result, "wait-all").isError).toBe(false);
  const first = getToolExecutionDetails(getToolExecution(result, "wait-all")) as { results: Array<{ query: string }> };
  expect(first.results.map((result) => result.query)).toEqual(["fast", "slow"]);
  expect(getToolResultText(result, "wait-all")).toContain("FAST_TAIL_MARKER");
  expect(getToolResultText(result, "wait-all")).toContain("SLOW_TAIL_MARKER");
  expect(backgroundMessages(result)).toHaveLength(0);
  expect(getToolExecutionDetails(getToolExecution(result, "wait-again"))).toMatchObject({ results: [] });
  expect(result.tuiRenderedOutput).not.toContain("SLOW_TAIL_MARKER");
}, 30_000);

test("wakes an idle agent with the full result instead of waiting for another user prompt", async () => {
  const { result, report } = await run("idle", [
    assistantMessage([call("fast-launch", "fast")], { stopReason: "toolUse" }),
    assistantMessage([text("Other work finished")]),
    assistantMessage([text("Late result processed")]),
  ]);
  expect(report.completed).toEqual(["fast"]);
  expect(result.providerRequests).toHaveLength(3);
  expect(backgroundMessages(result)).toHaveLength(1);
  expect(JSON.stringify(result.providerRequests.at(-1))).toContain("FAST_TAIL_MARKER");
  expect(result.tuiRenderedOutput).toContain("Late result processed");
}, 30_000);

test.each(["tree", "new-session", "reload"])("%s interrupts background searches without delivering them into the new history", async (mode) => {
  const { result, report } = await run(mode, [
    assistantMessage([call("slow-launch", "slow"), call("fast-launch", "fast")], { stopReason: "toolUse" }),
    assistantMessage([text("Old work finished")]),
    assistantMessage([text("New history checked")]),
  ]);
  expect(new Set(report.started)).toEqual(new Set(["slow", "fast"]));
  expect(new Set(report.aborted)).toEqual(new Set(["slow", "fast"]));
  expect(report.completed).toEqual([]);
  expect(backgroundMessages(result)).toHaveLength(0);
  const lastRequest = JSON.stringify(result.providerRequests.at(-1));
  if (mode !== "reload") expect(lastRequest).not.toContain("slow-launch");
  expect(lastRequest).not.toContain("TAIL_MARKER");
  expect(result.tuiRenderedOutput).toContain("New history checked");
}, 30_000);

test("delivers a correlated failure card with full redacted provider diagnostics", async () => {
  const { result } = await run("failure", [
    assistantMessage([call("failure-launch", "fast")], { stopReason: "toolUse" }),
    control("fail-source", "fail", "fast"),
    assistantMessage([text("Failure processed")]),
  ]);
  const messages = backgroundMessages(result);
  expect(messages).toHaveLength(1);
  const content = String(messages[0]!.content);
  expect(content).toContain('"status": "failed"');
  expect(content).toContain('"requestId": "failure-launch"');
  expect(content).toContain("HTTP 401");
  expect(content).not.toContain("secret-token");
  expect(content).not.toContain("private-key");
  expect(JSON.stringify(result.providerRequests.at(-1))).toContain("HTTP 401");
  expect(result.tuiRenderedOutput).toContain("Failed");
  expect(result.tuiRenderedOutput).not.toContain('"attempts"');
}, 30_000);

test("an explicit stop cancels detached search HTTP work and does not deliver a late result", async () => {
  const { result, report } = await run("stop", [
    assistantMessage([call("slow-launch", "slow"), call("fast-launch", "fast")], { stopReason: "toolUse" }),
    control("stop", "stop"),
  ]);
  expect(new Set(report.started)).toEqual(new Set(["slow", "fast"]));
  expect(new Set(report.aborted)).toEqual(new Set(["slow", "fast"]));
  expect(report.completed).toEqual([]);
  const snapshot = result.traceEvents.findLast(event => event.type === "session_snapshot");
  const branch = snapshot?.branch as Array<{ type: string; customType?: string; data?: { requestId: string; status: string } }>;
  const cancellations = branch.filter(entry => entry.type === "custom" && entry.customType === "web-search:cancelled");
  expect(cancellations.map(entry => entry.data).sort((a, b) => a!.requestId.localeCompare(b!.requestId))).toEqual([
    { requestId: "fast-launch", parentToolCallId: "fast-launch", status: "cancelled" },
    { requestId: "slow-launch", parentToolCallId: "slow-launch", status: "cancelled" },
  ]);
  expect(result.providerRequests).toHaveLength(2);
  expect(backgroundMessages(result)).toHaveLength(0);
}, 30_000);
