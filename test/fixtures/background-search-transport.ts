import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const transportKey = Symbol.for("pi-web-search.runtime-transport");

/** Controls real search HTTP completion without replacing the search tool or Pi loop. */
export default function backgroundSearchTransport(pi: ExtensionAPI): void {
  const previous = (globalThis as Record<symbol, unknown>)[transportKey];
  const pending = new Map<string, (response: Response) => void>();
  const reportFile = process.env.PI_WEB_SEARCH_BACKGROUND_REPORT;
  const report = reportFile && existsSync(reportFile)
    ? JSON.parse(readFileSync(reportFile, "utf8")) as { started: string[]; completed: string[]; aborted: string[]; work: boolean }
    : { started: [] as string[], completed: [] as string[], aborted: [] as string[], work: false };
  const persist = () => {
    if (process.env.PI_WEB_SEARCH_BACKGROUND_REPORT) writeFileSync(process.env.PI_WEB_SEARCH_BACKGROUND_REPORT, JSON.stringify(report));
  };
  const release = (query: string, fail = false) => {
    const resolve = pending.get(query);
    if (!resolve) throw new Error(`Search did not start: ${query}`);
    pending.delete(query);
    report.completed.push(query);
    persist();
    const html = `<a class="result__a" href="https://example.com/${query}">${query} result</a><a class="result__snippet">${"Full evidence. ".repeat(100)}${query.toUpperCase()}_TAIL_MARKER</a>`;
    resolve(fail
      ? new Response("Bearer secret-token apiKey=private-key", { status: 401 })
      : new Response(html, { headers: { "content-type": "text/html" } }));
  };
  (globalThis as Record<symbol, unknown>)[transportKey] = (input: string | URL, init?: RequestInit) => {
    const query = new URL(String(input)).searchParams.get("q")!;
    report.started.push(query);
    persist();
    return new Promise<Response>((resolve, reject) => {
      pending.set(query, resolve);
      init?.signal?.addEventListener("abort", () => {
        pending.delete(query);
        report.aborted.push(query);
        persist();
        reject(init.signal?.reason);
      }, { once: true });
    });
  };
  pi.registerTool({
    name: "search_fixture_control", label: "Search fixture", description: "Control deterministic search completions.",
    parameters: Type.Object({ action: Type.String(), query: Type.Optional(Type.String()) }),
    async execute(_id, args, _signal, _onUpdate, ctx) {
      if (args.action === "release") release(args.query!);
      if (args.action === "fail") release(args.query!, true);
      if (args.action === "work") {
        if (report.started.length !== 2 || report.completed.length) throw new Error("Search launches blocked unrelated work");
        report.work = true;
        persist();
      }
      if (args.action === "stop") ctx.abort();
      await delay(20);
      return { content: [{ type: "text", text: `Fixture: ${args.action}` }], details: { ...report } };
    },
  });
  let changeSession: (() => Promise<void>) | undefined;
  pi.registerCommand("search-fixture-switch", {
    description: "Replace the test session or navigate its real tree.",
    handler: async (_args, ctx) => {
      changeSession = async () => {
        if (process.env.PI_WEB_SEARCH_BACKGROUND_MODE === "reload") {
          await ctx.reload();
          return;
        }
        if (process.env.PI_WEB_SEARCH_BACKGROUND_MODE === "tree") {
          const user = ctx.sessionManager.getBranch().find((entry) => entry.type === "message" && entry.message.role === "user");
          if (!user) throw new Error("Missing original user entry");
          await ctx.navigateTree(user.id, { summarize: false });
          pi.sendUserMessage("Check the new branch without old background searches");
        } else {
          await ctx.newSession({ withSession: async (fresh) => {
            await fresh.sendUserMessage("Check the new session without old background searches");
          } });
        }
      };
      pi.sendUserMessage("Run independent background searches before changing history");
    },
  });
  pi.on("session_start", (event, ctx) => {
    ctx.ui.setToolsExpanded(false);
    if (event.reason === "reload" && process.env.PI_WEB_SEARCH_BACKGROUND_MODE === "reload") {
      pi.sendUserMessage("Check the reloaded runtime without old background searches");
    }
  });
  let idleReleased = false;
  pi.on("agent_settled", () => {
    if (changeSession) {
      const change = changeSession;
      changeSession = undefined;
      setTimeout(() => { void change(); }, 20);
    }
    if (process.env.PI_WEB_SEARCH_BACKGROUND_MODE === "idle" && !idleReleased) {
      idleReleased = true;
      setTimeout(() => release("fast"), 20);
    }
  });
  pi.on("tool_execution_start", (event) => {
    if (event.toolName === "wait_for_web_searches" && process.env.PI_WEB_SEARCH_BACKGROUND_MODE === "wait" && pending.size) {
      release("fast");
      setTimeout(() => release("slow"), 30);
    }
  });
  persist();
  pi.on("session_shutdown", () => {
    (globalThis as Record<symbol, unknown>)[transportKey] = previous;
  });
}
