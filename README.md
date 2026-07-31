# Freebuff2Opencode Proxy

An unofficial, self-hosted compatibility proxy that exposes Freebuff-backed models through OpenAI-compatible and Anthropic-compatible HTTP APIs.

The project is written in TypeScript and supports Bun first, with a Node.js fallback. It includes a local dashboard for configuration, model selection, token status, and usage information.

> This project is not affiliated with, endorsed by, or operated by Freebuff, Codebuff, OpenAI, Anthropic, or any model provider.

## What It Does

- Exposes OpenAI-compatible chat and model endpoints.
- Exposes Anthropic-compatible messages and token-counting endpoints.
- Supports streaming responses through server-sent events and non-streaming responses.
- Accepts model aliases and canonical provider/model IDs.
- Discovers the upstream model catalog and agent mappings from GitHub every six hours, with a local fallback catalog when the registry is unavailable.
- Publishes model metadata including display names, premium status, modalities, and context/output limits.
- Filters blacklisted model families and supports configured model allowlists.
- Manages multiple authentication tokens with health tracking, persisted sessions, account metadata, and quota-aware rotation.
- Automatically loads tokens from Freebuff CLI credentials or `.config/config.json`.
- Supports browser-based OAuth onboarding from the dashboard.
- Creates, polls, refreshes, invalidates, and ends upstream sessions automatically.
- Handles waiting rooms, expired sessions, superseded sessions, required upstream updates, model locks, quota exhaustion, and model mismatch fallbacks.
- Retries rate-limited requests with progressive backoff, rotates across available tokens, and can try alternate models when all tokens are limited.
- Runs the upstream agent validation, advertising, impression, and streak flow required by the service.
- Builds and finalizes normal, context-pruner, and Gemini parent/child run chains.
- Normalizes messages, tool schemas, JSON Schema references, nullable fields, types, and enums for upstream compatibility.
- Normalizes reasoning parameter names and injects the required Freebuff request metadata.
- Supports limited-model routing through an optional Cloudflare WARP SOCKS5 tunnel, with direct-connection fallback.
- Provides a local operations dashboard for authentication, model selection, quota, token health, sessions, events, ads, and diagnostics.
- Automatically discovers and updates opencode provider configuration files, including model limits, modalities, premium labels, backups, and manual model removals.
- Exposes health, usage, event, model mismatch, account, quota, and runtime information through local endpoints.
- Uses safe local defaults, request-size limits, authentication middleware, HTTP timeouts, redacted configuration responses, and graceful shutdown.

## Important Notice

This proxy forwards prompts and responses through upstream services. Do not use it with confidential code, credentials, personal data, or other sensitive material unless you understand the relevant provider policies.

Model availability, quotas, account requirements, deployment windows, and upstream API behavior can change without notice. Some providers may collect request data for service improvement or training.

You are responsible for:

- complying with the terms and policies of every upstream service;
- protecting your authentication tokens and proxy API keys;
- securing the proxy before binding it to a network interface;
- checking model-specific data handling and retention policies.

## Requirements

- Bun 1.3 or newer, recommended; or
- Node.js 20 or newer for the compiled fallback
- An authenticated Freebuff account/token where required by the upstream service

## Installation

```bash
git clone <repository-url>
cd free-buff-lol
bun install
bun run start
```

The dashboard opens at:

```text
http://127.0.0.1:8080
```

On Windows, the launchers are also available:

```cmd
start.cmd
start-node.cmd
```

To run with Node.js instead of Bun:

```bash
npm run start:node
```

## Authentication Tokens

The proxy can read tokens from the Freebuff CLI credentials file:

- Windows: `%USERPROFILE%\.config\manicode\credentials.json`
- Linux/macOS: `~/.config/manicode/credentials.json`

You can also configure tokens manually in `.config/config.json`:

```json
{
  "AUTH_TOKENS": ["your-token-here"]
}
```

Never commit `.config/config.json`, credentials files, or tokens. These paths are ignored by Git, but always verify `git diff` before publishing changes.

### Dashboard OAuth

Open the dashboard and use the authentication controls to start the OAuth/device flow. The dashboard polls the status endpoint and saves a newly returned token automatically. Duplicate tokens are not added twice. The local endpoints used by this flow are `POST /api/auth/start` and `POST /api/auth/status`.

The proxy also discovers credentials in common user locations and watches for changes so tokens added through the supported CLI can be loaded without manually editing the configuration. Token records may include a display email, account ID, temporary-account status, and account quota information.

## Configuration

Configuration is stored in `.config/config.json`. The directory and file are created when needed.

```json
{
  "LISTEN_ADDR": "127.0.0.1:8080",
  "UPSTREAM_BASE_URL": "https://www.codebuff.com",
  "AUTH_TOKENS": [],
  "API_KEYS": [],
  "REQUEST_TIMEOUT": "15m",
  "ENABLED_MODELS": [],
  "LOG_LEVEL": "info",
  "TOKEN_REVALIDATE_INTERVAL": "5m"
}
```

