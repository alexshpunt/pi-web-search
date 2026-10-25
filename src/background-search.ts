import type { BoundaryResult, ExtensionAPI, ExtensionContext, SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import { redactSearchError } from "./search.ts";
import type { SearchDetails } from "./types.ts";

export const BACKGROUND_SEARCH_MESSAGE = "web-search:result";
export const BACKGROUND_SEARCH_CARD = "web-search:card";

/** Full agent-facing completion, independent of the card's collapsed view. */
export interface BackgroundSearchResult {
  requestId: string;
  /** Real visible outer execution, captured from tool events before the launch returns. */
  parentToolCallId?: string;
  query: string;
  status: "completed" | "failed";
  durationMs: number;
  search?: SearchDetails;
  error?: string;
}

/** Serializes all result data once, including answer text and redacted diagnostics. */
export function formatBackgroundSearchResult(result: BackgroundSearchResult): string {
  return `Background web search result:\n${JSON.stringify(result, null, 2)}`;
}

interface SearchJob {
  requestId: string;
  parentToolCallId?: string;
  controller: AbortController;
  done: Promise<void>;
  finish: () => void;
  result?: BackgroundSearchResult;
}
interface DeliveryBoundary {
  entries: SessionBoundaryDraft[];
  outcome: "completed" | "aborted" | "error";
  context: { canContinue: boolean };
}

/** Owns detached searches for one session branch and routes each completion exactly once. */
export class BackgroundSearchRuntime {
  private readonly jobs = new Map<string, SearchJob>();
  private ready: SearchJob[] = [];
  private cards: BackgroundSearchResult[] = [];
  private readonly owners = new Map<string, string | undefined>();
  private waiting = new Set<string>();
  private context?: ExtensionContext;
  private removeAbortListener?: () => void;
  private turnSignal?: AbortSignal;
  private idleDeliveryPending = false;

  constructor(private readonly pi: Pick<ExtensionAPI, "sendMessage" | "appendEntry">) {}

  /** Resolves only observed execution ancestry; an unknown parent remains ownerless. */
  executionStarted(toolCallId: string, parentToolCallId?: string): void {
    this.owners.set(toolCallId, parentToolCallId === undefined ? toolCallId : this.owners.get(parentToolCallId));
  }

  /** Releases active ancestry after launches have copied their visible owner. */
  executionEnded(toolCallId: string): void { this.owners.delete(toolCallId); }

  /** Refreshes the context and observes explicit cancellation without owning the tool-call lifetime. */
  setContext(ctx: ExtensionContext): void {
    this.context = ctx;
    if (this.turnSignal !== ctx.signal) {
      this.removeAbortListener?.();
      this.turnSignal = ctx.signal;
      const signal = ctx.signal;
      const abort = () => this.cancelAll();
      signal?.addEventListener("abort", abort, { once: true });
      this.removeAbortListener = () => signal?.removeEventListener("abort", abort);
    }
  }

  /** Starts a search with its own controller and returns a receipt before it completes. */
  start(requestId: string, query: string, search: (signal: AbortSignal) => Promise<SearchDetails>, ctx: ExtensionContext) {
    ctx.signal?.throwIfAborted();
    this.setContext(ctx);
    if (this.jobs.has(requestId)) throw new Error(`Background search already exists: ${requestId}`);
    let finish!: () => void;
    const job: SearchJob = { requestId, parentToolCallId: this.owners.get(requestId), controller: new AbortController(), done: new Promise((resolve) => { finish = resolve; }), finish: () => finish() };
    this.jobs.set(requestId, job);
    this.updateStatus();
    const started = Date.now();
    void Promise.resolve().then(() => {
      job.controller.signal.throwIfAborted();
      return search(job.controller.signal);
    }).then((details) => this.complete(job, {
      requestId, query, status: details.error ? "failed" : "completed", durationMs: details.durationMs,
      search: {
        ...details,
        ...(details.error && { error: redactSearchError(details.error) }),
        ...(details.attempts && { attempts: details.attempts.map((attempt) => ({ ...attempt, ...(attempt.error && { error: redactSearchError(attempt.error) }) })) }),
        ...(details.native && { native: { ...details.native, ...(details.native.error && { error: redactSearchError(details.native.error) }) } }),
      },
    }), (error: unknown) => this.complete(job, {
      requestId, query, status: "failed", durationMs: Date.now() - started,
      error: redactSearchError(error instanceof Error ? error.message : "Web search failed"),
    }));
    return { requestId, query, status: "running" as const };
  }

  /** Waits for the current outstanding set; reserves those results against automatic delivery. */
  async wait(signal?: AbortSignal): Promise<BackgroundSearchResult[]> {
    signal?.throwIfAborted();
    if (this.waiting.size) throw new Error("Another web search wait is already active");
    const snapshot = [...this.jobs.values()];
    if (!snapshot.length) return [];
    const reserved = new Set(snapshot.map((job) => job.requestId));
    this.waiting = reserved;
    const abort = () => this.cancelAll();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      await Promise.all(snapshot.map((job) => job.done));
      signal?.throwIfAborted();
      if (snapshot.some((job) => job.controller.signal.aborted)) throw new DOMException("Background search wait interrupted", "AbortError");
      const results = this.takeReady((job) => reserved.has(job.requestId));
      this.cards.push(...results);
      return results;
    } finally {
      signal?.removeEventListener("abort", abort);
      if (this.waiting === reserved) this.waiting = new Set();
      this.deliverIdle();
    }
  }

  /** Adds ready messages only after all tool results are safe to commit to session history. */
  deliverBoundary(event: DeliveryBoundary): BoundaryResult | undefined {
    if (event.outcome !== "completed" || this.context?.signal?.aborted) {
      this.cancelAll();
      return;
    }
    const results = event.context.canContinue ? this.takeReady((job) => !this.waiting.has(job.requestId)) : [];
    const cards = [...this.cards, ...results];
    if (!cards.length) return;
    this.cards = [];
    return {
      entries: [...event.entries, ...cards.map((result) => this.card(result)),
        ...results.map((result) => ({ type: "custom_message" as const, ...this.message(result) }))],
      ...(results.length > 0 && { continue: true }),
    };
  }

  /** Wakes a fully idle agent with one result; remaining results use the next atomic boundary. */
  deliverIdle(): void {
    if (this.idleDeliveryPending || !this.context?.isIdle() || this.context.signal) return;
    const job = this.ready.find((job) => !this.waiting.has(job.requestId));
    if (!job) return;
    const [result] = this.takeReady((candidate) => candidate === job);
    if (!result) return;
    this.idleDeliveryPending = true;
    this.pi.appendEntry(BACKGROUND_SEARCH_CARD, result);
    this.pi.sendMessage(this.message(result), { triggerTurn: true });
  }

  /** Clears the idle wake guard when a real new turn or settlement is observed. */
  resume(ctx: ExtensionContext): void {
    this.idleDeliveryPending = false;
    this.setContext(ctx);
  }

  /** Cancels branch work without waking the agent; ownership receipts survive Stop. */
  cancelAll(): void { this.clearJobs(true); }

  private clearJobs(persistCancellation: boolean): void {
    const cancelled = [...this.jobs.values()];
    // Detach first: abort listeners can reenter cancellation, and transports may
    // ignore abort or finish after a different branch reuses the same call ID.
    this.jobs.clear();
    this.ready = [];
    this.cards = [];
    this.waiting = new Set();
    this.idleDeliveryPending = false;
    for (const job of cancelled) {
      job.controller.abort(new DOMException("Background web search cancelled", "AbortError"));
      job.finish();
    }
    this.updateStatus();
    if (persistCancellation) {
      for (const job of cancelled) this.pi.appendEntry("web-search:cancelled", {
        requestId: job.requestId,
        ...(job.parentToolCallId !== undefined && { parentToolCallId: job.parentToolCallId }),
        status: "cancelled",
      });
    }
  }

  /** Disposes session resources on reload/shutdown, or starts fresh in a different branch. */
  reset(ctx?: ExtensionContext): void {
    this.clearJobs(false);
    this.owners.clear();
    this.removeAbortListener?.();
    this.removeAbortListener = undefined;
    this.turnSignal = undefined;
    this.context = undefined;
    if (ctx) this.setContext(ctx);
  }

  /** Number of completed results still awaiting a delivery path. */
  readyCount(): number { return this.ready.length; }

  private complete(job: SearchJob, result: BackgroundSearchResult): void {
    if (this.jobs.get(job.requestId) !== job || job.controller.signal.aborted) return;
    job.result = { ...result, ...(job.parentToolCallId !== undefined && { parentToolCallId: job.parentToolCallId }) };
    this.ready.push(job);
    job.finish();
    this.updateStatus();
    this.deliverIdle();
  }

  private takeReady(matches: (job: SearchJob) => boolean): BackgroundSearchResult[] {
    const selected = this.ready.filter(matches);
    this.ready = this.ready.filter((job) => !selected.includes(job));
    for (const job of selected) this.jobs.delete(job.requestId);
    this.updateStatus();
    return selected.map((job) => job.result!);
  }

  private card(result: BackgroundSearchResult): SessionBoundaryDraft {
    return { type: "custom", customType: BACKGROUND_SEARCH_CARD, data: result };
  }

  private message(result: BackgroundSearchResult) {
    return { customType: BACKGROUND_SEARCH_MESSAGE, content: formatBackgroundSearchResult(result), display: false, details: result };
  }

  private updateStatus(): void {
    const pending = this.jobs.size - this.ready.length;
    this.context?.ui.setStatus("web-search:background", pending ? `Web search: ${pending} running` : undefined);
  }
}
