import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  assistantMessage,
  getProviderSystemPrompt,
  getToolExecution,
  getToolExecutionDetails,
  getToolExecutions,
  getToolResultText,
  PiIntegrationTest,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { afterAll, expect, test } from "vitest";

const installedExtension = process.env.PI_WEB_SEARCH_INSTALLED_EXTENSION;
const localPiCommand = path.resolve("node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
if (!installedExtension) {
  throw new Error("PI_WEB_SEARCH_INSTALLED_EXTENSION must point to the exact installed archive entrypoint");
}
const fixture = path.resolve("test/fixtures/web-search-transport.ts");
const packageRoot = path.dirname(installedExtension);
const root = path.resolve(".agents", "tmp", "pi-web-search-packaged");
const workspaces: string[] = [];

type TransportReport = {
  staticResolverCalls: number;
  started: string[];
  aborted: string[];
  activeModels: Array<{ provider: string; api: string; id: string }>;
  metadataCalls: number;
  externalCalls: number;
  nativeCompletionCalls: number;
  completionUsedTransport: boolean;
};

type SurfaceReport = {

  tools: Array<{
    name: string;
    description: string;
    promptGuidelines?: readonly string[];
    sourceInfo: { path: string; source: string; scope: string; origin: string };
  }>;
  commands: Array<{ name: string; sourceInfo: { path: string } }>;
};

async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const name = path.join(directory, entry.name);
      return entry.isDirectory() ? filesUnder(name) : [name];
    }),
  );
  return nested.flat();
}

afterAll(async () => {
  await Promise.all(workspaces.map((directory) => rm(directory, { recursive: true, force: true })));
  // Keep the surface report under .agents/tmp for reviewer inspection.
});


test("the exact installed archive has the approved package version", async () => {
  const installedPackage = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8")) as {
    name?: string;
    version?: string;
  };
  expect(installedPackage.name).toBe("pi-web-search");
  expect(installedPackage.version).toBe("0.1.0");
});