| Setting | Description | Default |
| --- | --- | --- |
| `LISTEN_ADDR` | Bind address and port | `127.0.0.1:8080` |
| `UPSTREAM_BASE_URL` | Upstream service URL | `https://www.codebuff.com` |
| `AUTH_TOKENS` | Upstream authentication tokens | `[]` |
| `API_KEYS` | Keys required by clients connecting to the proxy | `[]` |
| `REQUEST_TIMEOUT` | Upstream request timeout | `15m` |
| `ENABLED_MODELS` | Models written to the opencode provider config | all available models |
| `LOG_LEVEL` | `error`, `warn`, `info`, or `debug` | `info` |
| `TOKEN_REVALIDATE_INTERVAL` | Token health revalidation interval | `5m` |
| `MOCK_COUNTRY` | Override country detection for testing | unset |

Environment variables override values from the JSON file:

```bash
API_KEYS=replace-with-a-random-key bun run start
```

To allow access from another trusted device, configure an explicit non-loopback address and API key:

```json
{
  "LISTEN_ADDR": "0.0.0.0:8080",
  "API_KEYS": ["replace-with-a-long-random-key"]
}
```

Do not expose the proxy to the public internet without additional network controls such as a firewall, reverse proxy, TLS, and authentication.

## Client Usage

### OpenAI-Compatible

Set the base URL to `http://127.0.0.1:8080/v1`:

```javascript
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://127.0.0.1:8080/v1",
  apiKey: "not-needed"
});

const response = await client.chat.completions.create({
  model: "minimax/minimax-m2.7",
  messages: [{ role: "user", content: "Hello" }]
});

console.log(response.choices[0].message.content);
```

When `API_KEYS` is configured, use the proxy key as the client API key.

### Anthropic-Compatible

```bash
curl http://127.0.0.1:8080/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "minimax/minimax-m2.7",
    "max_tokens": 128,
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

### opencode

The proxy discovers opencode configuration files on the machine and updates the provider configuration during startup. It includes enabled registry models, writes model modalities and limits, marks premium models with a `[LIM]` name prefix, and keeps a backup of existing configuration files. Existing provider models removed manually from opencode configuration are reconciled back into `ENABLED_MODELS`.

Restart opencode after the proxy starts if the provider does not appear immediately.

The provider is generated for the active model registry. If the registry cannot be reached, the proxy uses its built-in fallback catalog. Set `ENABLED_MODELS` to limit which models are written.

## Supported Models

The live model list is controlled by the upstream registry and can change over time. The local fallback catalog currently includes:

| Model ID | Display name | Input |
| --- | --- | --- |
| `deepseek/deepseek-v4-pro` | DeepSeek V4 Pro | Text, image |
| `deepseek/deepseek-v4-flash` | DeepSeek V4 Flash | Text |
| `mimo/mimo-v2.5-pro` | MiMo 2.5 Pro | Text, image |
| `mimo/mimo-v2.5` | MiMo 2.5 | Text, image |
| `moonshotai/kimi-k2.6` | Kimi K2.6 | Text, image |
| `minimax/minimax-m3` | MiniMax M3 | Text, image, video |
| `minimax/minimax-m2.7` | MiniMax M2.7 | Text |
| `google/gemini-3.1-flash-lite-preview` | Gemini 3.1 Flash Lite | Text, image |
| `google/gemini-3.1-pro-preview` | Gemini 3.1 Pro | Text, image |

Aliases such as `minimax-m2.7`, `deepseek-v4-pro`, `mimo-v2.5`, `kimi-k2.6`, `gemini-3.1-flash-lite`, and `gemini-3.1-pro` are normalized to canonical IDs. Use `GET /v1/models` or `GET /api/models` for the current live catalog.

Some models are premium or limited upstream. When a limited session is created, the proxy can start the WARP Plus helper automatically and route that chat request through its local SOCKS5 endpoint. If WARP is unavailable, the request falls back to a direct connection when possible.

## HTTP API

### Compatibility endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/models` | List available models |
| `POST` | `/v1/chat/completions` | OpenAI-compatible chat completion |
| `POST` | `/v1/messages` | Anthropic-compatible messages |
| `POST` | `/v1/messages/count_tokens` | Approximate token count |

### Local management endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/` | Dashboard |
| `GET` | `/healthz` | Runtime and token health |
| `GET` | `/api/config` | Safe, redacted configuration summary |
| `POST` | `/api/config` | Update supported non-secret settings |
| `GET` | `/api/tokens` | List masked configured tokens |
| `GET` | `/api/models` | Registry models and metadata |
| `GET` | `/api/usage` | Token usage and quota summary |
| `GET` | `/api/events` | Recent server events |
| `POST` | `/api/session/unlock` | Clear cached model locks |
| `POST` | `/api/auth/start` | Start dashboard OAuth/device authentication |
| `POST` | `/api/auth/status` | Poll OAuth status and add a returned token |
| `GET` | `/api/bg` | Get the dashboard background image URL |
| `GET` | `/api/ads` | Fetch dashboard/waiting-room ads |
| `POST` | `/api/ads/impression` | Record an ad impression |

