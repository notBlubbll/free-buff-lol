# UMANS-Proxy — Developer Guide

## Project Structure

```
UMANS-PROXY/
├── proxy.js              # Main proxy implementation + request router (~1610 lines)
├── dashboard.html        # Dashboard with usage cards, model search, key management, test chat
├── .config/
│   ├── config.json       # Runtime configuration (API key, EMAIL/PASSWORD, enabled models, etc.)
│   └── usage.json        # (reserved)
├── .cache/               # Cached assets (auto-created)
│   ├── wallpaper.jpg     # Cached Bing wallpaper
│   ├── wallpaper-haven.jpg  # Cached Wallhaven wallpaper
│   └── wallpaper-freegen.jpg     # Current FreeGen AI wallpaper (pending swap file: wallpaper-freegen.pending.jpg)
├── package.json          # Project metadata (MIT, no deps)
├── start.cmd             # Auto-detect launcher (Bun preferred, Node fallback)
├── start-node.cmd        # Node.js-only launcher
├── skills.md             # Opencode provider configuration reference
├── README.md             # User documentation
└── AGENTS.md             # This file
```

## Key Components

### 1. Constants & Config (proxy.js:1-200)

- `UMANS_API_BASE` — `https://api.code.umans.ai/v1`
- `API_KEY_ENV_VAR` — `UMANS_API_KEY`
- `APP_BASE` — `https://app.umans.ai`
- `IS_BUN` — Detected at runtime (`typeof Bun !== 'undefined'`)
- `RUNTIME_VERSION` — Bun or Node version string
- `loadConfig()` — Loads `.config/config.json` with env var overrides (`LISTEN_ADDR`, `UPSTREAM_BASE_URL`, `REQUEST_TIMEOUT`, `UMANS_API_KEY`, `API_KEYS`, `CACHE_TTL`, `CACHE_MAX_SIZE`, `CACHE_ENABLED`, `OVERRIDE_CONCURRENCY`, `FREEGEN_PROMPT`, `MAX_IMAGES`)
- `saveConfig()` / `debouncedSaveConfig()` — Writes config (debounced 500ms)
- `parseDuration()` — Parses strings like `15m`, `6h`, `30s` to ms
- `maskToken(key)` — Masks an API key for display as `prefix...suffix`
- `parseListenPort(addr)` — Parses `LISTEN_ADDR` into a port number

### 2. Global State (proxy.js:16-32)

| Variable | Type | Purpose |
|---|---|---|
| `config` | Object | Runtime config object |
| `userInfoCache` | Object | `{ data, time, ttl: 60000 }` |
| `startTime` | Date | Server start timestamp |
| `keyPool` | KeyPool/null | Multi-key pool instance |
| `activeRequests` | Number | In-flight upstream requests |
| `requestQueue` | Array | FIFO array of pending requests when at concurrency limit |
| `conversationMap` | Map | Bounded (10k) session → key affinity store |
| `modelDisplayNameMap` | Object | Maps model IDs → display names (populated from `/v1/models/info`) |
| `freegenGenerating` | Boolean | FreeGen wallpaper generation in progress |
| `freegenGenerationPromise` | Promise/null | Shared promise for concurrent FreeGen requests |
| `MODEL_CATALOG_CACHE_TTL` | 300000 (5min) | Catalog fetch cache TTL |
| `RATE_LIMIT_MAP` | Object | Per-model rate limit delays |
| `MAX_BODY_SIZE` | Number | Hard request body cap (5 MB) |
| `MAX_RETRIES` | Number | Upstream chat-completion retries (10) |
| `RETRY_DELAY_MS` | Number | Base retry backoff (3000 ms) |

### 3. Retry Logic (proxy.js:79-88, 1822-1916)

`retryLoop(fn)` retries the upstream `/v1/chat/completions` request up to `MAX_RETRIES` times with escalating delays (`3s, 6s, 9s…`).

- Retries occur on:
  - **HTTP 500** — regardless of response body / message
  - **HTTP 503** — regardless of response body / message
  - Network/fetch failures (treated as 502) that throw before a response is received
- On each retry the current key is marked unhealthy so the key pool rotates to the next healthy key.
- Non-retryable HTTP errors (e.g. 400, 401, 404, 429 without a configured rate-limit map) are returned immediately.


### 4. Response Cache (proxy.js:99-142)

