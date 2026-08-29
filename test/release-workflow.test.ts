import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const guard = path.join(repository, "scripts", "publish-guard.mjs");
const tempRoot = path.join(repository, ".agents", "tmp", "release-workflow-test");

async function packedArchive(): Promise<string> {
  await rm(tempRoot, { recursive: true, force: true });
  await mkdir(tempRoot, { recursive: true });
  const output = execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", tempRoot], {
    cwd: repository,
    encoding: "utf8",
  });
  return path.join(tempRoot, JSON.parse(output)[0].filename);
}

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
  const manifest = path.join(tempRoot, "verification.json");
  await writeFile(
    manifest,
    JSON.stringify({
      verified: true,
      archive,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      name: "pi-web-search",
      version: "0.1.8",
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
  expect(result.stdout).toContain("verified pi-web-search@0.1.8");
});
