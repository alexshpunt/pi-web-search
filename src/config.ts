import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { isAllowedProviderBaseUrl } from "./providers/endpoints.ts";
import type { CodexSearchMode, ConfigLoadResult, JsonObject, JsonValue, ProviderValidationResult, RoutingStrategy, SearchContextSize, SearchProvider, SearchProviderConfig, SearchProviderEntry, SearchUserLocation, WebsearchConfig } from "./types.ts";

export const SEARCH_PROVIDERS: readonly SearchProvider[] = ["exa","tavily","brave","duckduckgo-html","serper","parallel","google-cse","z-ai","openai","codex","anthropic","perplexity","xai","kimi"];
const CONTEXT_SIZES: readonly SearchContextSize[] = ["low","medium","high"];
const CODEX_MODES: readonly CodexSearchMode[] = ["cached","live"];
const STRATEGIES: readonly RoutingStrategy[] = ["priority","round-robin","fill-first"];
export const DEFAULT_MAX_RESULTS = 10;
export const DEFAULT_SOURCE_TIMEOUT_MS = 30_000;
export const DEFAULT_AGGREGATE_DEADLINE_MS = 45_000;
const DEFAULT_FREE_CONFIG: WebsearchConfig = { strategy: "priority", fallback: true, providers: [{ id: "default", provider: "duckduckgo-html", maxResults: DEFAULT_MAX_RESULTS }], maxResults: DEFAULT_MAX_RESULTS, sourceTimeoutMs: DEFAULT_SOURCE_TIMEOUT_MS, aggregateDeadlineMs: DEFAULT_AGGREGATE_DEADLINE_MS };

export interface ConfigLoadOptions { cwd: string; agentDirectory?: string; env?: NodeJS.ProcessEnv; }
const isObject = (v: unknown): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);
const oneOf = <T extends string>(values: readonly T[], value: unknown): value is T => typeof value === "string" && values.includes(value as T);
const optionalString = (v: JsonValue | undefined) => typeof v === "string" && v.length > 0 ? v : undefined;
const optionalNumber = (v: JsonValue | undefined) => typeof v === "number" && Number.isFinite(v) ? v : undefined;
const optionalBoolean = (v: JsonValue | undefined) => typeof v === "boolean" ? v : undefined;
const optionalLocation = (v: JsonValue | undefined): SearchUserLocation | undefined => {
  if (!isObject(v)) return undefined;
  const result: SearchUserLocation = {};
  for (const key of ["country","region","city","timezone"] as const) { const value = optionalString(v[key]); if (value) result[key] = value; }
  return Object.keys(result).length ? result : undefined;
};
const isStringArray = (v: JsonValue | undefined): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
type ProviderParseResult =
  | { ok: true; value: SearchProviderEntry }
  | { ok: false; message: string };

