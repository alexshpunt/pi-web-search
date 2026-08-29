import { access, readFile } from "node:fs/promises";
import path from "node:path";

import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

import { isAllowedProviderBaseUrl } from "./providers/endpoints.ts";

import type {
  CodexSearchMode,
  ConfigLoadResult,
  JsonObject,
  JsonValue,
  ProviderValidationResult,
  RoutingStrategy,
  SearchContextSize,
  SearchProvider,
  SearchProviderConfig,
  SearchProviderEntry,
  SearchUserLocation,
  WebsearchConfig,
} from "./types.ts";

export const SEARCH_PROVIDERS: readonly SearchProvider[] = [
  "exa",
  "tavily",
  "brave",
  "duckduckgo-html",
  "serper",
  "parallel",
  "google-cse",
  "z-ai",
  "openai",
  "codex",
  "anthropic",
  "perplexity",
  "xai",
  "kimi",
];
const CONTEXT_SIZES: readonly SearchContextSize[] = ["low", "medium", "high"];
const CODEX_MODES: readonly CodexSearchMode[] = ["cached", "live"];
const STRATEGIES: readonly RoutingStrategy[] = ["priority", "round-robin", "fill-first"];
const DEFAULT_MAX_RESULTS = 10;
const DEFAULT_FREE_CONFIG: WebsearchConfig = {
  strategy: "priority",
  fallback: true,
  providers: [{ id: "default", provider: "duckduckgo-html", maxResults: DEFAULT_MAX_RESULTS }],
};

