import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const expectedArchive = "pi-web-search-0.1.8.tgz";
const expectedHash = "7ac95c8a368f72bf6ffdf45455bdb0bfb364b4ef4eaf045f3e8dae57321f4ad6";

const archives = (await readdir(repository))
  .filter((name) => /^pi-web-search-\d+\.\d+\.\d+\.tgz$/.test(name))
  .sort();
if (archives.length !== 1 || archives[0] !== expectedArchive) {
  throw new Error(`expected exactly one retained release archive (${expectedArchive}), found: ${archives.join(", ") || "none"}`);
}

const archivePath = path.join(repository, expectedArchive);
const archive = await readFile(archivePath);
const actualHash = createHash("sha256").update(archive).digest("hex");
if (actualHash !== expectedHash) {
  throw new Error(`archive hash mismatch for ${expectedArchive}: expected ${expectedHash}, got ${actualHash}`);
}

const packageJson = JSON.parse(execFileSync("tar", ["-xOf", archivePath, "package/package.json"], { encoding: "utf8" }));
if (packageJson.name !== "pi-web-search" || packageJson.version !== "0.1.8") {
  throw new Error(`archive metadata mismatch: expected pi-web-search@0.1.8, got ${packageJson.name ?? "<missing>"}@${packageJson.version ?? "<missing>"}`);
}

console.log(`release artifact check: exactly one retained archive ${expectedArchive} (${actualHash}), ${packageJson.name}@${packageJson.version}`);