LRU cache for non-streaming LLM responses using Map insertion order.
- **Key**: MD5 of `(model + stream_flag + system + messages + tools)`
- **TTL**: Configurable (default 60s), **Max size**: default 100
- **Stats**: `hits`, `misses`, `evictions`
- `cacheKey(payload, model)` — builds MD5 hash
- `GET/DELETE /api/cache` — stats/clear

### 5. Key Pool (proxy.js:321-396)

Round-robin multi-key pool with cooldown/unhealthy marking.
- `acquire()` — Round-robins, returns `{ key, name, index }`, sets `config.apiKey` + `upstream.apiKey`
- `markUnhealthy(index, status)` — Cooldown varies by status (503→60s, 502→30s, else 10s)
- `markHealthy(index)` — Resets state
- `get state()` — Returns array with masked tokens (first 10 + `...` + last 4)

### 6. Upstream Client & Model Catalog (proxy.js:421-541)

- `UpstreamClient` class with `getUserInfo()` (GET `/v1/models/info`, 10s timeout) and `chatCompletions(body)` (POST `/v1/chat/completions`)
- `UPSTREAM_AGENT` — Keep-alive HTTPS agent (128 sockets, 60s keepalive)
- `fetchModelCatalog()` — GET `/v1/models/info` with 15s timeout
- `getCatalogData()` — Cached 5-min catalog fetcher, populates `modelDisplayNameMap`
- `searchModels(query, filters)` — Local filter of catalog data (substring + family)

### 7. Tool Schema Normalization (proxy.js:543-652)

Normalizes JSON Schema in tools to handle `$ref`, `$defs`, `definitions`, nullable patterns.
- Key functions: `normalizeToolSchemas`, `normalizeSchemaMap`, `tryResolveRef`, `simplifyNullableCombinator`, `normalizeTypeField`, `normalizeEnumField`

### 8. Stream/Body Utilities (proxy.js:654-728)

- `isNodeStream(body)` — Duck-type check for Node.js streams
- `readBodyText(body)` — Handles Node streams, Web ReadableStreams, and async iterables
- `pipeBodyToResponse(res, body)` — Pipes upstream response to HTTP response with abort handling

### 9. HTTP Handler Helpers (proxy.js:730-759)

- `authorized(req)` — Checks `x-api-key` or `Authorization: Bearer` against `config.apiKeys`
- `readBody(req)` — Promisified chunk collector with `MAX_BODY_SIZE` cap
- `writeJSON(res, status, payload)` / `writeOpenAIError(res, status, message, type, code)`

### 10. Core HTTP Handlers (proxy.js:761-942)

- `handleHealthz` — Returns uptime, token_state, models_count, runtime, cache stats
- `handleModels` — OpenAI-format model list from `config.enabledModels`
- `processQueue()` — Dequeues from `requestQueue` while `activeRequests < limit`
- `handleChatCompletions` — Parses body, queues or executes via `proxyChatRequest`
- `proxyChatRequest` — Full proxy pipeline: key acquire → session label → reasoning strip → image-attachment limit (`limitImagesInMessages`) → cache check → model resolve → tool normalize → rate limit → **retry-wrapped upstream call** (see Retry Logic) → title-output sanitize (for title prompts) → stream/non-stream response. The full request body of the first request in a new session is logged to the console.
- `validateApiKey()` — Calls `getUserInfo()`, populates `userInfoCache` + `modelDisplayNameMap`, returns boolean

### 11. Request Router (proxy.js:963-1341)

| Route | Methods | Description |
|---|---|---|
| `/` or `/dashboard` | GET | Serve `dashboard.html` with current wallpaper embedded as base64 in `<head>` to prevent white flash |
| `/api/config` | GET/POST | Config read/write (masks API key) |
| `/api/validate` | GET | Validate API key → `{ valid, hasApiKey }` |
| `/api/models` | GET | Returns `{ models, model_display_names }` |
| `/api/models/search` | GET | Search UMANS catalog with `q`, `family`, `license`, `modalities`, `capabilities`, `context_length_min/max`, `per_page` |
| `/api/models/families` | GET | Returns sorted family list from catalog |
| `/api/models/add` | POST | Add model IDs to enabled list |
| `/api/models/remove` | POST | Remove model IDs from enabled list |
| `/api/bg` | GET | Bing wallpaper proxy (peapix.com) |
| `/api/bg-wallhaven` | GET | Wallhaven wallpaper proxy |
| `/api/bg-freegen` | GET/POST | FreeGen AI wallpaper generator. `GET` returns the current cached wallpaper; `POST` waits for/waits for generation and returns the new image (`prompt`, `ratio`, `wait=true` JSON body). Background generation writes to `.cache/wallpaper-freegen.pending.jpg` and atomically swaps to `.cache/wallpaper-freegen.jpg` when done. |
| `/api/keys` | GET/POST | Multi-key CRUD (add/update/delete) |
| `/api/cache` | GET/DELETE | Cache stats/clear |
| `/api/umans/usage` | GET | UMANS app usage data |
| `/api/umans/usage-history` | GET | 90-day usage history |
| `/api/umans/concurrency` | GET | Concurrent sessions, limit, active count, queue depth |
| `/api/umans/login` | POST | Login to UMANS app |
| `/api/umans/user` | GET | Login status `{ loggedIn, email }` |
| `/api/umans/logout` | POST | Logout (clears appSession) |
| `/api/restart` | POST | Triggers `process.exit(42)` after 500ms |
| `/healthz` | GET | Health check |
| `/v1/models` | GET | OpenAI-format models |
| `/v1/chat/completions` | POST | OpenAI chat (concurrency-queued) |