function providerEntry(raw: JsonObject, index?: number): ProviderParseResult {
  const prefix = index === undefined ? "provider" : `providers[${index}]`;
  if (typeof raw.provider !== "string") return { ok: false, message: `${prefix}.provider must be a supported provider name.` };
  if (!SEARCH_PROVIDERS.includes(raw.provider as SearchProvider)) return { ok: false, message: `${prefix}.provider is unsupported: ${raw.provider}` };
  const result: SearchProviderEntry = { provider: raw.provider as SearchProvider };
  for (const key of ["id", "apiKey", "baseUrl", "searchEngineId", "model"] as const) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== "string" || raw[key].length === 0) return { ok: false, message: `${prefix}.${key} must be a non-empty string.` };
    result[key] = raw[key] as string;
  }
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== "boolean") return { ok: false, message: `${prefix}.enabled must be a boolean.` };
    result.enabled = raw.enabled;
  }
  for (const key of ["maxResults", "priority", "weight"] as const) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== "number" || !Number.isFinite(raw[key])) return { ok: false, message: `${prefix}.${key} must be a finite number.` };
    result[key] = raw[key] as number;
  }
  if (raw.codexMode !== undefined) {
    if (!oneOf(CODEX_MODES, raw.codexMode)) return { ok: false, message: `${prefix}.codexMode must be cached or live.` };
    result.codexMode = raw.codexMode;
  }
  if (raw.searchContextSize !== undefined) {
    if (!oneOf(CONTEXT_SIZES, raw.searchContextSize)) return { ok: false, message: `${prefix}.searchContextSize must be low, medium, or high.` };
    result.searchContextSize = raw.searchContextSize;
  }
  for (const key of ["allowedDomains", "blockedDomains"] as const) {
    if (raw[key] === undefined) continue;
    if (!isStringArray(raw[key])) return { ok: false, message: `${prefix}.${key} must be an array of strings.` };
    result[key] = raw[key];
  }
  if (raw.userLocation !== undefined) {
    if (!isObject(raw.userLocation)) return { ok: false, message: `${prefix}.userLocation must be an object.` };
    for (const key of ["country", "region", "city", "timezone"] as const) {
      if (raw.userLocation[key] !== undefined && (typeof raw.userLocation[key] !== "string" || raw.userLocation[key].length === 0)) return { ok: false, message: `${prefix}.userLocation.${key} must be a non-empty string.` };
    }
    const location = optionalLocation(raw.userLocation);
    if (location) result.userLocation = location;
  }
  return { ok: true, value: result };
}
function parseObject(content: string): JsonObject | null { try { const value: unknown = JSON.parse(content); return isObject(value) ? value : null; } catch { return null; } }
type ConfigParseResult = { config: WebsearchConfig } | { error: string };
function configFromObject(raw: JsonObject): ConfigParseResult {
  const strategy = oneOf(STRATEGIES, raw.strategy) ? raw.strategy : "priority";
  const fallback = optionalBoolean(raw.fallback) ?? true;
  if (raw.providers !== undefined && !Array.isArray(raw.providers)) return { error: "providers must be an array." };
  const rawProviders = Array.isArray(raw.providers) ? raw.providers : undefined;
  const parsedProviders: SearchProviderEntry[] = [];
  const parseErrors: string[] = [];
  if (rawProviders) {
    for (const [index, value] of rawProviders.entries()) {
      if (!isObject(value)) { parseErrors.push(`providers[${index}] must be an object.`); continue; }
      const parsed = providerEntry(value, index);
      if (!parsed.ok) { parseErrors.push(parsed.message); continue; }
      parsedProviders.push(parsed.value);
    }
  } else {
    const parsed = providerEntry(raw);
    if (parsed.ok) parsedProviders.push(parsed.value);
    else if (raw.provider !== undefined || raw.apiKey !== undefined || raw.baseUrl !== undefined) parseErrors.push(parsed.message);
  }
  if (parseErrors.length) return { error: parseErrors.join("; ") };
  if (!rawProviders && parsedProviders.length === 0 && raw.provider === undefined && raw.strategy === undefined && raw.fallback === undefined) return { error: "No provider configuration found." };
  const maxResults = optionalNumber(raw.maxResults) ?? Math.max(...parsedProviders.map((p) => p.maxResults ?? 0), DEFAULT_MAX_RESULTS);
  const sourceTimeoutMs = optionalNumber(raw.sourceTimeoutMs) ?? DEFAULT_SOURCE_TIMEOUT_MS;
  const aggregateDeadlineMs = optionalNumber(raw.aggregateDeadlineMs) ?? DEFAULT_AGGREGATE_DEADLINE_MS;
  const providerOrder = isStringArray(raw.providerOrder) ? raw.providerOrder.filter(Boolean) : undefined;
  const warnings: string[] = [];
  if (raw.strategy !== undefined) warnings.push("obsolete routing field: strategy");
  if (raw.fallback !== undefined) warnings.push("obsolete routing field: fallback");
  if (raw.providerOrder !== undefined) warnings.push("obsolete routing field: providerOrder");
  for (const p of parsedProviders) { if (p.priority !== undefined) warnings.push(`obsolete routing field: priority (${p.id ?? p.provider})`); if (p.weight !== undefined) warnings.push(`obsolete routing field: weight (${p.id ?? p.provider})`); }
  return { config: { strategy, fallback, providers: parsedProviders, ...(providerOrder && { providerOrder }), maxResults, sourceTimeoutMs, aggregateDeadlineMs, ...(warnings.length && { migrationWarnings: warnings }) } };
}
function hasApiKey(config: SearchProviderConfig): boolean { return typeof config.apiKey === "string" && config.apiKey.length > 0; }
export function validateProviderConfig(config: SearchProviderEntry): ProviderValidationResult {
  if (!SEARCH_PROVIDERS.includes(config.provider)) return { ok:false, reason:"invalid_config", message:`Unsupported provider: ${config.provider}` };
  if (config.allowedDomains && config.blockedDomains) return { ok:false, reason:"invalid_config", message:"Provider config cannot specify both allowedDomains and blockedDomains." };
  if (config.weight !== undefined && config.weight <= 0) return { ok:false, reason:"invalid_config", message:"Provider weight must be greater than 0." };
  if (config.baseUrl && !isAllowedProviderBaseUrl(config.baseUrl)) return { ok:false, reason:"invalid_config", message:`Provider ${config.provider} baseUrl must be a public HTTPS URL without credentials.` };
  if (config.provider === "google-cse" && !config.searchEngineId) return { ok:false, reason:"missing_api_key", message:"Provider google-cse requires searchEngineId." };
  if ((config.provider === "codex" || config.provider === "openai") && !hasApiKey(config)) return { ok:false, reason:"missing_api_key", message:`Provider ${config.provider} requires apiKey for hosted Responses API search.` };
  if (config.provider !== "codex" && config.provider !== "openai" && config.provider !== "duckduckgo-html" && !hasApiKey(config)) return { ok:false, reason:"missing_api_key", message:`Provider ${config.provider} requires apiKey.` };
  return { ok:true, config };
}
export function validateWebsearchConfig(config: WebsearchConfig): ProviderValidationResult | { ok:true; config:WebsearchConfig } {
  const maxResults = config.maxResults ?? DEFAULT_MAX_RESULTS;
  const sourceTimeoutMs = config.sourceTimeoutMs ?? DEFAULT_SOURCE_TIMEOUT_MS;
  const aggregateDeadlineMs = config.aggregateDeadlineMs ?? DEFAULT_AGGREGATE_DEADLINE_MS;
  if (maxResults < 1 || maxResults > 20 || !Number.isInteger(maxResults)) return { ok:false, reason:"invalid_config", message:"maxResults must be an integer from 1 to 20." };
  if (sourceTimeoutMs <= 0 || !Number.isFinite(sourceTimeoutMs) || aggregateDeadlineMs <= 0 || !Number.isFinite(aggregateDeadlineMs)) return { ok:false, reason:"invalid_config", message:"sourceTimeoutMs and aggregateDeadlineMs must be positive finite numbers." };
  let missingCredentials: ProviderValidationResult | undefined;
  let invalid: ProviderValidationResult | undefined;
  for (const provider of config.providers) {
    const check = validateProviderConfig(provider);
    if (!check.ok && check.reason === "invalid_config") invalid ??= check;
    if (!check.ok && check.reason === "missing_api_key") missingCredentials ??= check;
  }
  return invalid ?? missingCredentials ?? { ok:true, config };
}
async function fileExists(file: string): Promise<boolean> { try { await access(file); return true; } catch { return false; } }
async function readOptional(file: string): Promise<ConfigLoadResult | undefined> {
  if (!(await fileExists(file))) return undefined;
  const raw = parseObject(await readFile(file, "utf8"));
  if (!raw) return { ok:false, reason:"invalid_config", message:`Invalid JSON object in ${file}`, source:file };
  const parsed = configFromObject(raw);
  if ("error" in parsed) return { ok:false, reason:"invalid_config", message:`Invalid provider config in ${file}: ${parsed.error}`, source:file };
  const config = parsed.config;
  return { ok:true, config, source:file, ...(config.migrationWarnings && { warnings: config.migrationWarnings }) };
}
export async function loadWebsearchConfig(options: ConfigLoadOptions): Promise<ConfigLoadResult> {
  const agent = options.agentDirectory ?? getAgentDir();
  const localPath = path.join(options.cwd, CONFIG_DIR_NAME, "websearch.json");
  const globalPath = path.join(agent, "websearch.json");
  const local = await readOptional(localPath); if (local && !local.ok) return local;
  const global = await readOptional(globalPath); if (global && !global.ok) return global;
  const localConfig = local?.ok ? local.config : undefined; const globalConfig = global?.ok ? global.config : undefined;
  const base = localConfig ?? globalConfig ?? DEFAULT_FREE_CONFIG;
  const config = mergeCredentials(base, globalConfig, localConfig, options.env ?? process.env);
  const validation = validateWebsearchConfig(config);
  const source = localConfig ? localPath : globalConfig ? globalPath : "default:duckduckgo-html";
  if (validation.ok) return { ok:true, config, source, ...(config.migrationWarnings && { warnings: config.migrationWarnings }) };
  if (validation.reason === "missing_api_key") return { ok:true, config, source, ...(config.migrationWarnings && { warnings: config.migrationWarnings }) };
  return { ...validation, source };
}
function mergeCredentials(base: WebsearchConfig, global: WebsearchConfig | undefined, local: WebsearchConfig | undefined, env: NodeJS.ProcessEnv): WebsearchConfig {
  return { ...base, providers: base.providers.map((provider) => { const gp = findProvider(global, provider); const lp = findProvider(local, provider); const key = providerEnvironmentKey(provider, env) ?? gp?.apiKey ?? lp?.apiKey ?? provider.apiKey; const engine = provider.provider === "google-cse" ? env.GOOGLE_SEARCH_ENGINE_ID ?? gp?.searchEngineId ?? lp?.searchEngineId ?? provider.searchEngineId : provider.searchEngineId; return { ...gp, ...provider, ...(key && { apiKey:key }), ...(engine && { searchEngineId:engine }) }; }) };
}
function findProvider(config: WebsearchConfig | undefined, target: SearchProviderEntry) { return config?.providers.find((p) => target.id !== undefined && p.id === target.id ? true : p.provider === target.provider); }
function providerEnvironmentKey(provider: SearchProviderEntry, env: NodeJS.ProcessEnv): string | undefined {
  const custom = `PI_AGENT_IDE_SEARCH_${(provider.id ?? provider.provider).replaceAll(/[^a-z0-9]/giu, "_").toUpperCase()}_API_KEY`;
  const standard: Partial<Record<SearchProvider, readonly string[]>> = { exa:["EXA_API_KEY"], tavily:["TAVILY_API_KEY"], brave:["BRAVE_SEARCH_API_KEY","BRAVE_API_KEY"], serper:["SERPER_API_KEY"], parallel:["PARALLEL_API_KEY"], "google-cse":["GOOGLE_API_KEY"], "z-ai":["ZAI_API_KEY"], openai:["OPENAI_API_KEY"], codex:["OPENAI_API_KEY"], anthropic:["ANTHROPIC_API_KEY"], perplexity:["PERPLEXITY_API_KEY"], xai:["XAI_API_KEY"], kimi:["KIMI_API_KEY"] };
  for (const name of [custom, ...(standard[provider.provider] ?? [])]) { const value = env[name]?.trim(); if (value) return value; }
  return undefined;
}
