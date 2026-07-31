# Freebuff2Opencode Proxy

An unofficial, self-hosted compatibility proxy that exposes Freebuff-backed models through OpenAI-compatible and Anthropic-compatible HTTP APIs.

The project is written in TypeScript and supports Bun first, with a Node.js fallback. It includes a local dashboard for configuration, model selection, token status, and usage information.

> This project is not affiliated with, endorsed by, or operated by Freebuff, Codebuff, OpenAI, Anthropic, or any model provider.

## What It Does

- OpenAI-compatible endpoints at `/v1/chat/completions` and `/v1/models`
- Anthropic-compatible endpoints at `/v1/messages` and `/v1/messages/count_tokens`
- Streaming responses using server-sent events
- Model aliases such as `minimax-m2.7` and `deepseek-v4-pro`
- Multiple token support with health tracking and quota-aware selection
- Automatic session creation, polling, retry, and model-lock handling
- Tool schema normalization for `$ref`, `definitions`, nullable values, and enums
- Local dashboard for model and proxy configuration
- Automatic opencode provider configuration
- Bun runtime with Node.js compatibility build
- Safe local default binding at `127.0.0.1:8080`

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
  model: "minimax/m2.7",
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
    "model": "minimax/m2.7",
    "max_tokens": 128,
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

### opencode

The proxy discovers opencode configuration files and updates the provider configuration during startup. It includes enabled registry models and keeps a backup of existing configuration files.

Restart opencode after the proxy starts if the provider does not appear immediately.

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

If `API_KEYS` is configured, all routes require either `x-api-key` or `Authorization: Bearer <key>`.

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
```

`proxy.js` is the legacy monolithic implementation. New changes should target `index.ts` and `src/`.

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
