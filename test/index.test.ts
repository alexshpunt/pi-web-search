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
  it("registers only web_search and the doctor command", async () => {
    const tools: CapturedTool[] = [];
    const commands: string[] = [];
    const pi = {
      registerTool: (tool: CapturedTool) => tools.push(tool),
      registerCommand: (name: string) => commands.push(name),
    } as unknown as Parameters<typeof registerWebSearch>[0];

    await registerWebSearch(pi);

    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe("web_search");
    expect(tools[0]?.parameters.required).toEqual(["query"]);
    expect(Object.keys(tools[0]?.parameters.properties ?? {})).toEqual(["query", "limit"]);
    expect(tools[0]?.parameters.properties?.limit).toMatchObject({
      type: "integer",
      minimum: 1,
      maximum: 20,
    });
    expect(tools[0]?.parameters.additionalProperties).toBe(false);
    expect(tools[0]?.description).toContain("plain unprefixed");
    expect(tools[0]?.description).toContain("configuration");
    expect(tools[0]?.description).toContain("citation");
    expect(tools[0]?.description).toContain("known URL");
    expect(commands).toEqual(["pi-web-search-doctor"]);
  });

  it("does not add prompt guidelines or compatibility fields", async () => {
    const tool = vi.fn();
    const pi = {
      registerTool: tool,
      registerCommand: vi.fn(),
    } as unknown as Parameters<typeof registerWebSearch>[0];
    await registerWebSearch(pi);
    const definition = tool.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(definition.promptGuidelines).toBeUndefined();
    expect(definition.prepareArguments).toBeUndefined();
    expect(Object.keys((definition.parameters as { properties: object }).properties)).toEqual([
      "query",
      "limit",
    ]);
  });
});
