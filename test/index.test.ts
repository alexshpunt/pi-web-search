import { describe, expect, it, vi } from "vitest";

import registerWebSearch from "../index.ts";

interface CapturedTool {
  name: string;
  description: string;
  parameters: {
    required?: string[];
    properties?: Record<string, unknown>;
    additionalProperties?: boolean;
  };
}

describe("standalone extension boundary", () => {
  it("registers search, waiting, and the doctor command", async () => {
    const tools: CapturedTool[] = [];
    const commands: string[] = [];
    const pi = {
      on: vi.fn(),
      registerMessageRenderer: vi.fn(),
      registerEntryRenderer: vi.fn(),
      registerTool: (tool: CapturedTool) => tools.push(tool),
      registerCommand: (name: string) => commands.push(name),
    } as unknown as Parameters<typeof registerWebSearch>[0];

    await registerWebSearch(pi);

    expect(tools.map((tool) => tool.name)).toEqual(["web_search", "wait_for_web_searches"]);
    expect(tools[0]?.parameters.required).toEqual(["query"]);
    expect(Object.keys(tools[0]?.parameters.properties ?? {})).toEqual(["query", "limit", "background"]);
    expect(tools[0]?.parameters.properties?.limit).toMatchObject({
      type: "integer",
      minimum: 1,
      maximum: 20,
    });
    expect(tools[0]?.parameters.additionalProperties).toBe(false);
    expect(tools[0]?.description).toEqual(expect.any(String));
    expect(commands).toEqual(["pi-web-search-doctor"]);
  });

  it("adds web-first research guidelines without compatibility fields", async () => {
    const tool = vi.fn();
    const pi = {
      on: vi.fn(),
      registerMessageRenderer: vi.fn(),
      registerEntryRenderer: vi.fn(),
      registerTool: tool,
      registerCommand: vi.fn(),
    } as unknown as Parameters<typeof registerWebSearch>[0];
    await registerWebSearch(pi);
    const definition = tool.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(definition.promptGuidelines).toEqual(expect.arrayContaining([expect.any(String)]));
    expect(definition.prepareArguments).toBeUndefined();
    expect(Object.keys((definition.parameters as { properties: object }).properties)).toEqual([
      "query",
      "limit",
      "background",
    ]);
  });
});