### 12. Opencode Config Discovery & Setup (proxy.js:1343-1412)

- `discoverOpencodeConfigs()` — Native filesystem discovery on Windows: scans `C:\Users` for directories and checks each for `.opencode/opencode.json` and `.config/opencode/opencode.json`, plus the `systemprofile` variant. Falls back to `~/.config/opencode/` and `~/.opencode/`. Non-Windows: returns existing parent dirs of the two fallback paths.
- `setupOpencodeConfig()` — Writes ALL models from `modelDisplayNameMap` to every discovered `opencode.json`. Falls back to `config.enabledModels` if map is empty. Creates `openconfig.b4umans.json` backup before first edit. Provider key: `umans`, uses `@ai-sdk/openai-compatible`. Each model gets `id`, `name`, `reasoning: true`, `interleaved: true`.

### 13. Usage Tracking & App Auth (proxy.js:201-319)

- `fetchUsage()` — GET `https://app.umans.ai/api/usage?context=personal` (app session cookie, 10s timeout, 5min cache)
- `fetchUsageHistory()` — GET `https://app.umans.ai/api/usage/history?from=...&to=...&granularity=day` (15s timeout, 5min cache)
- `fetchConcurrency()` — GET `{UPSTREAM_BASE_URL}/usage` with Bearer token, extracts `usage.concurrent_sessions` and `limits.concurrency.limit` (10s timeout, 5min cache)
- `getEffectiveConcurrency()` — Returns `{ concurrent, limit, overridden }`. If `config.overrideConcurrency > 0`, the effective concurrency limit is capped to `min(override, apiLimit)` (or override when the API limit is unknown).
- `loginToApp()` — CSRF → POST credentials → extracts `__Secure-authjs.session-token` from set-cookie. Saves to config.

### 14. Dashboard (dashboard.html)

- **Stat Cards** — Requests, Tokens, Cached % (grouped under a “Window” glass card)
- **Usage History** — 90-day paginated table (10 per page)
- **API Key section** — Key pool display with SS mode (blur on hover)
- **Models section** — Search catalog with family filter, rich toggle tags grouped by family
- **Quick Actions** — Check Health, Test Connection, Refresh Usage, Restart Proxy
- **Test Chat** — Streaming/context chat panel with model selector
- **Environment** — Runtime, Port, Started At, Wallpaper selector (None/Bing/Wallhaven/FreeGen), SS Mode toggle
- **FreeGen Wallpaper** — Generated via FreeGen AI image API + WebSocket, auto-enabled when FreeGen mode is saved; live generation spinner and prompt input in the Environment card
- **Key Management Modal** — Add/edit/delete API keys with inline editing; shows account email and User ID (in SS mode the User ID is jumbled and the email is blurred/masked — only `@` remains visible)
- **Platform Login Modal** — Email/password login to app.umans.ai
- **Glass UI** — Procedural SVG filter-based glassmorphism (`feDisplacementMap`, `feColorMatrix`)
- **Auto-refresh** — Status every 15s, usage every 30s

### 15. Dashboard ↔ UMANS API Data Flow

The dashboard does not talk to UMANS directly. All UMANS data passes through the proxy endpoints below, which cache responses for 5 minutes and forward the raw UMANS payload.

