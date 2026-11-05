import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { BackgroundSearchRuntime } from "../src/background-search.ts";
import type { SearchDetails } from "../src/types.ts";

const details: SearchDetails = { provider: "duckduckgo-html", query: "query", results: [{ title: "Evidence", url: "https://example.com", snippet: "Full evidence" }], durationMs: 25, truncated: false };
const deferred = () => {
  let resolve!: (result: SearchDetails) => void;
  const promise = new Promise<SearchDetails>((done) => { resolve = done; });
  return { promise, resolve };
};
function setup() {
  const sendMessage = vi.fn();
  const appendEntry = vi.fn();
  const runtime = new BackgroundSearchRuntime({ sendMessage, appendEntry } as unknown as ExtensionAPI);
  const controller = new AbortController();
  let idle = false;
  const ctx = { signal: controller.signal, isIdle: () => idle, ui: { setStatus: vi.fn() } } as unknown as ExtensionContext;
  runtime.setContext(ctx);
  return { runtime, ctx, controller, sendMessage, appendEntry, settle: () => { idle = true; runtime.setContext({ ...ctx, signal: undefined }); } };
}
const boundary = () => ({ entries: [], outcome: "completed" as const, context: { canContinue: true } });

describe("background search delivery", () => {
  it("keeps ready results out of active tool pairs and appends them once at a safe boundary", async () => {
    const { runtime, ctx, sendMessage } = setup();
    const slow = deferred(), fast = deferred();
    runtime.start("slow", "slow query", () => slow.promise, ctx);
    runtime.start("fast", "fast query", () => fast.promise, ctx);
    fast.resolve({ ...details, query: "fast query" });
    await vi.waitFor(() => expect(runtime.readyCount()).toBe(1));
    expect(sendMessage).not.toHaveBeenCalled();
    const result = runtime.deliverBoundary(boundary());
    expect(result?.entries?.filter((entry) => entry.type === "custom_message")).toHaveLength(1);
    expect(result?.entries?.filter((entry) => entry.type === "custom")).toHaveLength(1);
    expect(result?.continue).toBe(true);
    expect(JSON.stringify(result?.entries)).toContain("fast");
    expect(runtime.deliverBoundary(boundary())).toBeUndefined();
    runtime.cancelAll();
    slow.resolve(details);
  });

  it("reserves a wait snapshot and does not consume searches launched afterward", async () => {
    const { runtime, ctx } = setup();
    const first = deferred(), next = deferred();
    runtime.start("first", "first", () => first.promise, ctx);
    const wait = runtime.wait();
    runtime.start("next", "next", () => next.promise, ctx);
    next.resolve(details);
    first.resolve(details);
    const received = await wait;
    expect(received.map((result) => result.requestId)).toEqual(["first"]);
    expect(JSON.stringify(runtime.deliverBoundary(boundary())?.entries)).toContain("next");
    expect(await runtime.wait()).toEqual([]);
  });

  it("cancels providers on stop and ignores late completions even when transport ignores abort", async () => {
    const { runtime, ctx, controller, sendMessage, appendEntry, settle } = setup();
    const result = deferred();
    let signal!: AbortSignal;
    runtime.start("cancel", "cancel", (ownedSignal) => { signal = ownedSignal; return result.promise; }, ctx);
    await Promise.resolve();
    const wait = runtime.wait();
    controller.abort();
    await expect(wait).rejects.toThrow(/abort|interrupt|cancel/i);
    expect(signal.aborted).toBe(true);
    expect(appendEntry.mock.calls).toEqual([["web-search:cancelled", { requestId: "cancel", status: "cancelled" }]]);
    settle();
    result.resolve(details);
    await Promise.resolve();
    expect(runtime.readyCount()).toBe(0);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("resets session ownership without replaying paid searches or routing stale results", async () => {
    const { runtime, ctx, sendMessage, appendEntry } = setup();
    const result = deferred();
    let signal!: AbortSignal;
    runtime.start("old-branch", "old", (ownedSignal) => { signal = ownedSignal; return result.promise; }, ctx);
    await Promise.resolve();
    runtime.reset(ctx);
    expect(signal.aborted).toBe(true);
    result.resolve(details);
    await Promise.resolve();
    expect(runtime.deliverBoundary(boundary())).toBeUndefined();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(appendEntry).not.toHaveBeenCalled();
  });

  it("records each provider-error cancellation once without waking a stopped agent or poisoning its retry", async () => {
    const { runtime, ctx, sendMessage, appendEntry, settle } = setup();
    const old = deferred();
    let signal!: AbortSignal;
    runtime.executionStarted("outer");
    runtime.executionStarted("request", "outer");
    runtime.start("request", "old", (ownedSignal) => { signal = ownedSignal; return old.promise; }, ctx);
    await Promise.resolve();
    const wait = runtime.wait();
    const interrupted = expect(wait).rejects.toBeInstanceOf(DOMException);
    expect(runtime.deliverBoundary({ ...boundary(), outcome: "error" })).toBeUndefined();
    runtime.cancelAll();
    expect(runtime.deliverBoundary({ ...boundary(), outcome: "error" })).toBeUndefined();
    await interrupted;
    expect(signal.aborted).toBe(true);
    expect(appendEntry.mock.calls).toEqual([["web-search:cancelled", { requestId: "request", parentToolCallId: "outer", status: "cancelled" }]]);
    expect(await runtime.wait()).toEqual([]);
    settle();
    old.resolve({ ...details, answer: "late discarded result" });
    await Promise.resolve();
    expect(runtime.readyCount()).toBe(0);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(runtime.deliverBoundary(boundary())).toBeUndefined();
    runtime.resume(ctx);
    runtime.start("retry", "new", async () => details, ctx);
    expect((await runtime.wait()).map(result => result.requestId)).toEqual(["retry"]);
    expect(appendEntry).toHaveBeenCalledTimes(1);
  });

  it("detaches every cancelled job before abort listeners run", async () => {
    const { runtime, ctx, appendEntry } = setup();
    for (const id of ["first", "second"]) {
      runtime.start(id, id, signal => {
        signal.addEventListener("abort", () => runtime.cancelAll(), { once: true });
        return new Promise(() => {});
      }, ctx);
    }
    await Promise.resolve();
    runtime.cancelAll();
    expect(appendEntry.mock.calls).toEqual([
      ["web-search:cancelled", { requestId: "first", status: "cancelled" }],
      ["web-search:cancelled", { requestId: "second", status: "cancelled" }],
    ]);
    expect(await runtime.wait()).toEqual([]);
  });
  it("delivers rejected search diagnostics as a correlated failure without exposing credentials", async () => {
    const { runtime, ctx } = setup();
    runtime.start("failure", "failure", () => Promise.reject(new Error("HTTP 401 Bearer secret-token apiKey=private-key")), ctx);
    await vi.waitFor(() => expect(runtime.readyCount()).toBe(1));
    const result = JSON.stringify(runtime.deliverBoundary(boundary())?.entries);
    expect(result).toContain("failed");
    expect(result).toContain("HTTP 401");
    expect(result).not.toContain("secret-token");
    expect(result).not.toContain("private-key");
  });
});
