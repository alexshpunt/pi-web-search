import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";

const manifestPath = process.env.PI_WEB_SEARCH_RELEASE_MANIFEST;
const archivePath = process.env.PI_WEB_SEARCH_RELEASE_VERIFIED_ARCHIVE;

function fail(message) {
  console.error(`pi-web-search release guard: ${message}`);
  process.exit(1);
}

if (!manifestPath || !archivePath) {
  fail("npm publish is blocked; run pnpm run release:verdaccio so the exact archive is verified first");
}

let manifest;
try {
  manifest = JSON.parse(await readFile(manifestPath, "utf8"));
} catch {
  fail(`cannot read verification manifest ${manifestPath}`);
}

if (manifest.verified !== true) fail("verification manifest is not marked verified");
if (path.resolve(manifest.archive) !== path.resolve(archivePath)) {
  fail("verification manifest does not identify the archive being published");
}

let archive;
try {
  archive = await readFile(archivePath);
} catch {
  fail(`verified archive does not exist: ${archivePath}`);
}
const digest = createHash("sha256").update(archive).digest("hex");
if (digest !== manifest.sha256) fail("verified archive hash does not match the verification manifest");

let archivePackage;
try {
  archivePackage = JSON.parse(execFileSync("tar", ["-xOf", archivePath, "package/package.json"], { encoding: "utf8" }));
} catch {
  fail("verified archive does not contain a readable package/package.json");
}
if (archivePackage.name !== "pi-web-search") fail("verified archive has an unexpected package name");
if (archivePackage.version !== manifest.version) fail("verified archive version does not match the verification manifest");

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
if (packageJson.name !== archivePackage.name || packageJson.version !== archivePackage.version) {
  fail("verified archive does not match the package being published");
}

console.log(`pi-web-search release guard: verified ${archivePackage.name}@${archivePackage.version} (${digest})`);