test("runs the exact installed package in real Pi", async () => {
  const installedPackage = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8")) as {
    name?: string;
    version?: string;
    files?: string[];
    dependencies?: Record<string, unknown>;
    devDependencies?: Record<string, unknown>;
  };
  expect(installedPackage.name).toBe("pi-web-search");
  expect(path.basename(packageRoot)).toBe("pi-web-search");
  expect(path.normalize(packageRoot)).toContain(path.join(".pi", "npm", "node_modules", "pi-web-search"));
  expect(installedExtension).toBe(path.join(packageRoot, "index.ts"));
  expect(installedExtension).not.toContain("/root/dev/pi/pi-web-search/index.ts");

  const installedFiles = await filesUnder(packageRoot);
  expect(installedFiles.some((file) => file.includes("test") || file.includes("fixture"))).toBe(false);
  expect(installedFiles.some((file) => path.basename(file).toLowerCase().startsWith("skill"))).toBe(false);
  for (const file of installedFiles) {
    const content = await readFile(file, "utf8");
    expect(content).not.toContain("/root/dev/pi/pi-web-search");
    expect(content).not.toContain("/root/.herdr");
  }
  expect(installedPackage.dependencies ?? {}).toEqual({});
  expect(Object.values(installedPackage.devDependencies ?? {}).some((value) => String(value).startsWith("workspace:"))).toBe(false);
  expect(installedPackage.devDependencies ?? {}).not.toHaveProperty("pi-agent-search");

  await mkdir(root, { recursive: true });
  const surfaceReportPath = path.join(root, "surface-report.json");
  const cwd = await mkdtemp(path.join(root, "workspace-"));
  workspaces.push(cwd);
  await mkdir(path.join(cwd, ".pi"), { recursive: true });
  await writeFile(
    path.join(cwd, ".pi", "websearch.json"),
    JSON.stringify({
      strategy: "priority",
      fallback: true,
      providers: [
        { id: "empty", provider: "serper", apiKey: "demo", maxResults: 3 },
        { id: "demo", provider: "duckduckgo-html", maxResults: 3 },
      ],
    }),
    "utf8",
  );

  const calls = [
    ["missing", {}],
    ["empty", { query: "" }],
    ["non-string", { query: 42 }],
    ["extra", { query: "query", extra: true }],
    ["limit", { query: "query", limit: 1 }],
    ["plain", { query: "Pi Search resolver architecture" }],
    ["prefix-text", { query: "web:Pi Search resolver architecture" }],
  ] as const;
  const result = await new PiIntegrationTest({
    piCommand: localPiCommand,
    testName: "installed-web-search",
    cwd,
    extensions: [fixture, installedExtension],
    environment: {
      PI_CODING_AGENT_DIR: path.join(cwd, ".pi", "agent"),
      PI_WEB_SEARCH_SURFACE_REPORT: surfaceReportPath,
    },
    isolateUserResources: true,
    conversation: [
      assistantMessage(
        calls.map(([id, arguments_]) => toolCall({ id, name: "web_search", arguments: arguments_ })),
        { stopReason: "toolUse" },
      ),
      assistantMessage([text("Search completed")]),
    ],
  }).run("Search the public web");

  const surfaces = JSON.parse(await readFile(surfaceReportPath, "utf8")) as SurfaceReport;
  const packageTools = surfaces.tools.filter((tool) => path.resolve(tool.sourceInfo.path) === path.resolve(installedExtension));
  expect(packageTools.map((tool) => tool.name)).toEqual(["web_search"]);
  expect(packageTools[0]?.description).toContain("plain unprefixed");
  expect(packageTools[0]?.description).toContain("eligible");
  expect(packageTools[0]?.description).toContain("limit");
  expect(packageTools[0]?.promptGuidelines).toBeUndefined();
  const packageCommands = surfaces.commands.filter((command) => path.resolve(command.sourceInfo.path) === path.resolve(installedExtension));
  expect(packageCommands.map((command) => command.name)).toEqual(["pi-web-search-doctor"]);

  const providerPrompt = getProviderSystemPrompt(result);
  const availableTools = providerPrompt.split("Available tools:\n", 2)[1]?.split("\n\nIn addition", 2)[0]?.split("\n") ?? [];
  expect(availableTools).toEqual([
    "- read: Read file contents",
    "- bash: Execute bash commands (ls, grep, find, etc.)",
    "- edit: Make precise file edits with exact text replacement, including multiple disjoint edits in one call",
    "- write: Create or overwrite files",
    "- web_search: Search the public web with a plain query and return citable results",
  ]);
  expect(providerPrompt).not.toContain("Use `web:<query>`");

  const executions = calls.map(([id]) => getToolExecution(result, id));
  expect(new Set(executions.map((execution) => execution.toolName))).toEqual(new Set(["web_search"]));
  for (const [id] of calls.slice(0, 4)) {
    expect(getToolExecution(result, id).isError).toBe(true);
  }

  const limited = getToolExecution(result, "limit");
  expect(limited.isError).toBe(false);
  expect((getToolExecutionDetails(limited) as { results?: unknown[] }).results).toHaveLength(1);

  const plain = getToolExecution(result, "plain");
  expect(plain.isError).toBe(false);
  const plainText = getToolResultText(result, "plain");
  expect(plainText).not.toContain("Native model evidence");
  expect(plainText).toContain("Pi Search resolver architecture");
  expect(plainText).toContain("External-only result");
  expect(getToolExecutionDetails(plain)).toMatchObject({
    query: "Pi Search resolver architecture",
    native: { status: "ineligible" },
    attempts: [
      { provider: "serper", entryId: "empty", resultsCount: 1 },
      { provider: "duckduckgo-html", entryId: "demo", resultsCount: 2 },
    ],
    results: [
      {
        title: "Pi Search resolver architecture",
        sources: ["serper/empty", "duckduckgo-html/demo"],
      },
      {
        title: "External-only result",
        url: "https://example.com/external-only",
        sources: ["duckduckgo-html/demo"],
      },
    ],
  });
  expect(JSON.stringify(getToolExecutionDetails(plain))).toContain("obsolete");

  const prefix = getToolExecution(result, "prefix-text");
  expect(prefix.isError).toBe(false);
  expect(getToolExecutionDetails(prefix)).toMatchObject({ query: "web:Pi Search resolver architecture" });
}, 30_000);


