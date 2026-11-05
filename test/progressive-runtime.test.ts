import { expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BackgroundSearchRuntime } from "../src/background-search.ts";
import type { SearchDetails } from "../src/types.ts";

const external: SearchDetails = { provider: "serper", query: "example", results: [{ title: "First", url: "https://example.com" }], durationMs: 5, truncated: false };
const native: SearchDetails = { provider: "serper", query: "example", results: [], answer: "Second", durationMs: 20, truncated: false, native: { status: "success" } };

it("returns the first usable source and delivers the other once under the original call", async () => {
  const runtime = new BackgroundSearchRuntime({ sendMessage: vi.fn(), appendEntry: vi.fn() } as unknown as ExtensionAPI);
  const ctx = { isIdle: () => false, ui: { setStatus: vi.fn() } } as unknown as ExtensionContext;
  runtime.executionStarted("outer"); runtime.executionStarted("inner", "outer");
  let emit!: (value: SearchDetails) => void;
  let finish!: (value: SearchDetails) => void;
  const first = runtime.startProgressive("inner", "example", (_signal, onSource) => {
    emit = onSource;
    return new Promise(resolve => { finish = resolve; });
  }, ctx, false);
  await Promise.resolve();
  emit(external);
  expect(await first).toEqual(external);
  const waiting = runtime.wait();
  emit(native);
  finish({ ...external, answer: native.answer });
  const results = await waiting;
  expect(results).toHaveLength(1);
  expect(results[0]).toMatchObject({ requestId: "inner", parentToolCallId: "outer", query: "example", search: native });
  expect(await runtime.wait()).toEqual([]);
});

it("delivers background sources independently without replaying the aggregate", async () => {
  const runtime = new BackgroundSearchRuntime({ sendMessage: vi.fn(), appendEntry: vi.fn() } as unknown as ExtensionAPI);
  const ctx = { isIdle: () => false, ui: { setStatus: vi.fn() } } as unknown as ExtensionContext;
  let emit!: (value: SearchDetails) => void;
  let finish!: (value: SearchDetails) => void;
  const done = runtime.startProgressive("call", "example", (_signal, onSource) => {
    emit = onSource;
    return new Promise(resolve => { finish = resolve; });
  }, ctx, true);
  await Promise.resolve();
  emit(external);
  const boundary = { entries: [], outcome: "completed" as const, context: { canContinue: true } };
  const first = runtime.deliverBoundary(boundary);
  expect(first?.entries?.filter(entry => entry.type === "custom_message")).toHaveLength(1);
  const wait = runtime.wait();
  emit(native); finish({ ...external, answer: native.answer });
  await done;
  expect((await wait).map(result => result.search)).toEqual([native]);
  expect(runtime.deliverBoundary(boundary)?.entries?.filter(entry => entry.type === "custom_message") ?? []).toHaveLength(0);
});

it("wait returns a ready source without waiting for the other source", async () => {
  const runtime = new BackgroundSearchRuntime({ sendMessage: vi.fn(), appendEntry: vi.fn() } as unknown as ExtensionAPI);
  const ctx = { isIdle: () => false, ui: { setStatus: vi.fn() } } as unknown as ExtensionContext;
  let emit!: (value: SearchDetails) => void;
  let finish!: (value: SearchDetails) => void;
  const done = runtime.startProgressive("call", "example", (_signal, onSource) => {
    emit = onSource;
    return new Promise(resolve => { finish = resolve; });
  }, ctx, true);
  await Promise.resolve();
  const wait = runtime.wait();
  emit(external);
  const outcome = await Promise.race([wait, new Promise(resolve => setTimeout(() => resolve("late"), 50))]);
  expect(outcome).not.toBe("late");
  expect(outcome).toMatchObject([{ requestId: "call", search: external }]);
  emit(native); finish({ ...external, answer: native.answer });
  await done;
  expect((await runtime.wait()).map(result => result.search)).toEqual([native]);
});