import { writeFile } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Text, type Component, type TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";

type Document = Component & { pane: string; source: Container; beginFrame(): void; searchEntries(): { text: string; label: string }[] };
type Host = TUI & { layoutRoot: Component };

/** Observes unmodified Stereo through its mounted native components, never changes its code. */
export default function backgroundLinkedProbe(pi: ExtensionAPI): void {
  let tui: Host;
  pi.registerTool({
    name: "search_fixture_nested", label: "Nested search", description: "Launch a search through one more real execution level.",
    parameters: Type.Object({ query: Type.String() }),
    async execute(_id, args, signal, _update, ctx) {
      const outcome = await ctx.executeTool("web_search", { query: args.query, background: true }, { signal });
      if (outcome.isError) throw new Error("Nested search launch failed");
      return outcome.result;
    },
  });
  pi.on("session_start", async (_event, ctx) => {
    let finish = () => {};
    await ctx.ui.custom<void>((host, _theme, _keys, done) => {
      tui = host as Host;
      finish = done;
      return new Text("", 0, 0);
    }, { overlay: true, overlayOptions: { visible: () => false, nonCapturing: true }, onHandle: () => finish() });
  });
  pi.on("agent_before_settle", async () => {
    const documents: Document[] = [];
    const seen = new Set<Component>();
    const visit = (component: Component) => {
      if (seen.has(component)) return;
      seen.add(component);
      if (component.constructor.name === "NativeDocument") { documents.push(component as Document); return; }
      const owner = component as Component & { children?: Component[]; child?: Component };
      for (const child of owner.children ?? []) visit(child);
      if (owner.child) visit(owner.child);
    };
    // Capture an emitted frame, not just a render calculation.
    await new Promise<void>((resolve, reject) => {
      const write = tui.terminal.write;
      const restore = () => { if (tui.terminal.write === observe) tui.terminal.write = write; clearTimeout(timeout); };
      const observe = (data: string) => { write.call(tui.terminal, data); if (data.includes("\x1b[?2026l")) { restore(); resolve(); } };
      const timeout = setTimeout(() => { restore(); reject(new Error("Missing linked-output frame")); }, 5000);
      tui.terminal.write = observe;
      tui.requestRender(true);
    });
    visit(tui.layoutRoot);
    if (documents.length !== 2) throw new Error("Stereo split documents are missing");
    const history = documents[0]!.source.children[2] as Container;
    const original = [...history.children];
    const cards = history.children.filter((child) => (child as Component & { entry?: { customType?: string } }).entry?.customType === "web-search:card");
    for (const card of cards) (card as Component & { setExpanded(expanded: boolean): void }).setExpanded(false);
    const panes: Record<string, string[]> = {}, search: Record<string, { text: string; label: string }[]> = {};
    for (const document of documents) {
      document.beginFrame();
      panes[document.pane] = document.render(180);
      search[document.pane] = document.searchEntries().map(({ text, label }) => ({ text, label }));
    }
    const native = history.render(180);
    for (const card of cards) (card as Component & { setExpanded(expanded: boolean): void }).setExpanded(true);
    const activity = documents.find((document) => document.pane === "activity")!;
    activity.beginFrame();
    const expanded = activity.render(180);
    for (const card of cards) (card as Component & { setExpanded(expanded: boolean): void }).setExpanded(false);
    tui.requestRender(true);
    await writeFile(process.env.PI_WEB_SEARCH_LINKED_CAPTURE!, JSON.stringify({
      panes, search, native, expanded,
      sourceChildrenUnchanged: original.length === history.children.length && original.every((child, index) => child === history.children[index]),
    }));
  });
}
