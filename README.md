# pi-web-search

A standalone Pi extension that provides one agent tool: `web_search`.

## Install

The aggregate implementation is `pi-web-search@0.1.0`.

```bash
npm_config_registry=http://localhost:4873 pi install -l npm:pi-web-search@0.1.0
```

Start Pi after installation. Pi loads the TypeScript package entrypoint in `index.ts`. The extension has no provider SDK or HTTP runtime dependency. Pi and TypeBox are peer dependencies.

## Agent tool

The call shape is:

```json
{ "query": "Pi Search resolver architecture", "limit": 10 }
```

`query` must be a non-empty string. `limit` is optional and must be an integer from 1 to 20. It controls only the appended external result list; it never truncates native model text. Text beginning with `web:` is ordinary query text.

Every ready configured external provider starts concurrently. Native capability lookup also starts without delaying external work. If the active Pi model has a supported native path, its native search joins the same aggregate. The final text contains the usable parts only:

1. unchanged native model prose first, when native search returns usable text;
2. one blank line, then a globally ranked, canonicalized, and deduplicated numbered list from external providers, when external results are usable.

Either part may appear alone. Public text has no headings or provider/model metadata. Native search is asked for its best immediate, self-contained answer, with useful citations when available and without follow-up questions, requests for more information, process commentary, or conversational filler. Native text is not parsed or ranked as external result items, and an external URL cited by native prose remains in the external list.

Each external snippet is rendered on one line as `Excerpt: “<text>”`. Markdown and HTML structure is removed, whitespace is collapsed, and unsafe terminal and bidirectional presentation controls are neutralized in snippets, titles, displayed URLs, and source labels. The package does not summarize or truncate snippets and does not add ellipses; ellipses already present in provider text remain. Structured details keep the original canonical result data, aggregate timing, limits, migration warnings, each external attempt, native identity and status, bounded failure details, timeout reasons, results, and truncation state.

## Providers and aggregation

Supported external providers are Exa, Tavily, Brave, DuckDuckGo HTML, Serper, Parallel, Google CSE, Z.AI, OpenAI, Codex, Anthropic, Perplexity, xAI, and Kimi. Every enabled provider with valid settings and available credentials runs. DuckDuckGo HTML remains the zero-configuration default.

External results rank by the number of distinct sources that found the canonical page, then normalized position, optional provider scores when comparable, and canonical URL. Canonicalization removes fragments, one empty trailing slash from non-root paths, and the known tracking parameters `utm_*`, `gclid`, `fbclid`, `dclid`, `msclkid`, `mc_cid`, and `mc_eid`. Root URLs, meaningful repeated slashes, and other query parameters are preserved. Only HTTP and HTTPS results are returned.

Native search is automatic and may add provider and model charges. There is no per-call cost budget or native enable switch. The configured external-provider set is the external cost control. Current native eligibility is fail-closed:

- OpenAI Responses supports `gpt-5.6`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, `gpt-5.5-pro`, `gpt-5.5-2026-04-23`, `gpt-5.5-pro-2026-04-23`, `gpt-5.4`, `gpt-5.4-pro`, `gpt-5.4-mini`, `gpt-5.4-nano`, `gpt-5.4-2026-03-05`, `gpt-5.4-pro-2026-03-05`, `gpt-5.4-mini-2026-03-17`, `gpt-5.4-nano-2026-03-17`, `gpt-4.1`, `gpt-4.1-mini`, and `o4-mini`.
- Gemini Google Search supports `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.5-flash-lite`, `gemini-3-flash-preview`, `gemini-3-pro-image`, `gemini-3.1-pro-preview`, `gemini-3.1-flash-image`, `gemini-3.1-flash-lite`, `gemini-3.5-flash`, `gemini-3.5-flash-lite`, `gemini-3.6-flash`, and `gemini-3.7-flash`.
- DeepSeek Responses supports `deepseek-v4-flash`, `deepseek-v4-pro`, and `deepseek-v4-flash-vision-exp` through the documented Responses path.
- Xiaomi MiMo supports `mimo-v2.5` and `mimo-v2.5-pro` through Chat Completions.
- Direct Anthropic Messages and direct xAI Responses are eligible by provider/API. Provider or model rejection is reported as a native-source failure.
- Codex is eligible only when its runtime catalog has one exact active-model record with `supports_search_tool: true`.
- OpenRouter is eligible only when exact active-model endpoint metadata has an array-valued `supported_parameters` containing `tools`.
- OpenCode Go and Zen gateways are not native-search eligible. An upstream model name or OpenAI-compatible request shape is not treated as proof of hosted search support.

Provider capability and model availability change. The package fails closed when static IDs or dynamic metadata do not prove support and never substitutes another model.

The default per-source timeout is 30 seconds. For native search, that single timeout covers capability acquisition and completion together. The default aggregate deadline is 45 seconds and cancels unfinished capability, native, and external work. Caller cancellation takes precedence over partial results and aborts every child operation.

A usable native answer or external result list makes the aggregate operationally successful even when another source fails or times out. Partial failures stay out of normal successful text and remain in structured diagnostics. Empty or whitespace-only source output is omitted. If neither side is usable, including when no source is eligible or all sources return empty, the caller receives exactly `Web search failed: all eligible sources failed or timed out. All configured search providers failed.`

Provider HTTP errors include the status and bounded, redacted detail. A custom external-provider `baseUrl` must use public HTTPS, contain no credentials, and not target localhost or a private address.

## Configuration

The extension checks these files:

1. `<cwd>/.pi/websearch.json`
2. `~/.pi/agent/websearch.json`
3. built-in DuckDuckGo HTML defaults

