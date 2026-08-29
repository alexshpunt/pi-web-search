import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { formatWebSearchDoctorReport } from "#src/doctor.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("standalone WebSearch doctor", () => {
  it("reports defaults and never exposes credentials", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "pi-web-search-doctor-"));
    const agentDirectory = path.join(cwd, "agent");
    directories.push(cwd);
    const report = await formatWebSearchDoctorReport(
      cwd,
      { SERPER_API_KEY: "secret-key" },
      agentDirectory,
    );
    expect(report).toContain("PASS  Configuration loaded (default:duckduckgo-html)");
    expect(report).toContain("default: credentials available");
    expect(report).not.toContain("secret-key");
  });

  it("reports warnings and failures without leaking config values", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "pi-web-search-doctor-"));
    const agentDirectory = path.join(cwd, "agent");
    directories.push(cwd);
    await mkdir(path.join(cwd, ".pi"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi", "websearch.json"),
      JSON.stringify({ strategy: "priority", fallback: true, providers: [{ provider: "serper" }] }),
      "utf8",
    );
    const warning = await formatWebSearchDoctorReport(cwd, {}, agentDirectory);
    expect(warning).toContain("WARN  Provider serper requires apiKey.");

    await writeFile(path.join(cwd, ".pi", "websearch.json"), "not-json", "utf8");
    const failure = await formatWebSearchDoctorReport(cwd, {}, agentDirectory);
    expect(failure).toContain("FAIL  Invalid JSON object");
  });
});