| Dashboard source | Proxy endpoint | Upstream call | Purpose |
|---|---|---|---|
| Requests / Tokens / Cached % (Window card) | `GET /api/umans/usage` | `GET https://app.umans.ai/api/usage?context=personal` | Current usage window |
| 90-Day Usage History | `GET /api/umans/usage-history` | `GET https://app.umans.ai/api/usage/history?from=...&to=...&granularity=day` | Per-day buckets |
| Concurrency card | `GET /api/umans/concurrency` | `GET {UPSTREAM_BASE_URL}/usage` | Active sessions & limit |

#### `/api/umans/usage` response shape

Proxy forwards an object shaped like:

```json
{
  "usage": {
    "requests_in_window": 246,
    "tokens_in": 24000000,
    "tokens_out": 11732073,
    "tokens_cached": 9360000
  },
  "window": { /* optional date/scope metadata from UMANS */ },
  "loggedIn": true,
  "email": "..."
}
```

The dashboard derives:
- `Requests = usage.requests_in_window`
- `Tokens = usage.tokens_in + usage.tokens_out`
- `Cached % = (usage.tokens_cached / usage.tokens_in) * 100`

It will prefer fields under `u.window` if that object contains usage fields, falling back to `u.usage`.

#### `/api/umans/usage-history` response shape

Proxy forwards per-day buckets:

```json
{
  "history": {
    "buckets": [
      { "bucket": "2026-06-13", "requests": 204, "tokens_in": 6000000, "tokens_out": 3353646, "tokens_cached_read": 5760000 },
      { "bucket": "2026-06-12", "requests": 439, "tokens_in": 8000000, "tokens_out": 18378427, "tokens_cached_read": 4560000 }
    ]
  }
}
```

The dashboard sums those buckets for the header:
- `90-Day Requests = Σ requests`
- `90-Day Tokens = Σ (tokens_in + tokens_out)`
- `Cached % = Σ tokens_cached_read / Σ tokens_in`

#### Window Token Estimation Workaround

UMANS sometimes returns mismatched scopes: `requests_in_window` is window-scoped, but `tokens_in`/`tokens_out` equal the 90-day total. In that case the numbers make no sense together, e.g.:

| | Requests | Tokens |
|---|---|---|
| Window | 246 | 35,732,073 |
| 90-Day | 643 | 35,732,073 |

The dashboard detects this signature (`winReqs > 0 && winReqs < histReqs && winTokens >= histTokens`) and replaces the raw window token value with a proportional estimate derived from the per-day history rows:

1. Sort buckets newest → oldest.
2. Walk backward, taking full days until the remaining request budget is smaller than the next day.
3. Prorate the last day by `remainingReqs / day.requests`.
4. Aggregate tokens, input tokens, and cached tokens the same way.
5. Change the card label to **“Tokens (est.)”** with a tooltip explaining the fallback.

The estimate assumes requests are spread roughly evenly through a day. It is only applied when the bug is detected; otherwise the dashboard shows the UMANS-supplied numbers verbatim.

## Startup Sequence

1. `loadConfig()` — Load `.config/config.json` + env var overrides
2. `ResponseCache` — Init with config values
3. `KeyPool` — Init from `config.keys` or single default key
4. `UpstreamClient` — Init HTTP client
5. `validateApiKey()` — Verify via `/v1/models/info`, populates `modelDisplayNameMap`
6. `loginToApp()` — Login to app.umans.ai with stored email/password (if configured and no session)
7. `fetchConcurrency()` — Fetch concurrent sessions & limit from usage API
8. `http.createServer(handleRequest).listen(port, '127.0.0.1')` — Start HTTP server on port 8084
9. `setupOpencodeConfig()` — Discover + write ALL models to all opencode.json configs, deferred until after the server is listening
10. **Auto-open dashboard** — Launches browser to `http://localhost:{port}` once opencode setup finishes (start/open/xdg-open per platform)

## FreeGen AI Wallpaper