A project file supplies the active configuration when present. Otherwise the global file does. The built-in default is used when neither exists. A present invalid file is an error; it is not silently skipped. Global and project entries can still supply credentials for matching provider IDs or provider names.

A configuration can use one external provider at the top level:

```json
{
  "provider": "serper",
  "maxResults": 10
}
```

Or it can define several external providers:

```json
{
  "maxResults": 10,
  "sourceTimeoutMs": 30000,
  "aggregateDeadlineMs": 45000,
  "providers": [
    { "id": "primary", "provider": "serper" },
    { "provider": "duckduckgo-html" }
  ]
}
```

Use `{ "providers": [] }` to run native search only. It succeeds only when the active model is eligible and returns usable text; otherwise the tool returns the same detailed total-failure text. Set `enabled` to `false` on an external entry to exclude it.

Top-level keys are `maxResults` (1–20), positive finite `sourceTimeoutMs`, positive finite `aggregateDeadlineMs`, and either `providers` or the fields for one provider. Provider fields are:

- `id`, `provider`, `enabled`, `apiKey`, `baseUrl`, `searchEngineId`, and `maxResults`;
- `model`, `codexMode` (`cached` or `live`), and `searchContextSize` (`low`, `medium`, or `high`);
- `allowedDomains` or `blockedDomains` (not both);
- `userLocation` with optional `country`, `region`, `city`, and `timezone`.

The old top-level `strategy`, `fallback`, and `providerOrder` fields and provider-level `priority` and `weight` fields are accepted only for migration. They do not change source selection, ordering, concurrency, or cost. The doctor command and structured search details warn until they are removed.

Provider-specific fields are sent only where that provider supports them. Google CSE also requires `searchEngineId`. All providers except DuckDuckGo HTML require credentials.

### Credentials

Credential precedence is:

1. environment;
2. matching provider in `~/.pi/agent/websearch.json`;
3. matching provider in `<cwd>/.pi/websearch.json`.

Supported standard environment names are:

- `EXA_API_KEY`
- `TAVILY_API_KEY`
- `BRAVE_SEARCH_API_KEY` or `BRAVE_API_KEY`
- `SERPER_API_KEY`
- `PARALLEL_API_KEY`
- `GOOGLE_API_KEY` and `GOOGLE_SEARCH_ENGINE_ID`
- `ZAI_API_KEY`
- `OPENAI_API_KEY` for OpenAI and Codex
- `ANTHROPIC_API_KEY`
- `PERPLEXITY_API_KEY`
- `XAI_API_KEY`
- `KIMI_API_KEY`

The retained legacy credential form is `PI_AGENT_IDE_SEARCH_<ID>_API_KEY`, where `<ID>` is the provider entry `id`, or the provider name when no ID is set. Non-alphanumeric characters become underscores and the name is uppercased. This legacy name is checked before the provider's standard environment name.

## Doctor command

Run `/pi-web-search-doctor` in Pi to check external-provider configuration for the active working directory. The command does not search, probe native-model capability, change configuration, or register another agent tool. It reports:

- `PASS` for loaded configuration and external providers with available credentials;
- `WARN` for obsolete routing fields or an external provider that is disabled or lacks credentials;
- `FAIL` for invalid JSON, provider configuration, limits, deadlines, or unsafe endpoints.

The report is redacted. It checks only whether an external credential is present and never prints its value.

## Public API

The public Pi extension entrypoint is the default export from `index.ts`. Loading it registers `web_search` and the user command `/pi-web-search-doctor`. The modules under `src/` are package-owned implementation details. The extension adds no skill or separate agent guide; all agent guidance is in the tool description.

## Development checks

The default checks do not need an installed package:

```bash
pnpm install
pnpm test
pnpm run typecheck
pnpm run pack:check
```

`pnpm test` runs the deterministic standalone suite. `pack:check` checks the archive contents. Tests and fixtures stay outside the published archive.

Installed-package verification is separate and mandatory before release. Keep the archive under `.lpt/package-archives/`, install it into an isolated workspace, then point verification at the installed entrypoint:

```bash
ARCHIVE="$PWD/.lpt/package-archives/release-0.1.0/pi-web-search-0.1.0.tgz"
# Install $ARCHIVE into the isolated release workspace first.
PI_WEB_SEARCH_INSTALLED_EXTENSION="$PWD/.agents/tmp/release-0.1.0/workspace/.pi/npm/node_modules/pi-web-search/index.ts" \
  pnpm run verify:package
```

`verify:package` fails when the variable is missing. It runs `pack:check` and the real-Pi installed-package scenario. Never store a `.tgz` archive under `.agents/` or leave an active configuration or script pointing there. Pi discovers package archives below `.agents/` during startup, so either case can prevent Pi from starting.

## Local-registry release

Direct `npm publish` is blocked by `prepublishOnly`. The supported release command packs one archive, installs that exact archive in an isolated Pi home, runs the mandatory package verification, writes a hash-bound manifest, and publishes the same archive to local Verdaccio:

```bash
pnpm run release:verdaccio
```

The command accepts only localhost or `127.0.0.1` registries. `PI_WEB_SEARCH_RELEASE_REGISTRY` overrides the default `http://localhost:4873`. Verdaccio credentials come from `../.local-registry/npmrc` unless `PI_WEB_SEARCH_RELEASE_NPMRC` overrides the path.

The release archive is retained under `.lpt/package-archives/release-<version>/`. The isolated install workspace and verification manifest stay under `.agents/tmp/release-<version>/`, but that tree must remain free of `.tgz` files. Public npm publication is not part of this workflow.