export interface ConfigLoadOptions {
  cwd: string;
  /**
    Global Pi agent directory. Defaults to `~/.pi/agent`.
    */
  agentDirectory?: string;
  env?: NodeJS.ProcessEnv;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function oneOf<TValue extends string>(values: readonly TValue[], value: unknown): value is TValue {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

function isStringArray(value: JsonValue | undefined): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function optionalString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalNumber(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalBoolean(value: JsonValue | undefined): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function optionalProvider(value: JsonValue | undefined): SearchProvider | undefined {
  return oneOf(SEARCH_PROVIDERS, value) ? value : undefined;
}

function optionalContextSize(value: JsonValue | undefined): SearchContextSize | undefined {
  return oneOf(CONTEXT_SIZES, value) ? value : undefined;
}

function optionalCodexMode(value: JsonValue | undefined): CodexSearchMode | undefined {
  return oneOf(CODEX_MODES, value) ? value : undefined;
}

function optionalStrategy(value: JsonValue | undefined): RoutingStrategy | undefined {
  return oneOf(STRATEGIES, value) ? value : undefined;
}

function optionalLocation(value: JsonValue | undefined): SearchUserLocation | undefined {
  if (!isJsonObject(value)) {
    return undefined;
  }

  const location: SearchUserLocation = {};
  const country = optionalString(value.country);
  const region = optionalString(value.region);
  const city = optionalString(value.city);
  const timezone = optionalString(value.timezone);

  if (country) {
    location.country = country;
  }

  if (region) {
    location.region = region;
  }

  if (city) {
    location.city = city;
  }

  if (timezone) {
    location.timezone = timezone;
  }

  return Object.keys(location).length > 0 ? location : undefined;
}

function normalizedProviderOrder(values: readonly string[]): string[] | undefined {
  const order: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    const trimmed = value.trim();
    const normalized = trimmed.toLowerCase();

    if (!trimmed || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    order.push(trimmed);
  }

  return order.length > 0 ? order : undefined;
}

function optionalProviderOrder(value: JsonValue | undefined): string[] | undefined {
  return isStringArray(value) ? normalizedProviderOrder(value) : undefined;
}

function matchesProviderOrder(provider: SearchProviderEntry, selector: string): boolean {
  const normalized = selector.trim().toLowerCase();
  return (
    provider.provider.toLowerCase() === normalized || provider.id?.toLowerCase() === normalized
  );
}

function applyProviderOrder(
  providers: SearchProviderEntry[],
  providerOrder?: readonly string[],
): SearchProviderEntry[] {
  if (!providerOrder?.length) {
    return providers;
  }

  const remaining = [...providers];
  const ordered: SearchProviderEntry[] = [];

  for (const selector of providerOrder) {
    const index = remaining.findIndex((provider) => matchesProviderOrder(provider, selector));

    if (index !== -1) {
      ordered.push(...remaining.splice(index, 1));
    }
  }

  return [...ordered, ...remaining];
}

function parseJsonObject(content: string): JsonObject | null {
  let parsed: unknown;

  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }

  return isJsonObject(parsed) ? parsed : null;
}

function providerEntryFromObject(raw: JsonObject): SearchProviderEntry | null {
  const provider = optionalProvider(raw.provider);

  if (!provider) {
    return null;
  }

  const config: SearchProviderEntry = { provider };
  const id = optionalString(raw.id);
  const apiKey = optionalString(raw.apiKey);
  const baseUrl = optionalString(raw.baseUrl);
  const searchEngineId = optionalString(raw.searchEngineId);
  const maxResults = optionalNumber(raw.maxResults);
  const model = optionalString(raw.model);
  const codexMode = optionalCodexMode(raw.codexMode);
  const searchContextSize = optionalContextSize(raw.searchContextSize);
  const rawAllowedDomains = raw.allowedDomains;
  const rawBlockedDomains = raw.blockedDomains;
  const allowedDomains = isStringArray(rawAllowedDomains) ? rawAllowedDomains : undefined;
  const blockedDomains = isStringArray(rawBlockedDomains) ? rawBlockedDomains : undefined;
  const userLocation = optionalLocation(raw.userLocation);
  const priority = optionalNumber(raw.priority);
  const weight = optionalNumber(raw.weight);

  if (id) {
    config.id = id;
  }

  if (apiKey) {
    config.apiKey = apiKey;
  }

  if (baseUrl) {
    config.baseUrl = baseUrl;
  }

  if (searchEngineId) {
    config.searchEngineId = searchEngineId;
  }

  if (maxResults) {
    config.maxResults = maxResults;
  }

  if (model) {
    config.model = model;
  }

  if (codexMode) {
    config.codexMode = codexMode;
  }

  if (searchContextSize) {
    config.searchContextSize = searchContextSize;
  }

  if (allowedDomains) {
    config.allowedDomains = allowedDomains;
  }

  if (blockedDomains) {
    config.blockedDomains = blockedDomains;
  }

  if (userLocation) {
    config.userLocation = userLocation;
  }

  if (priority !== undefined) {
    config.priority = priority;
  }

  if (weight !== undefined) {
    config.weight = weight;
  }

  return config;
}

function configFromObject(raw: JsonObject): WebsearchConfig | null {
  const strategy = optionalStrategy(raw.strategy) ?? "priority";
  const isFallback = optionalBoolean(raw.fallback) ?? true;
  const providerOrder = optionalProviderOrder(raw.providerOrder);
  const providersValue = raw.providers;
  const rawProviders = Array.isArray(providersValue) ? providersValue : undefined;

  if (rawProviders) {
    if (optionalProvider(raw.provider)) {
      return null;
    }

    const providers = rawProviders
      .map((value) => (isJsonObject(value) ? providerEntryFromObject(value) : null))
      .filter((entry): entry is SearchProviderEntry => entry !== null);
    const orderedProviders = applyProviderOrder(providers, providerOrder);
    return {
      strategy,
      fallback: isFallback,
      providers: orderedProviders,
      ...(providerOrder && { providerOrder }),
    };
  }

  const provider = providerEntryFromObject(raw);

  if (provider) {
    return {
      strategy,
      fallback: isFallback,
      providers: [provider],
      ...(providerOrder && { providerOrder }),
    };
  }

  if (providerOrder || raw.strategy !== undefined || raw.fallback !== undefined) {
    return {
      strategy,
      fallback: isFallback,
      providers: [],
      ...(providerOrder && { providerOrder }),
    };
  }

  return null;
}

function hasApiKey(config: SearchProviderConfig): boolean {
  return typeof config.apiKey === "string" && config.apiKey.length > 0;
}

export function validateProviderConfig(config: SearchProviderEntry): ProviderValidationResult {
  if (!SEARCH_PROVIDERS.includes(config.provider)) {
    return {
      ok: false,
      reason: "invalid_config",
      message: `Unsupported provider: ${config.provider}`,
    };
  }

  if (config.allowedDomains && config.blockedDomains) {
    return {
      ok: false,
      reason: "invalid_config",
      message: "Provider config cannot specify both allowedDomains and blockedDomains.",
    };
  }

  if (config.weight !== undefined && config.weight <= 0) {
    return {
      ok: false,
      reason: "invalid_config",
      message: "Provider weight must be greater than 0.",
    };
  }

  if (config.baseUrl && !isAllowedProviderBaseUrl(config.baseUrl)) {
    return {
      ok: false,
      reason: "invalid_config",
      message: `Provider ${config.provider} baseUrl must be a public HTTPS URL without credentials.`,
    };
  }

  if (config.provider === "google-cse" && !config.searchEngineId) {
    return {
      ok: false,
      reason: "missing_api_key",
      message: "Provider google-cse requires searchEngineId.",
    };
  }

  if ((config.provider === "codex" || config.provider === "openai") && !hasApiKey(config)) {
    return {
      ok: false,
      reason: "missing_api_key",
      message: `Provider ${config.provider} requires apiKey for hosted Responses API search.`,
    };
  }

  if (
    config.provider !== "codex" &&
    config.provider !== "openai" &&
    config.provider !== "duckduckgo-html" &&
    !hasApiKey(config)
  ) {
    return {
      ok: false,
      reason: "missing_api_key",
      message: `Provider ${config.provider} requires apiKey.`,
    };
  }

  return { ok: true, config };
}

export function validateWebsearchConfig(
  config: WebsearchConfig,
): ProviderValidationResult | { ok: true; config: WebsearchConfig } {
  if (!STRATEGIES.includes(config.strategy)) {
    return {
      ok: false,
      reason: "invalid_config",
      message: `Unsupported routing strategy: ${config.strategy}`,
    };
  }

  if (config.providers.length === 0) {
    return {
      ok: false,
      reason: "invalid_config",
      message: "Websearch config requires at least one provider.",
    };
  }

  for (const provider of config.providers) {
    const validation = validateProviderConfig(provider);

    if (!validation.ok) {
      return validation;
    }
  }

  return { ok: true, config };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function loadWebsearchConfig(options: ConfigLoadOptions): Promise<ConfigLoadResult> {
  const globalDirectory = options.agentDirectory ?? getAgentDir();
  const localPath = path.join(options.cwd, CONFIG_DIR_NAME, "websearch.json");
  const globalPath = path.join(globalDirectory, "websearch.json");
  const local = await readOptionalConfig(localPath);

  if (local !== undefined && !local.ok) {
    return local;
  }

  const global = await readOptionalConfig(globalPath);

  if (global !== undefined && !global.ok) {
    return global;
  }

  const localConfig = local?.ok === true ? local.config : undefined;
  const globalConfig = global?.ok === true ? global.config : undefined;
  const base = localConfig ?? globalConfig ?? DEFAULT_FREE_CONFIG;
  const config = mergeCredentials(base, globalConfig, localConfig, options.env ?? process.env);
  const validation = validateWebsearchConfig(config);
  const source =
    localConfig === undefined
      ? globalConfig === undefined
        ? "default:duckduckgo-html"
        : globalPath
      : localPath;
  return validation.ok ? { ok: true, config, source } : { ...validation, source };
}

async function readOptionalConfig(configPath: string): Promise<ConfigLoadResult | undefined> {
  if (!(await fileExists(configPath))) {
    return undefined;
  }

  const raw = parseJsonObject(await readFile(configPath, "utf8"));

  if (raw === null) {
    return {
      ok: false,
      reason: "invalid_config",
      message: `Invalid JSON object in ${configPath}`,
      source: configPath,
    };
  }

  const config = configFromObject(raw);

  if (config === null) {
    return {
      ok: false,
      reason: "invalid_config",
      message: `Invalid provider config in ${configPath}`,
      source: configPath,
    };
  }

  return { ok: true, config, source: configPath };
}

function mergeCredentials(
  base: WebsearchConfig,
  global: WebsearchConfig | undefined,
  local: WebsearchConfig | undefined,
  environment: NodeJS.ProcessEnv,
): WebsearchConfig {
  return {
    ...base,
    providers: base.providers.map((provider) => {
      const globalProvider = findProvider(global, provider);
      const localProvider = findProvider(local, provider);
      const environmentKey = providerEnvironmentKey(provider, environment);
      const apiKey =
        environmentKey ?? globalProvider?.apiKey ?? localProvider?.apiKey ?? provider.apiKey;
      const searchEngineId =
        provider.provider === "google-cse"
          ? (environment.GOOGLE_SEARCH_ENGINE_ID ??
            globalProvider?.searchEngineId ??
            localProvider?.searchEngineId ??
            provider.searchEngineId)
          : provider.searchEngineId;
      return {
        ...globalProvider,
        ...provider,
        ...(apiKey && { apiKey }),
        ...(searchEngineId && { searchEngineId }),
      };
    }),
  };
}

function findProvider(
  config: WebsearchConfig | undefined,
  target: SearchProviderEntry,
): SearchProviderEntry | undefined {
  return config?.providers.find((provider) =>
    target.id !== undefined && provider.id === target.id
      ? true
      : provider.provider === target.provider,
  );
}

function providerEnvironmentKey(
  provider: SearchProviderEntry,
  environment: NodeJS.ProcessEnv,
): string | undefined {
  const customName = `PI_AGENT_IDE_SEARCH_${(provider.id ?? provider.provider)
    .replaceAll(/[^a-z0-9]/giu, "_")
    .toUpperCase()}_API_KEY`;
  const standard: Partial<Record<SearchProvider, readonly string[]>> = {
    exa: ["EXA_API_KEY"],
    tavily: ["TAVILY_API_KEY"],
    brave: ["BRAVE_SEARCH_API_KEY", "BRAVE_API_KEY"],
    serper: ["SERPER_API_KEY"],
    parallel: ["PARALLEL_API_KEY"],
    "google-cse": ["GOOGLE_API_KEY"],
    "z-ai": ["ZAI_API_KEY"],
    openai: ["OPENAI_API_KEY"],
    codex: ["OPENAI_API_KEY"],
    anthropic: ["ANTHROPIC_API_KEY"],
    perplexity: ["PERPLEXITY_API_KEY"],
    xai: ["XAI_API_KEY"],
    kimi: ["KIMI_API_KEY"],
  };

  for (const name of [customName, ...(standard[provider.provider] ?? [])]) {
    const value = environment[name]?.trim();

    if (value) {
      return value;
    }
  }

  return undefined;
}