The proxy integrates [FreeGen.app](https://freegen.app/) as a background source. It replicates the site's flow:

1. Call `POST https://prompt-signer.freegen.app/api/test` with the prompt to get `ts` + `sig`.
2. Call `POST https://image-generator.freegen.app/api/test` with `{ prompt, ts, sig, ratio_id }` to get a `job_id`.
3. Open a native `WebSocket` to `wss://websocket-bridge.freegen.app/ws` (with `Origin: https://freegen.app`) and subscribe to the `job_id`. The server pushes a `result` message with `image_data`, or an `error`.
4. Download the image, write it to `.cache/wallpaper-freegen.pending.jpg`, then `fs.renameSync` it to `.cache/wallpaper-freegen.jpg` so the swap is atomic and never exposes a partial image.

### Background-generation behavior

- Dashboard `GET /`/`/dashboard` embeds the current FreeGen wallpaper as base64 in the HTML `<head>` so the page background is visible immediately without a white flash.
- After serving the page, the proxy kicks off a **background** FreeGen generation for the next dashboard load. That generation writes to the pending file and atomically swaps it on completion.
- The dashboard's **FreeGen** mode adds a prompt input and **Generate** button. Clicking it calls `POST /api/bg-freegen` with `wait: true` and applies the returned image immediately via `URL.createObjectURL`, also saving the prompt to config.

### Endpoints

| Endpoint | Method | Body | Response |
|---|---|---|---|
| `/api/bg-freegen` | GET | — | Current cached `.cache/wallpaper-freegen.jpg` JPEG, or 404. With `?wait=1`, blocks until a new wallpaper is generated. |
| `/api/bg-freegen` | POST | `{ prompt, ratio?, wait? }` | `wait: true` returns the generated JPEG and applies `wallpaperSource: 'freegen'`. `wait: false` returns `202 Accepted` and generates in the background. |

### Configuration

- Config key `FREEGEN_PROMPT` / env var `FREEGEN_PROMPT` — default prompt used when `wallpaperSource` is `freegen`.
- Config key `wallpaperSource` — one of `none`, `bing`, `wallhaven`, or `freegen`.
- Dashboard exposes `freegenPrompt` and `wallpaperSource` in `/api/config` and persists them on change.

## Testing

```bash
node --check proxy.js          # Syntax check
node proxy.js                  # Start proxy
curl http://localhost:8084/healthz
curl http://localhost:8084/v1/models
curl http://localhost:8084/api/umans/usage
curl http://localhost:8084/api/umans/concurrency
curl "http://localhost:8084/api/models/search?q=llama"
curl "http://localhost:8084/api/i18n?locale=de&generate=1"
```

## Dependencies

Zero external npm dependencies — uses only Node.js built-in modules: `fs`, `path`, `os`, `http`, `https`, `url`, `crypto`, plus native `fetch` (Node 18+) and native `WebSocket` (Node 24+) for the FreeGen integration.

## Data Storage

- `.config/config.json` — Full proxy config including API keys, enabled models, display names, EMAIL/PASSWORD, APP_SESSION, OVERRIDE_CONCURRENCY, MAX_IMAGES, wallpaperSource, FREEGEN_PROMPT
- `.cache/wallpaper.jpg` — Cached Bing wallpaper
- `.cache/wallpaper-haven.jpg` — Cached Wallhaven wallpaper
- `.cache/wallpaper-freegen.jpg` — Current FreeGen AI wallpaper
- `.cache/wallpaper-freegen.pending.jpg` — In-progress FreeGen wallpaper; renamed to `.cache/wallpaper-freegen.jpg` only when complete
- `.cache/usage.db` — SQLite cache of past daily usage-history buckets (excludes the current day). Uses `node:sqlite` on Node 22+ or `bun:sqlite` on Bun.

## Concurrency Queue

- `activeRequests` — Counter of in-flight upstream requests
- `requestQueue` — FIFO array of pending requests
- `processQueue()` — Dequeues when `activeRequests < limit`
- Each completed request calls `processQueue()` via `.finally()`

## Notes for Opencode Agents

When working on UMANS-Proxy through opencode, keep the following in mind to avoid common tool failures.

### Edit tool / exact replacements

Opencode's `edit` tool requires an exact text match for `oldString`. If the error `Could not find oldString in the file. It must match exactly, including whitespace, indentation, and line endings.` appears, follow these steps:

1. **Read the file first** with the `read` tool and copy the exact block you want to replace, including all spaces, tabs, and line endings.
2. **Paste that verbatim** into the `edit` call's `oldString` parameter.
3. **Include more surrounding lines** if the same string appears multiple times in the file (or use `replaceAll: true` only when you intend to replace every occurrence).
4. If matching remains difficult, use the `write` tool to overwrite the entire file instead.

### Web research

- Use `webfetch` to retrieve content from a known URL.
- Do **not** call `websearch`; it is not available unless the OpenCode provider or `OPENCODE_ENABLE_EXA` is enabled. Prefer `webfetch` for documentation or GitHub source lookups.

### Provider configuration

- The proxy auto-writes a `umans` provider into every discovered `opencode.json`.
- The generated config explicitly sets `"instructions": ["AGENTS.md", "skills.md"]` so this guide and the provider reference are loaded on startup.
- After the proxy updates `opencode.json`, restart opencode for the changes to take effect.
