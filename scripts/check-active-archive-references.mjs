import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ignoredDirectories = new Set([".git", ".mesh", ".agents", ".lpt", ".tmp", "node_modules"]);
const rootConfiguration = new Set([
  ".gitignore",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  "vitest.config.mjs",
]);
const textExtensions = new Set([
  ".cfg",
  ".ini",
  ".js",
  ".json",
  ".mjs",
  ".sh",
  ".toml",
  ".ts",
  ".yaml",
  ".yml",
]);

// Keep the scanner's own source free of the complete forbidden path literal.
const dot = ".";
const agentsDirectory = `${dot}agents`;
const archiveExtension = `${dot}tgz`;
const staleArchiveReference = new RegExp(
  `${escapeRegExp(agentsDirectory)}[/\\\\][^\\s"'<>)]*${escapeRegExp(archiveExtension)}(?:$|[^A-Za-z0-9._-])`,
  "g",
);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&");
}

async function collectFiles(directory, files = []) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return files;
    throw error;
  }

  for (const entry of entries) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(file, files);
      continue;
    }
    if (!entry.isFile()) continue;
    const relative = path.relative(repository, file);
    const isRootConfig = path.dirname(relative) === "." && rootConfiguration.has(entry.name);
    const isPiConfig = relative.startsWith(`.pi${path.sep}`);
    const isScript = relative.startsWith(`scripts${path.sep}`);
    if (isRootConfig || isPiConfig || isScript) files.push(file);
  }
  return files;
}

const files = await collectFiles(repository);
const violations = [];
for (const file of files) {
  if (!textExtensions.has(path.extname(file)) && !rootConfiguration.has(path.basename(file))) continue;
  const content = await readFile(file, "utf8");
  for (const [lineNumber, line] of content.split(/\r?\n/).entries()) {
    staleArchiveReference.lastIndex = 0;
    const match = staleArchiveReference.exec(line);
    if (!match) continue;
    violations.push(`${path.relative(repository, file)}:${lineNumber + 1}: ${match[0]}`);
  }
}

if (violations.length > 0) {
  console.error(`active configuration references forbidden ${agentsDirectory}/**/${archiveExtension}:`);
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log(`active archive reference scan: ${files.length} configuration/script files checked; no ${agentsDirectory}/**/${archiveExtension} references`);
