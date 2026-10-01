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
    expect(tools[0]?.description).toBe("Search the public web for information on any topic.");
    expect(commands).toEqual(["pi-web-search-doctor"]);
  });

  it("adds web-first research guidelines without compatibility fields", async () => {
    const tool = vi.fn();
    const pi = {
      registerTool: tool,
      registerCommand: vi.fn(),
    } as unknown as Parameters<typeof registerWebSearch>[0];
    await registerWebSearch(pi);
    const definition = tool.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(definition.promptGuidelines).toEqual([
      "Use web_search when the user mentions an external dependency, package, extension, product, service, or other external reference to find what they mean and get current information.",
      "Use web_search to verify external facts and find up-to-date information instead of relying on memory.",
      "When missing factual information can be found online, search with web_search before asking the user to clarify. Ask only if the search does not resolve the uncertainty or the question is about the user's intent or preferences.",
    ]);
    expect(definition.prepareArguments).toBeUndefined();
    expect(Object.keys((definition.parameters as { properties: object }).properties)).toEqual([
      "query",
      "limit",
    ]);
  });
});
