import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  assistantMessage,
  getProviderSystemPrompt,
  getToolExecution,
  getToolExecutionDetails,
  getToolResultText,
  PiIntegrationTest,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { afterAll, expect, test } from "vitest";

const installedExtension = process.env.PI_WEB_SEARCH_INSTALLED_EXTENSION;
if (!installedExtension) {
  throw new Error("PI_WEB_SEARCH_INSTALLED_EXTENSION must point to the exact installed archive entrypoint");
}
const fixture = path.resolve("test/fixtures/web-search-transport.ts");
const packageRoot = path.dirname(installedExtension);
const root = path.resolve(".agents", "tmp", "pi-web-search-packaged");
const workspaces: string[] = [];

const expectedDescription =
  "Search the public web when workspace search cannot answer a question, such as current documentation, library versions, errors, or news. Pass plain unprefixed text in `query`; do not add a selector. Result count is controlled by the websearch.json configuration. Use returned titles, URLs, and snippets as citation sources. Reading a known URL is a separate task handled by an HTTP URL reader when one is installed.";

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

test("runs the exact installed package in real Pi", async () => {
  const installedPackage = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8")) as {
    name?: string;
    version?: string;
    files?: string[];
    dependencies?: Record<string, unknown>;
    devDependencies?: Record<string, unknown>;
  };
  expect(installedPackage.name).toBe("pi-web-search");
  expect(installedPackage.version).toBe("0.1.8");
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
  expect(packageTools[0]?.description).toBe(expectedDescription);
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
  for (const [id] of calls.slice(0, 5)) {
    expect(getToolExecution(result, id).isError).toBe(true);
  }

  const plain = getToolExecution(result, "plain");
  expect(plain.isError).toBe(false);
  expect(getToolResultText(result, "plain")).toContain("1. Pi Search resolver architecture");
  expect(getToolResultText(result, "plain")).toContain("https://example.com/pi-search-resolvers");
  expect(getToolExecutionDetails(plain)).toMatchObject({
    query: "Pi Search resolver architecture",
    provider: "duckduckgo-html",
    attempts: [
      { provider: "serper", entryId: "empty", resultsCount: 0 },
      { provider: "duckduckgo-html", entryId: "demo", resultsCount: 1 },
    ],
    results: [
      {
        title: "Pi Search resolver architecture",
        url: "https://example.com/pi-search-resolvers",
        snippet: "One Search tool routes text, semantic, web, language, and structural queries.",
      },
    ],
  });

  const prefix = getToolExecution(result, "prefix-text");
  expect(prefix.isError).toBe(false);
  expect(getToolExecutionDetails(prefix)).toMatchObject({ query: "web:Pi Search resolver architecture" });
}, 30_000);
