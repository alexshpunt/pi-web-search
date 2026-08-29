import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";

import { loadWebsearchConfig } from "#src/config.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("web search config", () => {
  it("loads project config, then Pi config, then the free default", async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "pi-websearch-config-"));
    temporaryDirectories.push(temporaryDirectory);

    const cwd = path.join(temporaryDirectory, "project");
    const piRoot = path.join(temporaryDirectory, "pi");
    const projectConfigPath = path.join(cwd, CONFIG_DIR_NAME, "websearch.json");
    const globalConfigPath = path.join(piRoot, "websearch.json");
    await Promise.all([
      mkdir(path.dirname(projectConfigPath), { recursive: true }),
      mkdir(piRoot, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(projectConfigPath, JSON.stringify({ provider: "duckduckgo-html" })),
      writeFile(globalConfigPath, JSON.stringify({ provider: "brave", apiKey: "global-key" })),
    ]);

    const projectConfig = await loadWebsearchConfig({ cwd, agentDirectory: piRoot });
    expect(projectConfig).toMatchObject({
      ok: true,
      source: projectConfigPath,
      config: { providers: [{ provider: "duckduckgo-html" }] },
    });

    await unlink(projectConfigPath);
    const globalConfig = await loadWebsearchConfig({ cwd, agentDirectory: piRoot });
    expect(globalConfig).toMatchObject({
      ok: true,
      source: globalConfigPath,
      config: { providers: [{ provider: "brave", apiKey: "global-key" }] },
    });

    await unlink(globalConfigPath);
    const defaultConfig = await loadWebsearchConfig({ cwd, agentDirectory: piRoot });
    expect(defaultConfig).toMatchObject({
      ok: true,
      source: "default:duckduckgo-html",
      config: { providers: [{ provider: "duckduckgo-html" }] },
    });
  });

  it("uses environment, global, then local credentials without replacing local routing", async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "pi-websearch-layered-"));
    temporaryDirectories.push(temporaryDirectory);
    const cwd = path.join(temporaryDirectory, "project");
    const agentDirectory = path.join(temporaryDirectory, "agent");
    await mkdir(path.join(cwd, CONFIG_DIR_NAME), { recursive: true });
    await mkdir(agentDirectory, { recursive: true });
    await writeFile(
      path.join(cwd, CONFIG_DIR_NAME, "websearch.json"),
      JSON.stringify({ provider: "exa", apiKey: "local-secret", maxResults: 3 }),
    );
    await writeFile(
      path.join(agentDirectory, "websearch.json"),
      JSON.stringify({ provider: "exa", apiKey: "global-secret", maxResults: 9 }),
    );

    const fromEnvironment = await loadWebsearchConfig({
      cwd,
      agentDirectory,
      env: { EXA_API_KEY: "environment-secret" },
    });
    expect(fromEnvironment).toMatchObject({
      ok: true,
      config: { providers: [{ apiKey: "environment-secret", maxResults: 3 }] },
    });

    const fromGlobal = await loadWebsearchConfig({ cwd, agentDirectory, env: {} });
    expect(fromGlobal).toMatchObject({
      ok: true,
      config: { providers: [{ apiKey: "global-secret", maxResults: 3 }] },
    });
  });
});
