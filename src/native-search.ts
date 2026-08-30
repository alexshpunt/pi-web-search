import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

export const CODEX_CLIENT_VERSION = "0.151.0";
type ActiveModel = { provider: string; api: string; id: string; baseUrl: string; [key: string]: unknown };
type NativeResult = { text: string; provider: string; model: string };
type Input = { query: string; model: ActiveModel; modelRegistry: ModelRegistry; signal: AbortSignal; fetch: typeof fetch };
export interface NativeAdapter { id: string; search(input: Input): Promise<NativeResult>; }

/** Builds the shared direct-answer request sent to every native search provider. */
export function buildNativeSearchPrompt(query: string): string {
  return [
    "Answer immediately with the best self-contained response.",
    "You may include citations when useful.",
    "Do not ask follow-up questions or ask for more information.",
    "Do not describe what you are doing or add meta-commentary.",
    "Do not add conversational filler.",
    "Query:",
    query,
  ].join("\n");
}
export const STATIC_NATIVE_SEARCH_MODEL_IDS: Readonly<Record<string, readonly string[]>> = {
  "openai-responses": ["gpt-5.6","gpt-5.6-sol","gpt-5.6-terra","gpt-5.6-luna","gpt-5.5","gpt-5.5-pro","gpt-5.5-2026-04-23","gpt-5.5-pro-2026-04-23","gpt-5.4","gpt-5.4-pro","gpt-5.4-mini","gpt-5.4-nano","gpt-5.4-2026-03-05","gpt-5.4-pro-2026-03-05","gpt-5.4-mini-2026-03-17","gpt-5.4-nano-2026-03-17","gpt-4.1","gpt-4.1-mini","o4-mini"].map((id) => `openai:openai-responses:${id}`),
  "gemini-google-search": ["gemini-2.5-pro","gemini-2.5-flash","gemini-2.5-flash-lite","gemini-3-flash-preview","gemini-3-pro-image","gemini-3.1-pro-preview","gemini-3.1-flash-image","gemini-3.1-flash-lite","gemini-3.5-flash","gemini-3.5-flash-lite","gemini-3.6-flash","gemini-3.7-flash"].map((id) => `google:google-generative-ai:${id}`),
  "deepseek-responses": ["deepseek-v4-flash","deepseek-v4-pro","deepseek-v4-flash-vision-exp"].flatMap((id) => [`deepseek:openai-completions:${id}`]).concat(["deepseek-v4-flash","deepseek-v4-pro","deepseek-v4-flash-vision-exp"].map((id) => `deepseek:openai-responses:${id}`)),
  "xiaomi-mimo": ["mimo-v2.5","mimo-v2.5-pro"].map((id) => `xiaomi:openai-completions:${id}`),
};
const key = (m: ActiveModel) => `${m.provider}:${m.api}:${m.id}`;
function staticId(m: ActiveModel): string | undefined {
  for (const [adapter, ids] of Object.entries(STATIC_NATIVE_SEARCH_MODEL_IDS)) if (ids.includes(key(m))) return adapter;
  return undefined;
}
function textFromCompletion(result: any): string {
  if (!result || typeof result !== "object") throw new Error("Native search response was malformed.");
  const content = result.content;
  if (Array.isArray(content)) {
    const text = content.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n");
    if (content.length > 0 && text.length === 0) throw new Error("Native search response had no usable text.");
    return text;
  }
  if (typeof result.text === "string") return result.text;
  throw new Error("Native search response was malformed.");
}
function completionAdapter(id: string, mutate: (payload: any, model: ActiveModel) => any): NativeAdapter {
  return { id, async search(input) {
    const result = await (input.modelRegistry as any).complete(input.model, { messages: [{ role: "user", content: buildNativeSearchPrompt(input.query) }] }, {
      signal: input.signal, fetch: input.fetch,
      onPayload: (payload: unknown, model: ActiveModel) => mutate(payload, model),
    });
    return { text: textFromCompletion(result), provider: input.model.provider, model: input.model.id };
  } };
}
function payloadTools(payload: any, tool: any, choice?: any): any {
  const next = { ...(payload ?? {}), tools: [tool] };
  if (choice !== undefined) next.tool_choice = choice;
  return next;
}
function providerAdapter(m: ActiveModel, id: string): NativeAdapter | undefined {
  if (id === "anthropic-messages" && /[.:]/.test(m.id)) return undefined;
  if (id === "openai-responses") return completionAdapter(id, (p) => payloadTools(p, { type: "web_search" }));
  if (id === "xai-responses") return completionAdapter(id, (p) => payloadTools(p, { type: "web_search" }, "required"));
  if (id === "anthropic-messages") return completionAdapter(id, (p) => payloadTools(p, { type: "web_search_20250305", name: "web_search", max_uses: 8 }));
  if (id === "gemini-google-search") return completionAdapter(id, (p) => payloadTools(p, { google_search: {} }));
  if (id === "deepseek-responses" && m.api === "openai-responses") return completionAdapter(id, (p) => payloadTools(p, { type: "web_search" }, "required"));
  if (id === "deepseek-responses" && m.api === "openai-completions") return { id, search: deepSeekSearch };
  if (id === "xiaomi-mimo") return completionAdapter(id, (p) => payloadTools(p, { type: "web_search" }, "auto"));
  return undefined;
}
function authHeaders(auth: any): Record<string, string> {
  const original = auth?.headers && typeof auth.headers === "object" ? { ...auth.headers } : {};
  const hasAuth = Object.keys(original).some((name) => name.toLowerCase() === "authorization");
  if (!hasAuth && typeof auth?.apiKey === "string") original.Authorization = `Bearer ${auth.apiKey}`;
  return original;
}
async function deepSeekSearch(input: Input): Promise<NativeResult> {
  const auth = await (input.modelRegistry as any).getApiKeyAndHeaders(input.model);
  if (!auth?.ok) throw new Error("Unable to resolve DeepSeek authentication");
  const headers = authHeaders(auth); headers["content-type"] = "application/json";
  const base = metadataBase(input.model, auth); if (!base) throw new Error("Unable to resolve DeepSeek endpoint");
  const response = await input.fetch(`${base}/responses`, { method: "POST", signal: input.signal, headers, body: JSON.stringify({ model: input.model.id, input: buildNativeSearchPrompt(input.query), tools: [{ type: "web_search" }], tool_choice: "required" }) });
  if (!response.ok) throw new Error(`DeepSeek native search failed with HTTP ${response.status}`);
  let body: any; try { body = await response.json(); } catch { throw new Error("DeepSeek native search returned invalid response"); }
  if (!Array.isArray(body?.output)) throw new Error("DeepSeek native search returned malformed response");
  const text = body.output.flatMap((entry: any) => Array.isArray(entry?.content) ? entry.content : []).filter((part: any) => typeof part?.text === "string").map((part: any) => part.text).join("\\n");
  return { text, provider: input.model.provider, model: input.model.id };
}
function metadataBase(model: ActiveModel, auth: any): string | undefined {
  const base = typeof auth?.baseUrl === "string" ? auth.baseUrl : model.baseUrl;
  return typeof base === "string" ? base.replace(/\/+$/, "") : undefined;
}
async function codexAcquire(input: { model: ActiveModel; modelRegistry: ModelRegistry; signal: AbortSignal; fetch: typeof fetch; compatibility?: { codexClientVersion?: string } }): Promise<NativeAdapter | undefined> {
  const version = input.compatibility !== undefined ? input.compatibility.codexClientVersion : CODEX_CLIENT_VERSION;
  if (version === undefined) return undefined;
  if (!/^\d+\.\d+\.\d+$/.test(version)) return undefined;
  const auth = await (input.modelRegistry as any).getApiKeyAndHeaders(input.model);
  if (!auth?.ok) throw new Error("Codex native-search authentication failed.");
  input.signal.throwIfAborted();
  const response = await input.fetch(`https://chatgpt.com/backend-api/codex/models?client_version=${version}`, { method: "GET", signal: input.signal, headers: authHeaders(auth) });
  if (!response.ok) throw new Error(`Codex native-search capability request failed with HTTP ${response.status}.`);
  let body: any;
  try { body = await response.json(); } catch { throw new Error("Codex native-search capability response was malformed."); }
  if (!Array.isArray(body?.models)) throw new Error("Codex native-search capability response was malformed.");
  const matching = body.models.filter((record: any) => record !== null && typeof record === "object" && record.slug === input.model.id);
  if (matching.length > 1) throw new Error("Codex native-search capability response had duplicate active model records.");
  if (matching.length === 0) return undefined;
  const record = matching[0];
  if (typeof record.supports_search_tool !== "boolean") throw new Error("Codex native-search capability response had malformed active model metadata.");
  if (!record.supports_search_tool) return undefined;
  return completionAdapter("openai-codex-responses", (p) => payloadTools({ ...(p ?? {}), model: input.model.id, store: false, stream: true }, { type: "web_search", external_web_access: true }, "auto"));
}
async function openRouterAcquire(input: { model: ActiveModel; modelRegistry: ModelRegistry; signal: AbortSignal; fetch: typeof fetch }): Promise<NativeAdapter | undefined> {
  const auth = await (input.modelRegistry as any).getApiKeyAndHeaders(input.model);
  if (!auth?.ok) throw new Error("OpenRouter native-search authentication failed.");
  input.signal.throwIfAborted();
  const base = metadataBase(input.model, auth);
  if (!base) throw new Error("OpenRouter native-search endpoint could not be resolved.");
  const response = await input.fetch(`${base}/models/${input.model.id}/endpoints`, { method: "GET", signal: input.signal, headers: authHeaders(auth) });
  if (!response.ok) throw new Error(`OpenRouter native-search capability request failed with HTTP ${response.status}.`);
  let body: any;
  try { body = await response.json(); } catch { throw new Error("OpenRouter native-search capability response was malformed."); }
  if (!body || typeof body !== "object" || Array.isArray(body) || !body.data || typeof body.data !== "object" || Array.isArray(body.data)) throw new Error("OpenRouter native-search capability response was malformed.");
  if (!Array.isArray(body.data.endpoints)) throw new Error("OpenRouter native-search capability response was malformed.");
  if (body.data.id !== input.model.id) return undefined;
  const matching = body.data.endpoints.filter((endpoint: any) => endpoint !== null && typeof endpoint === "object" && endpoint.model_id === input.model.id);
  if (matching.length === 0) return undefined;
  for (const endpoint of matching) {
    if (!Array.isArray(endpoint.supported_parameters)) throw new Error("OpenRouter native-search capability response was malformed.");
  }
  if (!matching.some((endpoint: any) => endpoint.supported_parameters.includes("tools"))) return undefined;
  return completionAdapter("openrouter-server-search", (p) => payloadTools(p, { type: "openrouter:web_search" }));
}
/** Resolves a fail-closed native search adapter for the active Pi model. */
export async function acquireNativeSearchAdapter(input: { model: ActiveModel; modelRegistry: ModelRegistry; signal: AbortSignal; fetch: typeof fetch; compatibility?: { codexClientVersion?: string } }): Promise<NativeAdapter | undefined> {
  if (input.model.provider === "openai-codex" && input.model.api === "openai-codex-responses") return codexAcquire(input);
  if (input.model.provider === "openrouter" && input.model.api === "openai-completions") return openRouterAcquire(input);
  return providerAdapter(input.model, staticId(input.model) ?? (input.model.provider === "anthropic" && input.model.api === "anthropic-messages" ? "anthropic-messages" : input.model.provider === "xai" && input.model.api === "openai-responses" ? "xai-responses" : undefined) ?? "");
}
/** Resolves static native capability without performing network acquisition. */
export function resolveNativeSearchAdapter(model: ActiveModel): NativeAdapter | undefined {
  if (model.provider === "openai-codex" || model.provider === "openrouter" || model.provider === "opencode" || model.provider === "opencode-go") return undefined;
  const id = staticId(model) ?? (model.provider === "anthropic" && model.api === "anthropic-messages" ? "anthropic-messages" : model.provider === "xai" && model.api === "openai-responses" ? "xai-responses" : undefined);
  return id ? providerAdapter(model, id) : undefined;
}

export async function searchWithNativeAdapter(adapter: NativeAdapter, input: Input): Promise<NativeResult> { return adapter.search(input); }
