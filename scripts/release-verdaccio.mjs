import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(path.join(repository, "package.json"), "utf8"));
const registry = process.env.PI_WEB_SEARCH_RELEASE_REGISTRY ?? "http://localhost:4873";
const userConfig = process.env.PI_WEB_SEARCH_RELEASE_NPMRC ?? path.resolve(repository, "../.local-registry/npmrc");
const registryUrl = new URL(registry);
if (!["localhost", "127.0.0.1"].includes(registryUrl.hostname)) {
  throw new Error(`refusing to publish outside local Verdaccio: ${registry}`);
}

function run(command, args, options = {}) {
  console.log(`$ ${command} ${args.join(" ")}`);
  return execFileSync(command, args, { cwd: repository, stdio: "inherit", ...options });
}

const releaseRoot = path.join(repository, ".agents", "tmp", `release-${packageJson.version}`);
const archiveRoot = path.join(repository, ".lpt", "package-archives", `release-${packageJson.version}`);
const workspace = path.join(releaseRoot, "workspace");
const home = path.join(releaseRoot, "home");
const manifestPath = path.join(releaseRoot, "verification.json");
await rm(releaseRoot, { recursive: true, force: true });
await mkdir(workspace, { recursive: true });
await mkdir(archiveRoot, { recursive: true });

const packJson = execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", archiveRoot], {
  cwd: repository,
  encoding: "utf8",
});
const packed = JSON.parse(packJson);
const archivePath = path.join(archiveRoot, path.basename(packed[0]?.filename ?? ""));
if (!archivePath.endsWith(`${packageJson.name}-${packageJson.version}.tgz`)) {
  throw new Error("npm pack did not produce the expected versioned archive");
}

const archive = await readFile(archivePath);
const sha256 = createHash("sha256").update(archive).digest("hex");

const isolatedEnvironment = {
  ...process.env,
  HOME: home,
  npm_config_registry: registry,
  PI_CODING_AGENT_DIR: path.join(home, ".pi", "agent"),
};
run(path.join(repository, "node_modules", ".bin", "pi"), ["install", "--approve", "-l", archivePath], {
  cwd: workspace,
  env: isolatedEnvironment,
});
run("npm", ["install", "--prefix", path.join(workspace, ".pi", "npm"), "--ignore-scripts", "--no-save", "--package-lock=false", "--omit=peer", "--no-audit", "--no-fund", archivePath], {
  env: isolatedEnvironment,
});

const installedExtension = path.join(workspace, ".pi", "npm", "node_modules", packageJson.name, "index.ts");
const verificationEnvironment = {
  ...process.env,
  PI_WEB_SEARCH_INSTALLED_EXTENSION: installedExtension,
};
run("pnpm", ["run", "verify:package"], { env: verificationEnvironment });

await writeFile(
  manifestPath,
  JSON.stringify(
    {
      verified: true,
      archive: archivePath,
      sha256,
      name: packageJson.name,
      version: packageJson.version,
      installedExtension,
    },
    null,
    2,
  ) + "\n",
  "utf8",
);

const publishArgs = ["publish", archivePath, "--registry", registry, "--access", "public"];
if (existsSync(userConfig)) publishArgs.push("--userconfig", userConfig);
else throw new Error(`Verdaccio npm credentials file not found: ${userConfig}`);
run("npm", publishArgs, {
  env: {
    ...process.env,
    PI_WEB_SEARCH_RELEASE_MANIFEST: manifestPath,
    PI_WEB_SEARCH_RELEASE_VERIFIED_ARCHIVE: archivePath,
  },
});

console.log(`Verified and published ${packageJson.name}@${packageJson.version}`);
console.log(`Archive: ${archivePath}`);
console.log(`Installed entrypoint: ${installedExtension}`);
console.log(`Verification manifest: ${manifestPath}`);
