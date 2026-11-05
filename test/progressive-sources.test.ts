import { afterEach, expect, it, vi } from "vitest";
import { performSearch } from "#src/search.ts";
import type { SearchDetails, WebsearchConfig } from "#src/types.ts";

const config: WebsearchConfig = { providers: [{ provider: "serper", apiKey: "test" }], sourceTimeoutMs: 1000, aggregateDeadlineMs: 2000 };
const request = { query: "fixture query", maxResults: 10 };
const model = { provider: "openai-codex", id: "fixture-model" };
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
afterEach(() => vi.unstubAllGlobals());

it("reports each source when it finishes, without repeating the first source", async () => {
  const external = deferred<Response>();
  const native = deferred<{ text: string; provider: string; model: string }>();
  vi.stubGlobal("fetch", () => external.promise);
  const reports: SearchDetails[] = [];
  const result = performSearch(config, request, undefined, { activeModel: model, nativeSource: { isEligible: () => true, search: () => native.promise } }, (value) => reports.push(value));
  external.resolve(Response.json({ organic: [{ title: "External", link: "https://example.com/first" }] }));
  await tick();
  expect(reports).toHaveLength(1);
  expect(reports[0]?.results.map(item => item.url)).toEqual(["https://example.com/first"]);
  expect(reports[0]?.answer).toBeUndefined();
  native.resolve({ text: "native fixture", provider: model.provider, model: model.id });
  const aggregate = await result;
  expect(reports).toHaveLength(2);
  expect(reports[1]?.answer).toBe("native fixture");
  expect(reports[1]?.results).toEqual([]);
  expect(aggregate.answer).toBe("native fixture");
  expect(aggregate.results).toHaveLength(1);
});


it("reports a native result before an external failure", async () => {
  const external = deferred<Response>();
  const native = deferred<{ text: string; provider: string; model: string }>();
  vi.stubGlobal("fetch", () => external.promise);
  const reports: SearchDetails[] = [];
  const result = performSearch(config, request, undefined, { activeModel: model, nativeSource: { isEligible: () => true, search: () => native.promise } }, (value) => reports.push(value));
  native.resolve({ text: "native fixture", provider: model.provider, model: model.id });
  await tick();
  expect(reports).toHaveLength(1);
  expect(reports[0]?.answer).toBe("native fixture");
  external.resolve(new Response("unavailable", { status: 503 }));
  await result;
  expect(reports).toHaveLength(2);
  expect(reports[1]?.error).toBeTruthy();
  expect(reports[1]?.attempts?.[0]?.status).toBe("failure");
  expect(reports[1]?.answer).toBeUndefined();
});

it("reports each pending source once when the aggregate deadline expires", async () => {
  const external = deferred<Response>();
  const native = deferred<{ text: string; provider: string; model: string }>();
  vi.stubGlobal("fetch", () => external.promise);
  const reports: SearchDetails[] = [];
  const result = performSearch({ ...config, aggregateDeadlineMs: 15 }, request, undefined, { activeModel: model, nativeSource: { isEligible: () => true, search: () => native.promise } }, (value) => reports.push(value));
  await result;
  expect(reports).toHaveLength(2);
  expect(reports.find(item => item.attempts)?.attempts?.[0]?.timeoutReason).toBe("aggregate-deadline");
  expect(reports.find(item => item.native)?.native?.timeoutReason).toBe("aggregate-deadline");
  external.resolve(Response.json({ organic: [{ title: "Too late", link: "https://example.com/late" }] }));
  native.resolve({ text: "late", provider: model.provider, model: model.id });
  await tick();
  expect(reports).toHaveLength(2);
});

it("never reports a source after caller cancellation", async () => {
  const external = deferred<Response>();
  const native = deferred<{ text: string; provider: string; model: string }>();
  vi.stubGlobal("fetch", () => external.promise);
  const reports: SearchDetails[] = [];
  const controller = new AbortController();
  const result = performSearch(config, request, controller.signal, { activeModel: model, nativeSource: { isEligible: () => true, search: () => native.promise } }, (value) => reports.push(value));
  controller.abort(new Error("cancelled"));
  await expect(result).rejects.toBe(controller.signal.reason);
  external.resolve(Response.json({ organic: [{ title: "Too late", link: "https://example.com/late" }] }));
  native.resolve({ text: "late", provider: model.provider, model: model.id });
  await tick();
  expect(reports).toEqual([]);
});

it("does not report an ineligible native source", async () => {
  vi.stubGlobal("fetch", () => Promise.resolve(Response.json({ organic: [{ title: "External", link: "https://example.com/first" }] })));
  const reports: SearchDetails[] = [];
  await performSearch(config, request, undefined, { activeModel: model, nativeSource: { isEligible: () => false, search: async () => { throw new Error("not eligible"); } } }, (value) => reports.push(value));
  expect(reports).toHaveLength(1);
  expect(reports[0]?.results).toHaveLength(1);
});


it("reports a source timeout and ignores its late completion", async () => {
  const external = deferred<Response>();
  vi.stubGlobal("fetch", () => external.promise);
  const reports: SearchDetails[] = [];
  await performSearch({ ...config, sourceTimeoutMs: 15 }, request, undefined, undefined, (value) => reports.push(value));
  expect(reports).toHaveLength(1);
  expect(reports[0]?.attempts?.[0]?.timeoutReason).toBe("source-timeout");
  external.resolve(Response.json({ organic: [{ title: "Too late", link: "https://example.com/late" }] }));
  await tick();
  expect(reports).toHaveLength(1);
});

it("propagates a callback exception after the search finishes", async () => {
  vi.stubGlobal("fetch", () => Promise.resolve(Response.json({ organic: [{ title: "External", link: "https://example.com/first" }] })));
  const failure = new Error("fixture failure");
  await expect(performSearch(config, request, undefined, undefined, () => { throw failure; })).rejects.toBe(failure);
});