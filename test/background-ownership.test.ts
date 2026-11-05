import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { BackgroundSearchRuntime } from "../src/background-search.ts";
import type { SearchDetails } from "../src/types.ts";

const details: SearchDetails = { provider: "duckduckgo-html", query: "query", answer: "Complete native answer", results: [{ title: "Evidence", url: "https://example.com", snippet: "Full tail evidence" }], durationMs: 25, truncated: false };
const boundary = () => ({ entries: [], outcome: "completed" as const, context: { canContinue: true } });
function setup() {
  const pi = { sendMessage: vi.fn(), appendEntry: vi.fn() };
  const ctx = { isIdle: () => false, ui: { setStatus: vi.fn() } } as unknown as ExtensionContext;
  const runtime = new BackgroundSearchRuntime(pi as unknown as ExtensionAPI);
  return { runtime, pi, ctx };
}

describe("delayed search ownership", () => {
  it("captures the real outer execution before its nested launches finish, independent of completion order", async () => {
    const { runtime, ctx } = setup();
    runtime.executionStarted("outer-a");
    runtime.executionStarted("middle", "outer-a");
    runtime.executionStarted("leaf-a", "middle");
    let finish!: (value: SearchDetails) => void;
    runtime.start("leaf-a", "slow", () => new Promise((resolve) => { finish = resolve; }), ctx);
    runtime.executionEnded("leaf-a");
    runtime.executionEnded("middle");
    runtime.executionEnded("outer-a");
    runtime.executionStarted("outer-b");
    runtime.start("outer-b", "fast", async () => details, ctx);
    await vi.waitFor(() => expect(runtime.readyCount()).toBe(1));
    finish(details);
    await vi.waitFor(() => expect(runtime.readyCount()).toBe(2));
    const delivery = runtime.deliverBoundary(boundary())!;
    const cards = delivery.entries!.filter((entry) => entry.type === "custom");
    expect(cards.map((entry) => entry.data)).toMatchObject([
      { requestId: "outer-b", parentToolCallId: "outer-b" },
      { requestId: "leaf-a", parentToolCallId: "outer-a" },
    ]);
    const messages = delivery.entries!.filter((entry) => entry.type === "custom_message");
    expect(messages).toHaveLength(2);
    expect(messages.every((message) => message.display === false)).toBe(true);
    expect(messages[1]!.content).toContain("Complete native answer");
    expect(runtime.deliverBoundary(boundary())).toBeUndefined();
  });

  it("stages Wait cards at the commit boundary but returns full data only through Wait", async () => {
    const { runtime, pi, ctx } = setup();
    runtime.executionStarted("launch");
    runtime.start("launch", "query", async () => details, ctx);
    const results = await runtime.wait();
    expect(results).toMatchObject([{ requestId: "launch", search: details }]);
    expect(pi.appendEntry).not.toHaveBeenCalled();
    const delivery = runtime.deliverBoundary(boundary())!;
    expect(delivery.entries).toHaveLength(1);
    expect(delivery.entries![0]).toMatchObject({ type: "custom", data: { requestId: "launch", parentToolCallId: "launch" } });
    expect(delivery.continue).not.toBe(true);
    expect(await runtime.wait()).toEqual([]);
    expect(runtime.deliverBoundary(boundary())).toBeUndefined();
  });

  it("drops staged Wait cards on an aborted boundary or branch reset", async () => {
    for (const reset of [false, true]) {
      const { runtime, pi, ctx } = setup();
      runtime.executionStarted("launch");
      runtime.start("launch", "query", async () => details, ctx);
      await runtime.wait();
      if (reset) runtime.reset(ctx);
      const delivery = runtime.deliverBoundary({ ...boundary(), outcome: "aborted" });
      expect(delivery).toBeUndefined();
      expect(runtime.deliverBoundary(boundary())).toBeUndefined();
      expect(pi.appendEntry).not.toHaveBeenCalled();
    }
  });

  it("never guesses a missing nested parent and cannot reuse an owner after reset", async () => {
    const { runtime, ctx } = setup();
    runtime.executionStarted("missing-child", "unobserved-parent");
    runtime.start("missing-child", "query", async () => details, ctx);
    const [result] = await runtime.wait();
    expect(result).not.toHaveProperty("parentToolCallId");
    runtime.reset(ctx);
    runtime.start("missing-child", "query", async () => details, ctx);
    expect((await runtime.wait())[0]).not.toHaveProperty("parentToolCallId");
  });

  it("keeps full native answers and redacted source failures on both delivery paths", async () => {
    const complete: SearchDetails = {
      ...details, answer: "Native answer with a full tail marker",
      native: { status: "success", provider: "fixture", model: "exact-model", durationMs: 20 },
      attempts: [{ provider: "fixture", status: "failure", durationMs: 5, resultsCount: 0, error: "HTTP 401 Bearer secret-token apiKey=private-key" }],
    };
    for (const wait of [true, false]) {
      const { runtime, ctx } = setup();
      runtime.executionStarted("launch");
      runtime.start("launch", "query", async () => complete, ctx);
      await vi.waitFor(() => expect(runtime.readyCount()).toBe(1));
      const results = wait ? await runtime.wait() : undefined;
      const delivery = runtime.deliverBoundary(boundary())!;
      const full = wait ? JSON.stringify(results) : String(delivery.entries!.find((entry) => entry.type === "custom_message")!.content);
      expect(full).toContain(complete.answer);
      expect(full).toContain("exact-model");
      expect(full).toContain("HTTP 401");
      expect(full).not.toContain("secret-token");
      expect(full).not.toContain("private-key");
      expect(delivery.entries!.filter((entry) => entry.type === "custom")).toHaveLength(1);
      expect(await runtime.wait()).toEqual([]);
    }
  });

  it("publishes one idle card before waking with complete hidden model data", async () => {
    const { runtime, ctx, pi } = setup();
    const idle = { ...ctx, isIdle: () => true };
    runtime.executionStarted("idle-launch");
    runtime.start("idle-launch", "query", async () => details, idle);
    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledOnce());
    expect(pi.appendEntry).toHaveBeenCalledWith("web-search:card", expect.objectContaining({ parentToolCallId: "idle-launch" }));
    expect(pi.appendEntry.mock.invocationCallOrder[0]).toBeLessThan(pi.sendMessage.mock.invocationCallOrder[0]!);
    expect(pi.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ display: false, content: expect.stringContaining("Complete native answer") }), { triggerTurn: true });
    expect(await runtime.wait()).toEqual([]);
    expect(runtime.deliverBoundary(boundary())).toBeUndefined();
  });

  it("an ignored-abort completion cannot attach to a reused call ID on a new branch", async () => {
    const { runtime, ctx } = setup();
    let oldFinish!: (value: SearchDetails) => void;
    runtime.executionStarted("old-root");
    runtime.executionStarted("reused", "old-root");
    runtime.start("reused", "old", () => new Promise((resolve) => { oldFinish = resolve; }), ctx);
    await Promise.resolve();
    runtime.reset(ctx);
    runtime.executionStarted("new-root");
    runtime.executionStarted("reused", "new-root");
    runtime.start("reused", "new", async () => details, ctx);
    oldFinish({ ...details, answer: "STALE ANSWER" });
    const results = await runtime.wait();
    expect(results).toMatchObject([{ query: "new", parentToolCallId: "new-root" }]);
    expect(JSON.stringify(runtime.deliverBoundary(boundary()))).not.toContain("STALE ANSWER");
  });
});
