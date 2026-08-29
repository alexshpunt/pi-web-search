import { loadWebsearchConfig } from "./config.ts";

/**
 * Runs the standalone WebSearch readiness check and returns a redacted report.
 * Provider keys are only checked for presence and never included in the report.
 */
export async function formatWebSearchDoctorReport(
  cwd: string,
  environment: NodeJS.ProcessEnv = process.env,
  agentDirectory?: string,
): Promise<string> {
  const loaded = await loadWebsearchConfig({ cwd, env: environment, agentDirectory });
  const lines = ["Pi WebSearch doctor", "", `Project: ${cwd}`, ""];

  if (!loaded.ok) {
    lines.push(`${loaded.reason === "missing_api_key" ? "WARN" : "FAIL"}  ${loaded.message}`);
    if (loaded.source !== undefined) lines.push(`      Config: ${loaded.source}`);
    return lines.join("\n");
  }

  lines.push(`PASS  Configuration loaded (${loaded.source})`);
  for (const provider of loaded.config.providers) {
    const isFree = provider.provider === "duckduckgo-html";
    const ready = isFree || (typeof provider.apiKey === "string" && provider.apiKey.length > 0);
    lines.push(
      `${ready ? "PASS" : "WARN"}  ${provider.id ?? provider.provider}: credentials ${ready ? "available" : "missing"}`,
    );
  }
  return lines.join("\n");
}
