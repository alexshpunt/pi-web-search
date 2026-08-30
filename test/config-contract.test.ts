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
      ok: true,
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


describe("aggregate configuration contract", () => {
  it("accepts an explicit empty providers array for native-only configuration", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-websearch-native-only-config-"));
    directories.push(root);
    const cwd = path.join(root, "project");
    await mkdir(path.join(cwd, ".pi"), { recursive: true });
    await writeFile(path.join(cwd, ".pi", "websearch.json"), JSON.stringify({ providers: [] }));

    expect(await loadWebsearchConfig({ cwd, agentDirectory: path.join(root, "agent"), env: {} })).toMatchObject({
      ok: true,
      config: { providers: [] },
    });
  });

  it("uses bounded aggregate defaults and warns while ignoring obsolete routing fields", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-websearch-aggregate-config-"));
    directories.push(root);
    const cwd = path.join(root, "project");
    const agent = path.join(root, "agent");
    await mkdir(path.join(cwd, ".pi"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi", "websearch.json"),
      JSON.stringify({
        strategy: "round-robin",
        fallback: false,
        providerOrder: ["second", "first"],
        maxResults: 20,
        sourceTimeoutMs: 12_000,
        aggregateDeadlineMs: 18_000,
        providers: [
          { id: "first", provider: "serper", apiKey: "key", priority: 9 },
          { id: "second", provider: "brave", apiKey: "key", weight: 5 },
        ],
      }),
    );

    const loaded = await loadWebsearchConfig({ cwd, agentDirectory: agent, env: {} });

    expect(loaded).toMatchObject({
      ok: true,
      config: {
        maxResults: 20,
        sourceTimeoutMs: 12_000,
        aggregateDeadlineMs: 18_000,
        providers: [
          { id: "first", provider: "serper" },
          { id: "second", provider: "brave" },
        ],
      },
    });
    expect(JSON.stringify(loaded)).toContain("obsolete");
    expect(JSON.stringify(loaded)).toContain("strategy");
    expect(JSON.stringify(loaded)).toContain("fallback");
    expect(JSON.stringify(loaded)).toContain("providerOrder");
    expect(JSON.stringify(loaded)).toContain("priority");
    expect(JSON.stringify(loaded)).toContain("weight");
  });

  it.each([0, 21, -1, 1.5])("rejects an out-of-range global result limit: %s", (maxResults) => {
    expect(validateWebsearchConfig({
      strategy: "priority",
      fallback: true,
      maxResults,
      providers: [{ provider: "duckduckgo-html" }],
    } as never)).toMatchObject({ ok: false, reason: "invalid_config" });
  });

  it("keeps the zero-configuration aggregate defaults", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "pi-websearch-aggregate-default-"));
    directories.push(cwd);

    expect(await loadWebsearchConfig({ cwd, agentDirectory: path.join(cwd, "agent"), env: {} })).toMatchObject({
      ok: true,
      config: {
        maxResults: 10,
        sourceTimeoutMs: 30_000,
        aggregateDeadlineMs: 45_000,
        providers: [{ provider: "duckduckgo-html" }],
      },
    });
  });

  it("validates every provider endpoint before accepting missing credentials", () => {

    expect(validateWebsearchConfig({
      providers: [
        { provider: "serper" },
        { provider: "brave", apiKey: "key", baseUrl: "http://localhost:9999" },
      ],
    })).toMatchObject({ ok: false, reason: "invalid_config" });
  });

  it("does not discard unsupported or malformed entries beside a missing-credential provider", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-websearch-parse-integrity-"));
    directories.push(root);
    const cwd = path.join(root, "project");
    await mkdir(path.join(cwd, ".pi"), { recursive: true });
    await writeFile(path.join(cwd, ".pi", "websearch.json"), JSON.stringify({
      providers: [
        { provider: "serper" },
        { provider: "not-a-provider", apiKey: "ignored" },
        { provider: "brave", apiKey: "key", baseUrl: "http://localhost:9999" },
        "malformed-entry",
      ],
    }));

    const loaded = await loadWebsearchConfig({ cwd, agentDirectory: path.join(root, "agent"), env: {} });

    expect(loaded).toMatchObject({ ok: false, reason: "invalid_config" });
    expect(loaded).toMatchObject({ message: expect.stringContaining("providers[1].provider is unsupported") });
    expect(loaded).toMatchObject({ message: expect.stringContaining("providers[3] must be an object") });
  });
});
