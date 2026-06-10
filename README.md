# Freebuff2Opencode Proxy

OpenAI- and Anthropic-compatible proxy server for Freebuff, providing free access to multiple LLM models through a unified API. Translated from the Go implementation [Frebuff2API](https://github.com/Quorinex/Freebuff2API) to Node.js/Bun.

<img width="875" height="610" alt="image" src="https://github.com/user-attachments/assets/87d0a282-f32c-4b34-8ea5-6c52ab70ec3d" />



<img width="653" height="442" alt="image" src="https://github.com/user-attachments/assets/be4a5a3e-64f9-49c1-8ae1-0a0a52ad85cd" />

models:<br>
<img width="239" height="166" alt="image" src="https://github.com/user-attachments/assets/90e71da4-d894-4327-be83-37856118b61a" />

country detection + bypass:<br>
<img width="309" height="196" alt="image" src="https://github.com/user-attachments/assets/49dee7f4-41a7-41ca-977e-b7b716d01a84" />


## Features

- **OpenAI-Compatible API** — Standard `/v1/chat/completions` and `/v1/models` endpoints
- **Anthropic API Support** — `/v1/messages` and `/v1/messages/count_tokens` with automatic format conversion
- **Streaming Support** — SSE streaming for both OpenAI and Anthropic endpoints
- **Multi-Token Rotation** — Round-robin across multiple auth tokens with automatic CLI token detection
- **Dynamic Model Registry** — Fetches available models from Freebuff source code on GitHub
- **Free Session Management** — Automatic session handling with queue/waiting room and model-lock support
- **Run Chain Management** — Dual run chains (normal + gemini) with context-pruner child run and automatic finalization
- **Tool Schema Normalization** — Resolves `$ref` and `definitions` in tool schemas before forwarding
- **Dashboard UI** — Liquid glass effects, Bing wallpaper, OAuth flow, toggleable models
- **Ad Integration** — Fetches and displays upstream ads in the dashboard
- **Version Auto-Update** — Tracks Bun, Freebuff CLI, and SDK versions from upstream sources; shows Windows alert and exits if proxy is outdated
- **Auto-Config** — Automatically configures opencode provider on startup
- **Warp Plus Proxy** — SOCKS5 proxy via Cloudflare WARP for bypassing rate limits on limited-tier sessions
- **Request Debounce** — Global 1.3s minimum gap between requests to prevent upstream rate limiting
- **429 Retry** — Automatic retry on rate limit errors (3 attempts with progressive delay: 3s, 6s, 9s)
- **HAR-style Fingerprinting** — Sends browser-compatible headers (`Accept-Encoding`, `Connection`, `Host`) for upstream compatibility
- **Agent Validation** — Validates agent definitions with upstream before chat requests
- **Ad Chain + Streak** — Completes ad flow and streak check before session creation
- **Message Normalization** — Converts `developer` → `system`, adds `cache_control`, injects system prompt

## Available Models

The proxy fetches models from Freebuff's TypeScript source. Current models:

| Model | Agent ID | Tier | Data Training |
|-------|----------|------|---------------|
| `minimax/minimax-m2.7` | `base2-free` | Full | No |
| `minimax/minimax-m3` | `base2-free-minimax-m3` | Premium | No |
| `moonshotai/kimi-k2.6` | `base2-free-kimi` | Premium | No |
| `deepseek/deepseek-v4-pro` | `base2-free-deepseek` | Premium | **Yes** |
| `deepseek/deepseek-v4-flash` | `base2-free-deepseek-flash` | Limited | **Yes** |
| `mimo/mimo-v2.5-pro` | `base2-free-mimo-pro` | Premium | No |
| `mimo/mimo-v2.5` | `base2-free-mimo` | — | No |
| `google/gemini-2.5-flash-lite` | `base2-free-deepseek-flash` | — | No |
| `google/gemini-3.1-flash-lite-preview` | `base2-free-deepseek-flash` | — | No |
| `google/gemini-3.1-pro-preview` | `base2-free-kimi` | — | No |

The first 7 models are user-selectable in the dashboard. Gemini models are used internally as subagents for deeper reasoning.

Shortcuts (auto-resolve to full model name):
- `deepseek-v4-pro` → `deepseek/deepseek-v4-pro`
- `deepseek-v4-flash` → `deepseek/deepseek-v4-flash`
- `deepseek-v3.1-terminus` → `deepseek/deepseek-v4-pro`
- `mimo-v2.5-pro` → `mimo/mimo-v2.5-pro`
- `mimo-v2.5` → `mimo/mimo-v2.5`
- `kimi-k2.6` → `moonshotai/kimi-k2.6`
- `minimax-m2.7` → `minimax/minimax-m2.7`
- `minimax-m3` → `minimax/minimax-m3`

Models are toggleable in the dashboard UI.

## Warnings

### Data Collection & Training

**DeepSeek models collect your data for training.** The upstream Freebuff source explicitly marks both `deepseek/deepseek-v4-pro` and `deepseek/deepseek-v4-flash` with the warning: `"Collects data for training"`. This means your prompts, code, and chat content sent through these models may be used by DeepSeek to train their models.

If you are working with sensitive, proprietary, or confidential code, **avoid DeepSeek models**. Use `minimax/minimax-m2.7` or `moonshotai/kimi-k2.6` instead — these do not carry the training data warning.

### Account Ban Risk

**Using this proxy violates Freebuff's terms of service.** The upstream server explicitly rejects direct API calls:

> `403 error: "Free mode is only available through the freebuff CLI. Install it with 'npm i -g freebuff', then run 'freebuff'. Calling the API directly is not supported and may get your account banned."`

This proxy works by omitting the `cost_mode` field from requests, which bypasses the CLI-only check but does NOT make it authorized. **Your Freebuff/Codebuff account may be banned** at any time if they detect unusual usage patterns. Use at your own risk.

### What Freebuff/Codebuff Collects

Per their [Privacy Policy](https://codebuff.com/privacy-policy) and [Privacy docs](https://codebuff.com/docs/advanced/privacy):

- **Chat session logs** are stored for debugging and service improvement
- **Your codebase is not stored** — the server acts as a thin router forwarding requests to model providers
- **Usage data**: IP address, browser type, device info, page visit duration
- **Personal data**: email, name (if provided), cookies
- **Analytics**: Google Analytics, PostHog, advertising cookies
- **Data location**: transferred to and processed in the **United States**
- **Ads**: session context and basic profile data are used for ad targeting

They state they do not choose model providers that train on your data in standard modes — **but DeepSeek is an exception** (see above).

### Limited Mode

Freebuff has two access tiers that determine which models you can use:

| Tier | Available Models | Session Limit |
|------|-----------------|---------------|
| **Limited** | `deepseek/deepseek-v4-flash` only | 5/day |
| **Full** | All 5 models | 5/day |

Both tiers share the same session limit: **5 sessions per day**, resetting at **midnight Pacific time**.

Within the full tier, two models are marked as **premium** and may require additional access:
- `deepseek/deepseek-v4-pro` (Smartest) — Premium, **collects data for training**
- `moonshotai/kimi-k2.6` (Balanced) — Premium
- `minimax/minimax-m3` — Premium
- `mimo/mimo-v2.5-pro` — Premium
- `minimax/minimax-m2.7` (Fastest) — Non-premium
- `deepseek/deepseek-v4-flash` (Most efficient) — Non-premium, **collects data for training**
- `mimo/mimo-v2.5` — Non-premium

New freebuff users typically start in **limited tier**, which only allows `deepseek/deepseek-v4-flash` — the model that collects data for training. To access all models, you need full tier access.

When the upstream returns a `session_model_mismatch` error (e.g., requesting `minimax/minimax-m2.7` on a limited-tier session), the proxy automatically switches to `deepseek/deepseek-v4-flash` and retries. This is transparent to the client.

For limited-tier sessions, the proxy also attempts to route requests through a **Warp Plus** SOCKS5 proxy (Cloudflare WARP) to bypass rate limits. If Warp Plus fails to start or connect, the proxy falls back to direct connection.

### Deployment Hours

Models are available during deployment hours: **9am ET to 5pm PT every day**. Outside these hours, requests may be rejected or routed to the fallback model (`minimax/minimax-m2.7`).

### Session States

Sessions can be in various states:
- `active` — Ready to use
- `queued` — Waiting in queue (polled until active)
- `ended` — Session expired (proxy auto-recreates)
- `superseded` — Replaced by a newer session (proxy auto-recreates)
- `disabled` — No session needed

The proxy handles all these states automatically — queued sessions are polled until active, and ended/superseded sessions are recreated transparently.

### Supported Countries

Freebuff is available **globally** in 85+ countries. The [live map](https://freebuff.com/live) shows real-time usage. Top countries include:

| Country | Active Users |
|---------|-------------|
| India | 119 |
| United States | 54 |
| Germany | 29 |
| Spain | 29 |
| China | 22 |
| Indonesia | 19 |
| United Kingdom | 19 |
| France | 18 |
| Vietnam | 15 |
| Canada | 12 |

The proxy dashboard displays the upstream server's `country_code` (e.g. `DE`) from the session response. Availability may vary by region and time of day.

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
| `OUTBOUND_PROXY` | SOCKS5/HTTP proxy for outbound requests | `null` |
| `DISABLED_MODELS` | Models to exclude from opencode provider config | `[]` |

Environment variables override JSON config values.

### Setting Up API Keys

By default the proxy is open access — any client can connect. To restrict access, set `API_KEYS` in `.config/config.json`:

```json
{
  "API_KEYS": ["my-secret-key-1", "my-secret-key-2"]
}
```

Or via environment variable (comma-separated):

```bash
set API_KEYS=my-secret-key-1,my-secret-key-2
node proxy.js
```

Clients must then include the key in requests:

```bash
# Using x-api-key header
curl -H "x-api-key: my-secret-key-1" http://localhost:8080/v1/models

# Using Authorization header
curl -H "Authorization: Bearer my-secret-key-1" http://localhost:8080/v1/models
```

Generate a random key:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

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

The proxy **automatically configures** the opencode provider on startup. It writes to `~/.config/opencode/opencode.json` (and `~/.opencode/opencode.json` on Windows).

The auto-config:
- Includes only **non-disabled models** (respects `DISABLED_MODELS` in config)
- Prefixes premium model display names with `[LIM]` (matching the dashboard convention)
- Creates a backup (`openconfig.b4freebuff.json`) on first run
- **Detects manual model removals** from opencode.json and syncs them into `DISABLED_MODELS` in `.config/config.json`

To disable models, use the dashboard toggle or set `DISABLED_MODELS` in `.config/config.json`:

```json
{
  "DISABLED_MODELS": ["deepseek/deepseek-v4-pro"]
}
```

Restart opencode after the proxy starts.

## Dashboard

Access the dashboard at `http://localhost:8080`:

- **Liquid Glass Effects** — SVG displacement maps with canvas-generated refraction profiles
- **Bing Wallpaper** — Daily rotating backgrounds via peapix.com
- **OAuth Token Generation** — Browser-based authentication with auto-polling
- **Toggleable Models** — Enable/disable models with checkboxes; changes persist to `.config/config.json` and propagate to opencode provider on restart
- **Token Status** — View active tokens, sessions, instance IDs, country code, and remaining session time with live countdown
- **Country Display** — Shows the upstream server's country code (e.g. `DE`) from the session response, with `>US` indicator when Warp Plus proxy is active
- **Session Countdown** — Live `Xm Ys left` countdown in the Auth Token Status header, updated every second
- **Ad Integration** — Gravity ad provider via upstream `/api/v1/ads` (surface: `waiting_room`), 30s rotation, impression tracking (`/api/v1/ads/impression`), toggleable display (checkbox in dashboard), and localStorage caching
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
proxy.js (~2218 lines)
├── Version Tracking     — Auto-updates Bun/CLI/SDK versions from upstream
├── Config System        — JSON + env vars + CLI token auto-detection
├── ModelRegistry        — Parses TypeScript sources from GitHub
├── UpstreamClient       — HTTP client with HAR-style headers, agent validation, ad chain
├── TokenPool            — Session management with mutex locking
├── WarpPlusManager      — SOCKS5 proxy via warp-plus binary for rate limit bypass
├── Run Chain Helpers    — Normal (with context-pruner) and Gemini run lifecycle
├── Message Normalization — developer→system, cache_control, Buffy prompt injection
├── Tool Schema Norm.    — $ref resolution and schema normalization
├── HTTP Handlers        — OpenAI + Anthropic + management endpoints
├── OAuth Flow           — Browser-based GitHub authentication
└── Server Startup       — Validation, prewarm, token reload loop

dashboard.html (1023 lines)
├── Liquid Glass Engine  — Canvas-based displacement/specular maps
├── OAuth UI             — Token generation with polling
├── Model Manager        — Toggleable model checkboxes
├── Ad System            — Upstream ads with impression tracking
└── Configuration UI     — Settings forms
```

## Startup Flow

1. `loadConfig()` — Load `.config/config.json` + env vars (auto-creates `.config/` if missing)
2. `loadFreebuffCLITokens()` — Auto-detect CLI tokens from `~/.config/manicode/credentials.json`
3. `checkAndUpdateVersions()` — Fetch latest versions from upstream sources
4. `ModelRegistry.start()` — Fetch and parse model definitions from GitHub
5. `setupOpencodeConfig()` — Write opencode provider config (respects `DISABLED_MODELS`, adds `[LIM]` for premium models, detects manual model removals and syncs to config)
6. `validateAllTokens()` — Verify each token via `createSession()`
7. `TokenPool` — Initialize with valid tokens
8. `http.createServer()` — Start HTTP server
9. `setInterval` — Token reload check every 5 minutes
10. `setInterval` — Version check every 1 hour

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

### Warp Plus Issues

If Warp Plus fails to start or the SOCKS5 proxy on port 8086 is not reachable:
- The proxy automatically falls back to direct connection
- Check if another process is using port 8086
- The `warp-plus.exe` binary is downloaded automatically on first use
- The last working WARP endpoint (IP:port) is cached and reused on restart; if connectivity fails, the cache is cleared and a new endpoint is fetched

### Model Lock Errors

If you see `session_model_mismatch` errors:
- Your session is in **limited tier** — only `deepseek/deepseek-v4-flash` is available
- The proxy automatically switches to this model and retries
- No user action needed — this is handled transparently

## Dependencies

- `freebuff` (^0.0.96) — CLI token detection
- `node-forge` (^1.4.0) — Cryptographic operations
- `node-fetch` (^2.7.0) — HTTP client with SOCKS5 proxy support
- `socks-proxy-agent` (^8.0.0) — SOCKS5 proxy agent for Warp Plus
- `https-proxy-agent` (^9.1.0) — HTTP CONNECT proxy support
- `socks` (^2.8.9) — SOCKS protocol implementation

Plus Node.js built-ins: `fs`, `path`, `os`, `http`, `https`, `url`, `crypto`.

## Credits

- Inspired by [freebuff-proxy](https://github.com/ferdiunal/freebuff-proxy) by ferdiunal
- Original Go implementation: [Frebuff2API](https://github.com/Quorinex/Freebuff2API) by Quorinex
- Freebuff and Codebuff for the backend API
- [freebuff2api_rs](https://github.com/XxxXTeam/freebuff2api_rs) for version tracking

## License

MIT
