import { buildSearchRequest } from "./providers/request.ts";
import { normalizeSearchResponse } from "./providers/response.ts";
import { acquireNativeSearchAdapter, type NativeAdapter } from "./native-search.ts";
import type { JsonObject, NativeDetails, SearchAttempt, SearchDetails, SearchProviderEntry, SearchRequest, SearchResultItem, WebsearchConfig } from "./types.ts";
export { formatSearchText } from "./search-format.ts";

const MAX_ERROR_DETAIL_LENGTH = 500;
const AGGREGATE_DEADLINE_REASON = "aggregate-deadline";
const transport = () => (globalThis as Record<symbol, unknown>)[Symbol.for("pi-web-search.runtime-transport")] as typeof fetch | undefined ?? globalThis.fetch;
function isJsonObject(v: unknown): v is JsonObject { return typeof v === "object" && v !== null && !Array.isArray(v); }
function isWebUrl(v: string): boolean { try { const u = new URL(v); return u.protocol === "http:" || u.protocol === "https:"; } catch { return false; } }
function truncate(v: string, n = MAX_ERROR_DETAIL_LENGTH): string { return v.length > n ? `${v.slice(0, n - 1)}…` : v; }
function redact(v: string): string {
  return truncate(v
    .replace(/Bearer\s+[^\s,;]+/giu, "Bearer [redacted]")
    .replace(/(api[-_ ]?key|token|secret|password)\s*[=:]\s*[^\s,;]+/giu, "$1=[redacted]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/giu, "$1[redacted]@"));
}
function extractError(payload: unknown, text: string): string {
  if (isJsonObject(payload)) {
    const e = payload.error;
    const x = typeof e === "string" ? e : isJsonObject(e) && typeof e.message === "string" ? e.message : typeof payload.message === "string" ? payload.message : "";
    if (x) return truncate(x);
  }
  return text.trim() ? truncate(text.trim()) : "";
}
function httpError(status: number, payload: unknown, text: string): string { const detail = extractError(payload, text); return detail ? `Search failed with HTTP ${status}: ${detail}` : `Search failed with HTTP ${status}`; }
function label(entry: Pick<SearchProviderEntry, "provider" | "id">): string { return entry.id ? `${entry.provider}/${entry.id}` : entry.provider; }

async function providerSearch(config: SearchProviderEntry, request: SearchRequest, signal: AbortSignal, fetchImpl: typeof fetch): Promise<{ details: SearchDetails; items: SearchResultItem[] }> {
  const started = Date.now();
  try {
    const built = buildSearchRequest(config, request);
    const init: RequestInit = { ...built.init, signal };
    if (built.body !== undefined) init.body = JSON.stringify(built.body);
    const response = await fetchImpl(built.url, init);
    let bodyText = "";
    try { bodyText = await response.text(); } catch { signal.throwIfAborted(); }
    let payload: unknown = {};
    if (config.provider === "duckduckgo-html") payload = { html: bodyText };
    else if (bodyText) { try { payload = JSON.parse(bodyText); } catch { payload = {}; } }
    if (!response.ok) throw new Error(httpError(response.status, payload, bodyText));
    const items = normalizeSearchResponse(config.provider, payload).filter((item) => isWebUrl(item.url));
    return { details: { provider: config.provider, ...(config.id && { entryId: config.id }), query: request.query, results: items.slice(0, request.maxResults), durationMs: Date.now() - started, truncated: items.length > request.maxResults }, items };
  } catch (error) {
    signal.throwIfAborted();
    return { details: { provider: config.provider, ...(config.id && { entryId: config.id }), query: request.query, results: [], durationMs: Date.now() - started, truncated: false, error: truncate(error instanceof Error ? error.message : "Search request failed") }, items: [] };
  }
}

function canonicalize(value: string): string | undefined {
  try {
    const url = new URL(value); if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    url.hash = "";
    for (const name of [...url.searchParams.keys()]) if (/^(?:utm_.+|gclid|fbclid|dclid|msclkid|mc_cid|mc_eid)$/i.test(name)) url.searchParams.delete(name);
    return url.href;
  } catch { return undefined; }
}
function nativeLinks(text: string): Set<string> { const set = new Set<string>(); for (const match of text.matchAll(/https?:\/\/[^\s<>"')\]]+/giu)) { const key = canonicalize(match[0].replace(/[.,;:!?]+$/g, "")); if (key) set.add(key); } return set; }
function statusFor(details: SearchDetails): SearchAttempt["status"] { return details.error ? "failure" : details.results.length ? "success" : "empty"; }
function rankItems(groups: Array<{ entry: SearchProviderEntry; items: SearchResultItem[] }>, limit: number, suppressed: Set<string>): { results: SearchResultItem[]; truncated: boolean } {
  type Aggregate = { key: string; variants: Array<{ item: SearchResultItem; position: number; relevance: number; score?: number; source: string }>; sources: Set<string> };
  const map = new Map<string, Aggregate>();
  for (const group of groups) {
    // Collapse canonical variants before assigning positions so duplicates cannot
    // change the provider denominator or weaken later unique results.
    const strongestByPage = new Map<string, { item: SearchResultItem; score?: number; source: string }>();
    for (const item of group.items) {
      const key = canonicalize(item.url);
      if (!key || suppressed.has(key) || strongestByPage.has(key)) continue;
      strongestByPage.set(key, { item, score: item.score, source: label(group.entry) });
    }
    const providerItems = [...strongestByPage.entries()];
    for (const [position, [key, variant]] of providerItems.entries()) {
      const relevance = 1 - position / Math.max(1, providerItems.length);
      const observation = { ...variant, position, relevance };
      const aggregate = map.get(key) ?? { key, variants: [], sources: new Set<string>() };
      aggregate.variants.push(observation);
      aggregate.sources.add(variant.source);
      map.set(key, aggregate);
    }
  }
  const all = [...map.values()];
  const position = (a: Aggregate) => a.variants.reduce((sum, v) => sum + v.relevance, 0) / a.variants.length;
  const score = (a: Aggregate) => { const values = a.variants.map((v) => v.score).filter((v): v is number => typeof v === "number" && Number.isFinite(v)); return values.length === a.variants.length && values.length > 0 ? values.reduce((x, y) => x + y, 0) / values.length : undefined; };
  all.sort((a, b) => { const scoreA = score(a), scoreB = score(b); const scoreTie = scoreA !== undefined && scoreB !== undefined ? scoreB - scoreA : 0; return b.sources.size - a.sources.size || position(b) - position(a) || scoreTie || a.key.localeCompare(b.key); });
  const results = all.map((aggregate) => { const strongest = [...aggregate.variants].sort((a, b) => b.relevance - a.relevance)[0]!.item; const sourceNames = [...aggregate.sources]; return { ...strongest, url: strongest.url, sources: sourceNames, source: sourceNames.join(", ") }; });
  return { results: results.slice(0, limit), truncated: results.length > limit };
}

type NativeRuntime = { activeModel: any; nativeSource?: { isEligible(model: any): boolean; search(input: { query: string; model: any; signal: AbortSignal }): Promise<{ text: string; provider: string; model: string }> }; modelRegistry?: any };
type RaceResult<T> = { value?: T; timedOut: boolean; error?: unknown };
function raceWithTimeout<T>(promise: Promise<T>, ms: number, controller: AbortController): Promise<RaceResult<T>> {
  return new Promise((resolve) => {
    let done = false;
    const cleanup = (): void => { clearTimeout(timer); controller.signal.removeEventListener("abort", onAbort); };
    const onAbort = (): void => { if (!done) clearTimeout(timer); };
    const timer = setTimeout(() => { if (done) return; done = true; cleanup(); controller.abort(new Error("source-timeout")); resolve({ timedOut: true }); }, ms);
    controller.signal.addEventListener("abort", onAbort, { once: true });
    promise.then((value) => { if (done) return; done = true; cleanup(); resolve({ value, timedOut: false }); }, (error) => { if (done) return; done = true; cleanup(); resolve({ timedOut: false, error }); });
  });
}
function childController(parent: AbortSignal): AbortController { const controller = new AbortController(); parent.addEventListener("abort", () => controller.abort(parent.reason), { once: true }); return controller; }

export async function performSearch(config: WebsearchConfig, request: SearchRequest, signal?: AbortSignal, runtime?: NativeRuntime): Promise<SearchDetails> {
  const started = Date.now();
  if (signal?.aborted) throw signal.reason;
  const fetchImpl = transport();
  const aggregateController = new AbortController();
  const onCallerAbort = () => aggregateController.abort(signal!.reason ?? new Error("Search cancelled"));
  signal?.addEventListener("abort", onCallerAbort, { once: true });
  const aggregateDeadlineMs = config.aggregateDeadlineMs ?? 45_000;
  const sourceTimeoutMs = config.sourceTimeoutMs ?? 30_000;
  const attemptsBy = new Map<string, SearchAttempt>();
  const groups: Array<{ entry: SearchProviderEntry; items: SearchResultItem[] }> = [];
  const externalStates = config.providers.filter((entry) => entry.enabled !== false && (entry.provider === "duckduckgo-html" || (entry.provider === "google-cse" ? Boolean(entry.apiKey && entry.searchEngineId) : Boolean(entry.apiKey)))).map((entry) => ({ entry, startedAt: Date.now(), settled: false }));
  const sourceTasks = externalStates.map((state) => (async () => {
    const controller = childController(aggregateController.signal);
    const outcome = await raceWithTimeout(providerSearch(state.entry, request, controller.signal, fetchImpl), sourceTimeoutMs, controller);
    if (state.settled) return;
    state.settled = true;
    if (outcome.timedOut) { attemptsBy.set(label(state.entry), { provider: state.entry.provider, ...(state.entry.id && { entryId: state.entry.id }), durationMs: Date.now() - state.startedAt, resultsCount: 0, status: "timeout", timeoutReason: "source-timeout" }); return; }
    if (outcome.error) {
      attemptsBy.set(label(state.entry), { provider: state.entry.provider, ...(state.entry.id && { entryId: state.entry.id }), durationMs: Date.now() - state.startedAt, resultsCount: 0, status: "failure", error: redact(outcome.error instanceof Error ? outcome.error.message : "Search request failed") });
      return;
    }
    const result = outcome.value!;
    const aggregateTimedOut = result.details.error === AGGREGATE_DEADLINE_REASON;
    attemptsBy.set(label(state.entry), { provider: state.entry.provider, ...(state.entry.id && { entryId: state.entry.id }), durationMs: result.details.durationMs, resultsCount: result.details.results.length, status: aggregateTimedOut ? "timeout" : statusFor(result.details), timeoutReason: aggregateTimedOut ? "aggregate-deadline" : undefined, ...(result.details.error && !aggregateTimedOut && { error: truncate(result.details.error) }) });
    if (!result.details.error) groups.push({ entry: state.entry, items: result.items });
  })());

  let native: NativeDetails = { status: "ineligible" };
  const nativeModel = runtime?.activeModel;
  const nativeState = { settled: false };
  const nativeTask = (async () => {
    if (!nativeModel) return;
    const metadataStarted = Date.now();
    const sourceDeadline = metadataStarted + sourceTimeoutMs;
    // One controller and deadline cover capability acquisition and completion.
    const controller = childController(aggregateController.signal);
    let adapter: NativeAdapter | { search: any } | undefined;
    try {
      const acquiredResult = runtime.nativeSource
        ? { value: runtime.nativeSource.isEligible(nativeModel) ? runtime.nativeSource : undefined, timedOut: false, error: undefined }
        : runtime.modelRegistry ? await raceWithTimeout(acquireNativeSearchAdapter({ model: nativeModel, modelRegistry: runtime.modelRegistry, signal: controller.signal, fetch: fetchImpl }), Math.max(0, sourceDeadline - Date.now()), controller)
        : { value: undefined, timedOut: false, error: undefined };
      if (acquiredResult.timedOut) { if (!nativeState.settled) { nativeState.settled = true; native = { status: "timeout", provider: nativeModel.provider, model: nativeModel.id, durationMs: Date.now() - metadataStarted, timeoutReason: "source-timeout" }; } return; }
      if (acquiredResult.error) throw acquiredResult.error;
      adapter = acquiredResult.value;
      if (!runtime.nativeSource && runtime.modelRegistry && !adapter) { nativeState.settled = true; native = { status: "ineligible", provider: nativeModel.provider, model: nativeModel.id, durationMs: Date.now() - metadataStarted }; return; }
    } catch (error) {
      if (signal?.aborted) return;
      if (!nativeState.settled) native = { status: "failure", provider: nativeModel.provider, model: nativeModel.id, durationMs: Date.now() - metadataStarted, error: redact(error instanceof Error ? error.message : "Native capability acquisition failed") };
      return;
    }
    if (nativeState.settled) return;
    if (!adapter) { nativeState.settled = true; native = { status: "ineligible", provider: nativeModel.provider, model: nativeModel.id, durationMs: Date.now() - metadataStarted }; return; }
    const remaining = sourceDeadline - Date.now();
    if (remaining <= 0) { nativeState.settled = true; native = { status: "timeout", provider: nativeModel.provider, model: nativeModel.id, durationMs: Date.now() - metadataStarted, timeoutReason: "source-timeout" }; controller.abort(new Error("source-timeout")); return; }
    const task = Promise.resolve().then(() => runtime.nativeSource ? runtime.nativeSource.search({ query: request.query, model: nativeModel, signal: controller.signal }) : (adapter as NativeAdapter).search({ query: request.query, model: nativeModel, modelRegistry: runtime.modelRegistry, signal: controller.signal, fetch: fetchImpl }));
    const outcome = await raceWithTimeout(task, remaining, controller);
    if (nativeState.settled) return;
    nativeState.settled = true;
    if (outcome.timedOut) { native = { status: "timeout", provider: nativeModel.provider, model: nativeModel.id, durationMs: Date.now() - metadataStarted, timeoutReason: "source-timeout" }; return; }
    if (outcome.error) { native = { status: "failure", provider: nativeModel.provider, model: nativeModel.id, durationMs: Date.now() - metadataStarted, error: redact(outcome.error instanceof Error ? outcome.error.message : "Native search failed") }; return; }
    const result = outcome.value!;
    native = { status: result.text ? "success" : "empty", provider: result.provider, model: result.model, durationMs: Date.now() - metadataStarted };
    (native as NativeDetails & { text?: string }).text = result.text;
  })();

  let deadlineReached = false;
  let releaseDeadline!: () => void;
  const deadlinePromise = new Promise<void>((resolve) => { releaseDeadline = resolve; });
  const deadline = setTimeout(() => {
    deadlineReached = true;
    aggregateController.abort(new Error(AGGREGATE_DEADLINE_REASON));
    for (const state of externalStates) if (!state.settled) { state.settled = true; attemptsBy.set(label(state.entry), { provider: state.entry.provider, ...(state.entry.id && { entryId: state.entry.id }), durationMs: Date.now() - state.startedAt, resultsCount: 0, status: "timeout", timeoutReason: "aggregate-deadline" }); }
    if (!nativeState.settled && nativeModel) { nativeState.settled = true; native = { status: "timeout", provider: nativeModel.provider, model: nativeModel.id, durationMs: Date.now() - started, timeoutReason: "aggregate-deadline" }; }
    releaseDeadline();
  }, aggregateDeadlineMs);
  let releaseCaller!: (reason: unknown) => void;
  const callerPromise = new Promise<never>((_, reject) => { releaseCaller = reject; });
  const callerListener = () => { aggregateController.abort(signal!.reason ?? new Error("Search cancelled")); releaseCaller(signal!.reason ?? new Error("Search cancelled")); };
  signal?.removeEventListener("abort", onCallerAbort);
  signal?.addEventListener("abort", callerListener, { once: true });
  try {
    await Promise.race([Promise.all([...sourceTasks, nativeTask]), deadlinePromise, callerPromise]);
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener("abort", callerListener);
    signal?.removeEventListener("abort", onCallerAbort);
  }
  if (signal?.aborted) throw signal.reason;
  // Underlying providers are allowed to ignore abort. Their handlers remain attached and cannot alter finalized state.
  if (deadlineReached) for (const state of externalStates) if (!attemptsBy.has(label(state.entry))) attemptsBy.set(label(state.entry), { provider: state.entry.provider, ...(state.entry.id && { entryId: state.entry.id }), durationMs: Date.now() - state.startedAt, resultsCount: 0, status: "timeout", timeoutReason: "aggregate-deadline" });
  const nativeText = (native as NativeDetails & { text?: string }).text;
  const ranked = rankItems(groups, request.maxResults, nativeText ? nativeLinks(nativeText) : new Set<string>());
  const attempts = externalStates.map((state) => attemptsBy.get(label(state.entry))).filter((attempt): attempt is SearchAttempt => Boolean(attempt));
  const successes = groups.length + (native.status === "success" || native.status === "empty" ? 1 : 0);
  const provider = groups[0]?.entry.provider ?? config.providers[0]?.provider ?? "duckduckgo-html";
  const details: SearchDetails = { provider, query: request.query, results: ranked.results, durationMs: Date.now() - started, truncated: ranked.truncated || attempts.some((attempt) => attempt.resultsCount >= request.maxResults && attempt.status === "success"), attempts, native, strategy: config.strategy, migrationWarnings: config.migrationWarnings, aggregateDeadlineMs, sourceTimeoutMs };
  if (nativeText) (details as any).answer = nativeText;
  if (successes === 0) details.error = "Web search failed: all eligible sources failed or timed out. All configured search providers failed.";
  return details;
}
