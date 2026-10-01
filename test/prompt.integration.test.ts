import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";

import {
  assistantMessage,
  getProviderSystemPrompt,
  PiIntegrationTest,
  testArtifactsDir,
  text,
} from "pi-coding-agent-test";
import { expect, test } from "vitest";

test("sends web-first research rules to the model through real Pi", async () => {
  const root = path.resolve(".tmp");
  await mkdir(root, { recursive: true });
  const cwd = await mkdtemp(path.join(root, "web-search-prompt-"));
  try {
    const result = await new PiIntegrationTest({
      piCommand: path.resolve("node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
      testName: "web-search-prompt",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      extensions: [path.resolve("index.ts")],
      tools: ["web_search"],
      isolateUserResources: true,
      conversation: [assistantMessage([text("Ready")])],
    }).run("Check the available research instructions");

    const prompt = getProviderSystemPrompt(result);
    expect(prompt).toContain("- web_search: Search the public web for information on any topic.");
    expect(prompt).toContain("Use web_search when the user mentions an external dependency, package, extension, product, service, or other external reference to find what they mean and get current information.");
    expect(prompt).toContain("Use web_search to verify external facts and find up-to-date information instead of relying on memory.");
    expect(prompt).toContain("When missing factual information can be found online, search with web_search before asking the user to clarify. Ask only if the search does not resolve the uncertainty or the question is about the user's intent or preferences.");
    expect(prompt).not.toContain("native model search returns");
    expect(result.exitCode).toBe(0);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 30_000);
