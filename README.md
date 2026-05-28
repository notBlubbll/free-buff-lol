# Freebuff2API Proxy

OpenAI- and Anthropic-compatible proxy server for Freebuff, providing free access to multiple LLM models through a unified API. Translated from the Go implementation [Freebuff2API](https://github.com/Quorinex/Freebuff2API) to Node.js/Bun.

## Features

- **OpenAI-Compatible API** — Standard `/v1/chat/completions` and `/v1/models` endpoints
- **Anthropic API Support** — `/v1/messages` and `/v1/messages/count_tokens` with automatic format conversion
- **Streaming Support** — SSE streaming for both OpenAI and Anthropic endpoints
- **Multi-Token Rotation** — Round-robin across multiple auth tokens with automatic CLI token detection
- **Dynamic Model Registry** — Fetches available models from Freebuff source code on GitHub
- **Free Session Management** — Automatic session handling with queue/waiting room and model-lock support
- **Run Chain Management** — Dual run chains (normal + gemini) with automatic finalization
- **Tool Schema Normalization** — Resolves `$ref` and `definitions` in tool schemas before forwarding
- **Dashboard UI** — Liquid glass effects, Bing wallpaper, OAuth flow, toggleable models
- **Ad Integration** — Fetches and displays upstream ads in the dashboard
- **Version Auto-Update** — Tracks Bun, Freebuff CLI, and SDK versions from upstream sources
- **Auto-Config** — Automatically configures opencode provider on startup

## Available Models

The proxy fetches models from Freebuff's TypeScript source. Current models:

| Model | Agent ID |
|-------|----------|
| `minimax/minimax-m2.7` | `base2-free` |
| `moonshotai/kimi-k2.6` | `base2-free-kimi` |
| `deepseek/deepseek-v4-pro` | `base2-free-deepseek` |
| `deepseek/deepseek-v4-flash` | `base2-free-deepseek-flash` |

Models are toggleable in the dashboard UI.

## Authentication

Freebuff requires authentication via GitHub OAuth. There are **three ways** to get tokens:

### Method 1: Freebuff CLI (Recommended)

```bash
npm install -g freebuff
freebuff
```

The CLI will guide you through GitHub OAuth login. After authentication, tokens are saved to:
- **Windows**: `C:\Users\<username>\.config\manicode\credentials.json`
- **Linux/macOS**: `~/.config/manicode/credentials.json`

The proxy automatically detects and loads these tokens on startup.

### Method 2: Dashboard OAuth UI

1. Start the proxy: `node proxy.js`
2. Open dashboard: `http://localhost:8080`
3. Click "Generate Auth Token" in the token status section
4. Click the login URL (opens browser)
5. Authenticate with GitHub at freebuff.com
6. Token is automatically added to config via polling

### Method 3: Manual Configuration

1. Visit https://freebuff.llm.pm
2. Complete GitHub OAuth login
3. Copy your auth token
4. Add to `.config/config.json`:

```json
{
  "AUTH_TOKENS": ["your-token-here"]
}
```

## Installation

```bash
cd FREEBUFF-PROXY
npm install
node proxy.js
```

Or with Bun:
```bash
bun run proxy.js
```

Or use the Windows launchers:
```bash
start.cmd          # Auto-detects Bun, falls back to Node.js
start-node.cmd     # Forces Node.js
```

## Configuration

Edit `.config/config.json` or set environment variables:

| Key | Description | Default |
|-----|-------------|---------|
| `LISTEN_ADDR` | Proxy listen address | `:8080` |
| `UPSTREAM_BASE_URL` | Freebuff backend URL | `https://www.codebuff.com` |
| `AUTH_TOKENS` | Freebuff auth tokens (array) | `[]` |
| `REQUEST_TIMEOUT` | Upstream request timeout | `15m` |
| `API_KEYS` | Client API keys for proxy auth | `[]` (open access) |

Environment variables override JSON config values.

## Usage

### OpenAI-Compatible Clients

Point your client to `http://localhost:8080/v1`:

```javascript
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'http://localhost:8080/v1',
  apiKey: 'not-needed'
});

const response = await client.chat.completions.create({
  model: 'minimax/minimax-m2.7',
  messages: [{ role: 'user', content: 'Hello!' }]
});
```

### Anthropic-Compatible Clients

```javascript
const response = await fetch('http://localhost:8080/v1/messages', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: 'deepseek/deepseek-v4-pro',
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'Hello!' }]
  })
});
```

### opencode Integration

Add the following to your `opencode.json` (located at `~/.config/opencode/opencode.json` or `./opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "freebuff": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Freebuff Proxy",
      "options": {
        "baseURL": "http://localhost:8080/v1"
      }
    }
  }
}
```

Restart opencode after editing the config file.

## Dashboard

Access the dashboard at `http://localhost:8080`:

- **Liquid Glass Effects** — SVG displacement maps with canvas-generated refraction profiles
- **Bing Wallpaper** — Daily rotating backgrounds via peapix.com
- **OAuth Token Generation** — Browser-based authentication with auto-polling
- **Toggleable Models** — Enable/disable models with checkboxes
- **Token Status** — View active tokens, sessions, instance IDs, country code, and remaining session time with live countdown
- **Country Display** — Shows the upstream server's country code (e.g. `DE`) from the session response
- **Session Countdown** — Live `Xm Ys left` countdown in the Auth Token Status header, updated every second
- **Ad Integration** — Gravity ad provider with 30s rotation, impression tracking, toggleable display, and localStorage caching
- **SS Mode** — Blur tokens for screenshots
- **Configuration Forms** — Edit listen address, upstream URL, timeouts

## API Endpoints

### Core API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/healthz` | Health check with token and session status |
| `GET` | `/v1/models` | OpenAI models list |
| `POST` | `/v1/chat/completions` | OpenAI chat completions (streaming supported) |
| `POST` | `/v1/messages` | Anthropic messages (auto-converted to OpenAI) |
| `POST` | `/v1/messages/count_tokens` | Anthropic token counting |

### Management API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/config` | Get current configuration |
| `POST` | `/api/config` | Update configuration |
| `GET` | `/api/tokens` | List configured tokens (masked) |
| `POST` | `/api/auth/start` | Start OAuth flow |
| `POST` | `/api/auth/status` | Check OAuth status (auto-saves token) |
| `GET` | `/api/models` | List models from registry |
| `GET` | `/api/bg` | Get Bing wallpaper URL |
| `GET` | `/api/ads` | Fetch upstream ads |
| `POST` | `/api/ads/impression` | Record ad impression |

## Architecture

```
proxy.js (~1317 lines)
├── Version Tracking     — Auto-updates Bun/CLI/SDK versions from upstream
├── Config System        — JSON + env vars + CLI token auto-detection
├── ModelRegistry        — Parses TypeScript sources from GitHub
├── UpstreamClient       — HTTP client for Freebuff backend
├── TokenPool            — Session management with mutex locking
├── Run Chain Helpers    — Normal and Gemini run lifecycle
├── Tool Schema Norm.    — $ref resolution and schema normalization
├── HTTP Handlers        — OpenAI + Anthropic + management endpoints
├── OAuth Flow           — Browser-based GitHub authentication
└── Server Startup       — Validation, prewarm, token reload loop

dashboard.html (961 lines)
├── Liquid Glass Engine  — Canvas-based displacement/specular maps
├── OAuth UI             — Token generation with polling
├── Model Manager        — Toggleable model checkboxes
├── Ad System            — Upstream ads with impression tracking
└── Configuration UI     — Settings forms
```

## Startup Flow

1. `loadConfig()` — Load `.config/config.json` + env vars
2. `loadFreebuffCLITokens()` — Auto-detect CLI tokens from `~/.config/manicode/credentials.json`
3. `checkAndUpdateVersions()` — Fetch latest versions from upstream sources
4. `ModelRegistry.start()` — Fetch and parse model definitions from GitHub
5. `validateAllTokens()` — Verify each token via `createSession()`
6. `TokenPool` — Initialize with valid tokens
7. `http.createServer()` — Start HTTP server
8. `setInterval` — Token reload check every 5 minutes
9. `setInterval` — Version check every 1 hour

## Troubleshooting

### No Valid Tokens

If you see "No tokens configured":
- Run `freebuff` CLI to authenticate
- Use dashboard OAuth UI
- Manually add token to `.config/config.json`

### Port Already in Use

```bash
netstat -ano | findstr :8080
taskkill /PID <pid> /F
```

Or change port in `.config/config.json`:
```json
{
  "LISTEN_ADDR": ":9000"
}
```

### Models Not Showing

Check network connectivity to GitHub:
- `https://raw.githubusercontent.com/CodebuffAI/codebuff/main/common/src/constants/free-agents.ts`
- `https://raw.githubusercontent.com/CodebuffAI/codebuff/main/common/src/constants/freebuff-models.ts`

### Syntax Errors

Multiple edits can create duplicate code blocks:
```bash
node --check proxy.js
```

## Dependencies

- `freebuff` (^0.0.96) — CLI token detection
- `node-forge` (^1.4.0) — Cryptographic operations

Plus Node.js built-ins: `fs`, `path`, `os`, `http`, `https`, `url`, `crypto`.

## Credits

- Original Go implementation: [Freebuff2API](https://github.com/Quorinex/Freebuff2API) by Quorinex
- Freebuff and Codebuff for the backend API
- [freebuff2api_rs](https://github.com/XxxXTeam/freebuff2api_rs) for version tracking

## License

MIT