test("the exact installed package runs native OpenRouter acquisition and aggregation through real Pi", async () => {
  await mkdir(root, { recursive: true });
  const cwd = await mkdtemp(path.join(root, "native-workspace-"));
  workspaces.push(cwd);
  await mkdir(path.join(cwd, ".pi"), { recursive: true });
  await writeFile(path.join(cwd, ".pi", "websearch.json"), JSON.stringify({
    providers: [
      { id: "empty", provider: "serper", apiKey: "demo", maxResults: 3 },
      { id: "demo", provider: "duckduckgo-html", maxResults: 3 },
    ],
  }), "utf8");
  const transportReportPath = path.join(cwd, "native-transport-report.json");

  const result = await new PiIntegrationTest({
    piCommand: localPiCommand,
    testName: "installed-active-model-native-web-search",
    cwd,
    extensions: [fixture, installedExtension],
    providerMode: "user",
    model: "openrouter/openai/gpt-5.6",
    tools: ["web_search"],
    environment: {
      PI_CODING_AGENT_DIR: path.join(cwd, ".pi", "agent"),
      PI_WEB_SEARCH_FIXTURE_MODE: "native",
      PI_WEB_SEARCH_TRANSPORT_REPORT: transportReportPath,
    },
    isolateUserResources: true,
    rawMode: true,
  }).run("Search the public web");

  const execution = getToolExecution(result, "native-first");
  const output = getToolResultText(result, "native-first");
  const report = JSON.parse(await readFile(transportReportPath, "utf8")) as TransportReport;
  expect(result.state?.model).toEqual({ provider: "openrouter", id: "openai/gpt-5.6" });
  expect(report.staticResolverCalls).toBe(0);
  expect(report.metadataCalls).toBe(1);
  expect(report.externalCalls).toBe(2);
  expect(report.nativeCompletionCalls).toBe(1);
  expect(report.completionUsedTransport).toBe(true);
  expect(report.activeModels).toContainEqual({
    provider: "openrouter",
    api: "openai-completions",
    id: "openai/gpt-5.6",
  });
  expect(execution.isError).toBe(false);
  expect(output).toContain("Native model evidence");
  expect(output.indexOf("Native model evidence")).toBeLessThan(output.indexOf("External-only result"));
  expect(output).not.toContain("Weaker duplicate title");
  expect(output).toContain("External-only result");
  expect(getToolExecutionDetails(execution)).toMatchObject({
    native: { status: "success", provider: "openrouter", model: "openai/gpt-5.6" },
  });
}, 30_000);


test("cancels every acquired source and ignores the legacy native resolver in the exact installed package", async () => {
  await mkdir(root, { recursive: true });
  const cwd = await mkdtemp(path.join(root, "cancellation-workspace-"));
  workspaces.push(cwd);
  await mkdir(path.join(cwd, ".pi"), { recursive: true });
  await writeFile(path.join(cwd, ".pi", "websearch.json"), JSON.stringify({
    sourceTimeoutMs: 30_000,
    aggregateDeadlineMs: 45_000,
    providers: [
      { id: "serper-pending", provider: "serper", apiKey: "demo" },
      { id: "brave-pending", provider: "brave", apiKey: "demo" },
    ],
  }), "utf8");
  const transportReportPath = path.join(cwd, "cancellation-transport-report.json");

  const result = await new PiIntegrationTest({
    piCommand: localPiCommand,
    testName: "installed-cancel-all-search-sources",
    cwd,
    extensions: [fixture, installedExtension],
    model: "scripted/scripted-model",
    environment: {
      PI_CODING_AGENT_DIR: path.join(cwd, ".pi", "agent"),
      PI_WEB_SEARCH_FIXTURE_MODE: "cancel",
      PI_WEB_SEARCH_TRANSPORT_REPORT: transportReportPath,
    },
    isolateUserResources: true,
    timeoutMs: 8_000,
    conversation: [
      assistantMessage([
        toolCall({ id: "cancelled-search", name: "web_search", arguments: { query: "never finish" } }),
      ], { stopReason: "toolUse" }),
    ],
  }).run("Start and then cancel web search");

  const report = JSON.parse(await readFile(transportReportPath, "utf8")) as TransportReport;
  expect(report.staticResolverCalls).toBe(0);
  expect(report.started).toEqual(["brave", "serper"]);
  expect(report.aborted).toEqual(["brave", "serper"]);
  const cancelled = getToolExecution(result, "cancelled-search");
  expect(cancelled.isError).toBe(true);
  expect(getToolResultText(result, "cancelled-search")).toMatch(/abort|cancel/i);
  expect(getToolExecutionDetails(cancelled)).not.toMatchObject({ results: expect.any(Array) });
  expect(getToolExecutions(result).filter((execution) => execution.toolCallId === "cancelled-search")).toHaveLength(1);
}, 10_000);