If `API_KEYS` is configured, all routes require either `x-api-key` or `Authorization: Bearer <key>`.

`/api/config` never returns token or API-key values. It exposes counts and supported runtime settings only, and configuration updates accept only non-secret settings. Request bodies are limited to 10 MiB. Unsupported routes return JSON errors in the appropriate OpenAI or Anthropic format.

### Health and usage data

`/healthz` reports uptime, runtime and runtime version, model count, token health, session state, account information, country, access tier, remaining session time, locked models, rate limits, aggregate usage, recent events, and recent model mismatches. Tokens are masked in responses.

`/api/usage` provides per-token quota data such as recent usage, limits, reset times, entitlement, account metadata, and health. The dashboard uses this data for live quota bars, reset countdowns, burn rate, depletion estimates, and availability indicators.

`/api/events` exposes recent operational events such as rate limits, model switches, session invalidation, and upstream errors. It supports `limit` and `since` query parameters.

## Development

Install dependencies and run the checks:

```bash
bun install
bun run check
bun test
bun run check:style
```

Useful commands:

```bash
bun run dev          # watch mode
bun run build        # compile for Node.js
bun run start:node   # run compiled output
```

Tests must run without real upstream tokens. Add new behavior behind unit tests or mocked upstream responses rather than relying on a live account.

The application starts by loading configuration and CLI tokens, checking version information, refreshing the model registry, discovering opencode files, validating configured tokens, and then starting the HTTP server. Background tasks reload CLI tokens, refresh model metadata, revalidate token health, refresh session quotas, persist state, and check versions. `SIGINT` and `SIGTERM` stop the HTTP server and dispose of these timers cleanly.

## Project Structure

```text
index.ts                Application startup and dependency wiring
src/core.ts             Constants, logging, aliases, shared utilities
src/http/handlers.ts    HTTP routing and request handlers
src/config/             Configuration and persistent state
src/models/             Dynamic model registry
src/tokens/             Token validation, accounts, and token pool
src/upstream/           Upstream client and run-chain lifecycle
src/requests/            Request conversion, tools, responses, and errors
dashboard.html            Local operations dashboard
proxy.js                  Legacy monolithic implementation
```

`proxy.js` is the legacy monolithic implementation. New changes should target `index.ts` and `src/`.

Runtime state is stored in `.config/state.json` and includes active session information, model locks, token health, and usage data so the proxy can recover useful state after a restart. A configuration backup is created as `.config/config.backup.json` on the first configuration write.

## Troubleshooting

### The dashboard does not open

Check that the process is running and request the health endpoint:

```bash
curl http://127.0.0.1:8080/healthz
```

Check whether another process is using the configured port. Change `LISTEN_ADDR` if necessary.

### No tokens are available

Authenticate with the supported upstream CLI or add a token through `.config/config.json`. The dashboard and `/healthz` endpoint show masked token health and validation status.

### A model is unavailable

Model availability is controlled by the upstream registry and account/session limits. Check `/v1/models`, refresh the model registry, and inspect the health response for quota or model-lock information.

If a token is bound to another model, the proxy first attempts to end the locked session and retry the requested model. If the upstream still enforces the lock, it records the mismatch and continues with the model accepted by the upstream. You can clear cached locks from the dashboard or with `POST /api/session/unlock`.

### Requests are rate limited

The proxy skips banned, unauthorized, or quota-full tokens, prefers tokens with the most remaining quota, and rotates through the rest. It retries upstream HTTP 429 responses up to three times with 3, 6, and 9 second delays. When every token is limited for the requested model, it may try another available non-Gemini model and records the fallback in the event log.

### A limited model fails

Limited sessions may require the WARP Plus helper and a suitable exit country. Check `/healthz` for access tier, country, remaining session time, and country block details. The proxy tests the SOCKS5 connection and falls back to direct upstream access if the tunnel cannot be used.

### Need more diagnostics

Set `LOG_LEVEL` to `debug` temporarily. Debug logs may contain upstream request metadata, so review logs before sharing them publicly.

## Contributing

Contributions are welcome. Before opening a pull request:

1. Explain the problem and proposed behavior.
2. Keep changes focused and avoid unrelated formatting rewrites.
3. Add or update tests for behavior changes.
4. Run `bun run check`, `bun test`, and `bun run check:style`.
5. Never include tokens, API keys, credentials, logs with private data, or generated local configuration.

For bugs, include the runtime, operating system, command used, endpoint, status code, and a redacted log excerpt. Do not include request bodies or secrets.

## License

MIT. See `LICENSE` when present in the repository.
