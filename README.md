# pi-web-search

A standalone Pi extension that provides one agent tool: `web_search`.

## Install

ALE-30 verified `pi-web-search@0.1.8` through the local Verdaccio registry. Public npm publication is outside this work and has not been verified.

```bash
npm_config_registry=http://localhost:4873 pi install -l npm:pi-web-search@0.1.8
```

Start Pi after installation. Pi loads the TypeScript package entrypoint in `index.ts`. The extension has no provider SDK or HTTP runtime dependency. Pi and TypeBox are peer dependencies.

## Agent tool

The exact call shape is:

```json
{ "query": "Pi Search resolver architecture" }
```

`query` is the only field. It must be a non-empty string. Do not add a selector. There is no per-call `limit`; provider configuration controls the result count. Text beginning with `web:` is passed to the provider as ordinary query text.

Use the tool for current public information that is not available in the workspace, such as documentation, versions, errors, and news. Results contain titles, HTTP(S) URLs, and optional snippets that can support citations. Reading a known URL is a separate task; use an HTTP URL reader when one is installed.

The text response starts with the query and provider, followed by numbered titles, URLs, and snippets. Structured details contain the provider, optional provider entry ID, query, results, duration, truncation state, optional routing strategy and attempts, and any answer or error returned by the search path.

## Providers and routing

Supported providers are Exa, Tavily, Brave, DuckDuckGo HTML, Serper, Parallel, Google CSE, Z.AI, OpenAI, Codex, Anthropic, Perplexity, xAI, and Kimi.

Routing supports:

- `priority`: try providers by `priority`, then configuration order;
- `round-robin`: rotate providers, using positive `weight` values when present;
- `fill-first`: start with the provider that has returned the fewest successful results, combine results, remove duplicate URLs, and stop at the configured limit.

When `fallback` is enabled, another provider can be tried after an error, an empty response, or results with no usable URLs. The default uses priority routing, fallback, DuckDuckGo HTML, and at most 10 results.

Only HTTP and HTTPS result URLs are returned. A custom `baseUrl` must use public HTTPS, must not contain credentials, and must not point to localhost or a private address. Provider HTTP errors include the status and at most 500 characters of provider detail. Malformed responses, network errors, and exhausted fallback are reported through the existing text and structured error contract. Cancelling a tool call aborts the active provider request and stops fallback.

## Configuration

The extension checks these files:

1. `<cwd>/.pi/websearch.json`
2. `~/.pi/agent/websearch.json`
3. built-in DuckDuckGo HTML defaults

A project file supplies the active routing configuration when present. Otherwise the global file does. The built-in default is used when neither exists. A present invalid file is an error; it is not silently skipped. Global and project entries can still supply credentials for matching provider IDs or provider names.

A configuration can use one provider at the top level:

```json
{
  "provider": "serper",
  "maxResults": 10
}
```

Or it can define routing across several providers:

```json
{
  "strategy": "priority",
  "fallback": true,
  "providerOrder": ["primary", "duckduckgo-html"],
  "providers": [
    {
      "id": "primary",
      "provider": "serper",
      "priority": 1,
      "maxResults": 10
    },
    {
      "provider": "duckduckgo-html",
      "priority": 2,
      "maxResults": 10
    }
  ]
}
```

Top-level keys are `strategy`, `fallback`, `providerOrder`, and either `providers` or the fields for one provider. Provider fields are:

- `id`, `provider`, `apiKey`, `baseUrl`, `searchEngineId`, and `maxResults`;
- `model`, `codexMode` (`cached` or `live`), and `searchContextSize` (`low`, `medium`, or `high`);
- `allowedDomains` or `blockedDomains` (not both);
- `userLocation` with optional `country`, `region`, `city`, and `timezone`;
- `priority` and positive `weight` for routing.

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

Run `/pi-web-search-doctor` in Pi to check configuration for the active working directory and see provider credential readiness. The command does not search, change configuration, or register another agent tool. It reports:

- `PASS` for loaded configuration and ready providers;
- `WARN` for a missing provider credential;
- `FAIL` for invalid configuration.

The report is redacted. It checks only whether a credential is present and never prints its value.

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

Installed-package verification is separate and mandatory before release. Point it at the entrypoint installed from the exact archive:

```bash
PI_WEB_SEARCH_INSTALLED_EXTENSION="$PWD/.agents/tmp/release-0.1.8/workspace/.pi/npm/node_modules/pi-web-search/index.ts" \
  pnpm run verify:package
```

`verify:package` fails when the variable is missing. It runs `pack:check` and the real-Pi installed-package scenario.

## Local-registry release

Direct `npm publish` is blocked by `prepublishOnly`. The supported release command packs one archive, installs that exact archive in an isolated Pi home, runs the mandatory package verification, writes a hash-bound manifest, and publishes the same archive to local Verdaccio:

```bash
pnpm run release:verdaccio
```

The command accepts only localhost or `127.0.0.1` registries. `PI_WEB_SEARCH_RELEASE_REGISTRY` overrides the default `http://localhost:4873`. Verdaccio credentials come from `../.local-registry/npmrc` unless `PI_WEB_SEARCH_RELEASE_NPMRC` overrides the path.

Review evidence is retained under `.agents/tmp/release-<version>/`, including the installed entrypoint and verification manifest. Public npm publication is not part of this workflow.
