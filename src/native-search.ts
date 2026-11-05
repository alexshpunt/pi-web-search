import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

export const CODEX_CLIENT_VERSION = "0.151.0";
type ActiveModel = { provider: string; api: string; id: string; baseUrl: string };
type NativeResult = { text: string; provider: string; model: string };
type Input = { query: string; model: ActiveModel; modelRegistry: ModelRegistry; signal: AbortSignal; fetch: typeof fetch };
export interface NativeAdapter { id: string; search(input: Input): Promise<NativeResult>; }

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

function authHeaders(auth: { headers?: Record<string, string | null>; apiKey?: string }): Record<string, string> {
  const headers = Object.fromEntries(Object.entries(auth.headers ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  if (!Object.keys(headers).some((name) => name.toLowerCase() === "authorization") && auth.apiKey) headers.Authorization = `Bearer ${auth.apiKey}`;
  return headers;
}

/** Select a supported OAuth Codex model without depending on the active model. */
export async function selectNativeSearch(input: { model?: ActiveModel; modelRegistry: ModelRegistry; signal: AbortSignal; fetch: typeof fetch; compatibility?: { codexClientVersion?: string } }): Promise<{ model: ActiveModel; adapter: NativeAdapter } | undefined> {
  const registry = input.modelRegistry;
  const candidates = typeof registry.getAvailable === "function" ? registry.getAvailable().filter((model) => model.provider === "openai-codex" && model.api === "openai-codex-responses" && registry.isUsingOAuth(model)) : [];
  if (!candidates.length) return undefined;
  const version = input.compatibility !== undefined ? input.compatibility.codexClientVersion : CODEX_CLIENT_VERSION;
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) return undefined;
  const auth = await registry.getApiKeyAndHeaders(candidates[0]!);
  if (!auth.ok) throw new Error("Codex native-search authentication failed.");
  input.signal.throwIfAborted();
  const response = await input.fetch(`https://chatgpt.com/backend-api/codex/models?client_version=${version}`, { method: "GET", signal: input.signal, headers: authHeaders(auth) });
  if (!response.ok) throw new Error(`Codex native-search capability request failed with HTTP ${response.status}.`);
  let body: any;
  try { body = await response.json(); } catch { throw new Error("Codex native-search capability response was malformed."); }
  if (!Array.isArray(body?.models)) throw new Error("Codex native-search capability response was malformed.");
  for (const model of candidates) {
    const matching = body.models.filter((record: any) => record !== null && typeof record === "object" && record.slug === model.id);
    if (matching.length > 1) throw new Error("Codex native-search capability response had duplicate model records.");
    if (!matching.length) continue;
    if (typeof matching[0].supports_search_tool !== "boolean") throw new Error("Codex native-search capability response had malformed model metadata.");
    if (!matching[0].supports_search_tool) continue;
    const adapter: NativeAdapter = { id: "openai-codex-responses", async search(searchInput) {
      const result = await searchInput.modelRegistry.complete(searchInput.model as never, { messages: [{ role: "user", content: buildNativeSearchPrompt(searchInput.query), timestamp: Date.now() }] }, {
        signal: searchInput.signal, fetch: searchInput.fetch,
        onPayload: (payload: unknown) => ({ ...(payload as object ?? {}), model: searchInput.model.id, store: false, stream: true, tools: [{ type: "web_search", external_web_access: true }], tool_choice: "auto" }),
      });
      if (!result || typeof result !== "object") throw new Error("Native search response was malformed.");
      const content = result.content;
      if (!Array.isArray(content)) throw new Error("Native search response was malformed.");
      const text = content.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => (part as { text: string }).text).join("\n");
      if (content.length > 0 && !text) throw new Error("Native search response had no usable text.");
      return { text, provider: searchInput.model.provider, model: searchInput.model.id };
    } };
    return { model, adapter };
  }
  return undefined;
}
