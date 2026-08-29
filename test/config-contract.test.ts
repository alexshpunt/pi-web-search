import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  loadWebsearchConfig,
  validateProviderConfig,
  validateWebsearchConfig,
} from "#src/config.ts";
import { isAllowedProviderBaseUrl } from "#src/providers/endpoints.ts";
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("configuration validation and compatibility", () => {
  it("keeps default routing and rejects invalid provider configuration", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "pi-websearch-default-"));
    directories.push(cwd);
    const loaded = await loadWebsearchConfig({ cwd, agentDirectory: path.join(cwd, "agent"), env: {} });
    expect(loaded).toMatchObject({
      ok: true,
      config: { strategy: "priority", fallback: true, providers: [{ provider: "duckduckgo-html", maxResults: 10 }] },
    });
    expect(validateWebsearchConfig({ strategy: "unknown" as never, fallback: true, providers: [] })).toMatchObject({
      ok: false,
      reason: "invalid_config",
    });
    expect(validateProviderConfig({ provider: "serper", apiKey: "key", baseUrl: "http://localhost:9999" })).toMatchObject({
      ok: false,
      reason: "invalid_config",
    });
    expect(validateProviderConfig({ provider: "serper" })).toMatchObject({
      ok: false,
      reason: "missing_api_key",
    });
  });

  it("accepts only public HTTPS custom endpoints", () => {
    expect(isAllowedProviderBaseUrl("https://search.example.com/api")).toBe(true);
    expect(isAllowedProviderBaseUrl("http://search.example.com/api")).toBe(false);
    expect(isAllowedProviderBaseUrl("https://user:pass@search.example.com/api")).toBe(false);
    expect(isAllowedProviderBaseUrl("https://127.0.0.1/api")).toBe(false);
    expect(isAllowedProviderBaseUrl("https://10.0.0.1/api")).toBe(false);
  });

  it("resolves standard and legacy credential names without changing provider config", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-websearch-credentials-"));
    directories.push(root);
    const cwd = path.join(root, "project");
    const agent = path.join(root, "agent");
    await mkdir(path.join(cwd, ".pi"), { recursive: true });
    await mkdir(agent, { recursive: true });
    await writeFile(
      path.join(cwd, ".pi", "websearch.json"),
      JSON.stringify({ provider: "brave", apiKey: "project", maxResults: 4 }),
    );
    const legacy = await loadWebsearchConfig({
      cwd,
      agentDirectory: agent,
      env: { PI_AGENT_IDE_SEARCH_BRAVE_API_KEY: "legacy-secret" },
    });
    expect(legacy).toMatchObject({ ok: true, config: { providers: [{ provider: "brave", apiKey: "legacy-secret", maxResults: 4 }] } });
    const standard = await loadWebsearchConfig({
      cwd,
      agentDirectory: agent,
      env: { BRAVE_SEARCH_API_KEY: "standard-secret" },
    });
    expect(standard).toMatchObject({ ok: true, config: { providers: [{ provider: "brave", apiKey: "standard-secret", maxResults: 4 }] } });
  });

  it("preserves precedence across project, global, and built-in layers", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-websearch-precedence-"));
    directories.push(root);
    const cwd = path.join(root, "project");
    const agent = path.join(root, "agent");
    await mkdir(path.join(cwd, ".pi"), { recursive: true });
    await mkdir(agent, { recursive: true });
    await writeFile(path.join(agent, "websearch.json"), JSON.stringify({ provider: "serper", apiKey: "global", maxResults: 9 }));
    await writeFile(path.join(cwd, ".pi", "websearch.json"), JSON.stringify({ provider: "serper", apiKey: "project", maxResults: 2 }));
    expect(await loadWebsearchConfig({ cwd, agentDirectory: agent, env: {} })).toMatchObject({ ok: true, config: { providers: [{ apiKey: "global", maxResults: 2 }] } });
    await rm(path.join(cwd, ".pi", "websearch.json"));
    expect(await loadWebsearchConfig({ cwd, agentDirectory: agent, env: {} })).toMatchObject({ ok: true, config: { providers: [{ apiKey: "global", maxResults: 9 }] } });
    await rm(path.join(agent, "websearch.json"));
    expect(await loadWebsearchConfig({ cwd, agentDirectory: agent, env: {} })).toMatchObject({ ok: true, config: { providers: [{ provider: "duckduckgo-html", maxResults: 10 }] } });
  });
});
