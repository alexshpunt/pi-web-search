import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const guard = path.join(repository, "scripts", "publish-guard.mjs");
const activeArchiveScan = path.join(repository, "scripts", "check-active-archive-references.mjs");
const tempRoot = path.join(repository, ".lpt", "package-archives", "release-workflow-test");

async function archivesUnder(directory: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const nested = await Promise.all(
    entries.map(async (entry) => {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) return archivesUnder(file);
      return entry.isFile() && file.endsWith(".tgz") ? [file] : [];
    }),
  );
  return nested.flat();
}

async function packedArchive(): Promise<string> {
  await rm(tempRoot, { recursive: true, force: true });
  await mkdir(tempRoot, { recursive: true });
  const output = execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", tempRoot], {
    cwd: repository,
    encoding: "utf8",
  });
  return path.join(tempRoot, JSON.parse(output)[0].filename);
}

test("active configuration and scripts contain no .agents archive references", () => {
  const result = spawnSync(process.execPath, [activeArchiveScan], { cwd: repository, encoding: "utf8" });

  expect(result.status).toBe(0);
  const dot = ".";
  expect(result.stdout).toContain(["no", `${dot}agents/**/${dot}tgz`, "references"].join(" "));
});

test("the active scan rejects a stale archive reference", async () => {
  const directory = path.join(repository, ".pi");
  const marker = path.join(directory, "archive-scan-regression.json");
  let directoryExisted = false;
  let previous: string | undefined;
  try {
    try {
      await readdir(directory);
      directoryExisted = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      previous = await readFile(marker, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await mkdir(directory, { recursive: true });
    const dot = ".";
    const staleArchive = ["..", `${dot}agents`, "tmp", `${dot}tgz`].join("/");
    await writeFile(marker, JSON.stringify({ archive: staleArchive }) + "\n", "utf8");

    const result = spawnSync(process.execPath, [activeArchiveScan], { cwd: repository, encoding: "utf8" });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("archive-scan-regression.json");
  } finally {
    if (previous === undefined) {
      await rm(marker, { force: true });
      if (!directoryExisted) await rm(directory, { recursive: true, force: true });
    } else {
      await writeFile(marker, previous, "utf8");
    }
  }
});

test("the guard rejects publishing without exact verification evidence", () => {
  const env = { ...process.env };
  delete env.PI_WEB_SEARCH_RELEASE_MANIFEST;
  delete env.PI_WEB_SEARCH_RELEASE_VERIFIED_ARCHIVE;
  const result = spawnSync(process.execPath, [guard], { cwd: repository, env, encoding: "utf8" });

  expect(result.status).not.toBe(0);
  expect(`${result.stdout}\n${result.stderr}`).toContain("npm publish is blocked");
});

test("the guard accepts the exact archive recorded after verification", async () => {
  const archive = await packedArchive();
  const bytes = await readFile(archive);
  const archivedReadme = execFileSync("tar", ["-xOf", archive, "package/README.md"]);
  expect(archivedReadme.equals(await readFile(path.join(repository, "README.md")))).toBe(true);
  const manifest = path.join(tempRoot, "verification.json");
  await writeFile(
    manifest,
    JSON.stringify({
      verified: true,
      archive,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      name: "pi-web-search",
      version: "0.1.0",
    }),
    "utf8",
  );

  const result = spawnSync(process.execPath, [guard], {
    cwd: repository,
    env: {
      ...process.env,
      PI_WEB_SEARCH_RELEASE_MANIFEST: manifest,
      PI_WEB_SEARCH_RELEASE_VERIFIED_ARCHIVE: archive,
    },
    encoding: "utf8",
  });

  expect(result.status).toBe(0);
  expect(result.stdout).toContain("verified pi-web-search@0.1.0");
  expect(await archivesUnder(path.join(repository, ".agents"))).toEqual([]);
});
