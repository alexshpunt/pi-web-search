import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const archiveDirectory = path.join(repository, ".lpt", "package-archives", "ale29-qa-final");
const expectedArchive = "pi-web-search-0.1.0.tgz";
const expectedHash = "205b1dbfc7a10c70ed953b1868caed268873126cb35a0cbece13d694431b989a";

const archives = (await readdir(archiveDirectory))
  .filter((name) => /^pi-web-search-\d+\.\d+\.\d+\.tgz$/.test(name))
  .sort();
if (archives.length !== 1 || archives[0] !== expectedArchive) {
  throw new Error(`expected exactly one retained release archive (${expectedArchive}) in ${path.relative(repository, archiveDirectory)}, found: ${archives.join(", ") || "none"}`);
}

const archivePath = path.join(archiveDirectory, expectedArchive);
const archive = await readFile(archivePath);
const actualHash = createHash("sha256").update(archive).digest("hex");
if (actualHash !== expectedHash) {
  throw new Error(`archive hash mismatch for ${expectedArchive}: expected ${expectedHash}, got ${actualHash}`);
}

const packageJson = JSON.parse(execFileSync("tar", ["-xOf", archivePath, "package/package.json"], { encoding: "utf8" }));
if (packageJson.name !== "pi-web-search" || packageJson.version !== "0.1.0") {
  throw new Error(`archive metadata mismatch: expected pi-web-search@0.1.0, got ${packageJson.name ?? "<missing>"}@${packageJson.version ?? "<missing>"}`);
}

const archivedReadme = execFileSync("tar", ["-xOf", archivePath, "package/README.md"]);
const currentReadme = await readFile(path.join(repository, "README.md"));
if (!archivedReadme.equals(currentReadme)) {
  throw new Error(`archive README mismatch for ${expectedArchive}: package/README.md must be byte-identical to current README.md`);
}

console.log(`release artifact check: exactly one retained archive ${expectedArchive} (${actualHash}), ${packageJson.name}@${packageJson.version}; README matches current source`);
