export type SearchProvider =
  | "exa" | "tavily" | "brave" | "duckduckgo-html" | "serper" | "parallel"
  | "google-cse" | "z-ai" | "openai" | "codex" | "anthropic" | "perplexity" | "xai" | "kimi";

export type SearchContextSize = "low" | "medium" | "high";
export type CodexSearchMode = "cached" | "live";
/** Legacy routing values are accepted for migration only and never control execution. */
export type RoutingStrategy = "priority" | "round-robin" | "fill-first";

export interface SearchProviderConfig {
  id?: string;
  provider: SearchProvider;
  apiKey?: string;
  baseUrl?: string;
  searchEngineId?: string;
  maxResults?: number;
  model?: string;
  codexMode?: CodexSearchMode;
  searchContextSize?: SearchContextSize;
  allowedDomains?: string[];
  blockedDomains?: string[];
  userLocation?: SearchUserLocation;
}
export interface SearchProviderEntry extends SearchProviderConfig { enabled?: boolean; priority?: number; weight?: number; }
export interface WebsearchConfig {
  /** @deprecated retained only to report migration warnings. */ strategy?: RoutingStrategy;
  /** @deprecated retained only to report migration warnings. */ fallback?: boolean;
  providers: SearchProviderEntry[];
  /** @deprecated retained only to report migration warnings. */ providerOrder?: string[];
  maxResults?: number;
  sourceTimeoutMs?: number;
  aggregateDeadlineMs?: number;
  migrationWarnings?: string[];
}
export interface SearchUserLocation { country?: string; region?: string; city?: string; timezone?: string; }
export interface SearchRequest { query: string; maxResults: number; allowedDomains?: string[]; blockedDomains?: string[]; }
export interface BuiltSearchRequest { url: string; init: { method: "GET" | "POST"; headers: Record<string,string> }; body?: JsonObject; }
export interface SearchResultItem {
  title: string; url: string; snippet?: string; score?: number; source?: string; sources?: string[]; publishedAt?: string;
}
export type SourceStatus = "success" | "empty" | "failure" | "timeout" | "ineligible";
export interface SearchAttempt {
  provider: string; entryId?: string; durationMs: number; resultsCount: number;
  error?: string; status?: SourceStatus; timeoutReason?: "source-timeout" | "aggregate-deadline";
  sources?: string[];
}
export interface NativeDetails {
  status: SourceStatus; provider?: string; model?: string; durationMs?: number; error?: string;
  timeoutReason?: "source-timeout" | "aggregate-deadline";
}
export interface SearchDetails {
  provider: SearchProvider;
  entryId?: string;
  query: string;
  results: SearchResultItem[];
  durationMs: number;
  truncated: boolean;
  strategy?: RoutingStrategy;
  attempts?: SearchAttempt[];
  answer?: string;
  error?: string;
  native?: NativeDetails;
  migrationWarnings?: string[];
  aggregateDeadlineMs?: number;
  sourceTimeoutMs?: number;
}
export interface SearchProgressDetails { phase: "searching"; query: string; providerLabels: string[]; maxResults: number; strategy?: RoutingStrategy; allowedDomains?: string[]; blockedDomains?: string[]; }
export type ConfigLoadFailureReason = "invalid_config" | "missing_api_key";
export interface SearchErrorDetails { phase: "error"; query: string; error: string; reason?: ConfigLoadFailureReason; }
export type SearchRenderDetails = SearchDetails | SearchProgressDetails | SearchErrorDetails;
export type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];
export interface JsonObject { [key: string]: JsonValue; }
export type ConfigLoadResult =
  | { ok: true; config: WebsearchConfig; source: string; warnings?: string[] }
  | { ok: false; reason: ConfigLoadFailureReason; message: string; source?: string };
export type ProviderValidationResult =
  | { ok: true; config: SearchProviderEntry }
  | { ok: false; reason: "invalid_config" | "missing_api_key"; message: string };
