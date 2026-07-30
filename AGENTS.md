# FREEBUFF-PROXY Development Guide

## Project Structure

```
FREEBUFF-PROXY/
├── proxy.js              # Main proxy implementation (~2218 lines)
├── dashboard.html        # Anti-slop glass dashboard, Geist font, pure CSS (~368 lines)
├── .config/
│   └── config.json       # Runtime configuration (auto-created)
├── package.json          # Project metadata (freebuff, node-forge, node-fetch, socks-proxy-agent)
├── start.cmd             # Auto-detect launcher (Bun preferred, Node fallback)
├── start-node.cmd        # Node.js-only launcher
├── README.md             # User documentation
└── AGENTS.md             # This file (developer guide)
```

## Key Components

### 1. Constants & Version Tracking (lines 1-99)

- Source URLs for GitHub TypeScript files and Rust reference
- Version constants: `BUN_VERSION`, `FREEBUFF_CLI_VERSION`, `AI_SDK_COMPAT_VERSION`, `PROXY_VERSION`
- `CANONICAL_MODEL_ALIASES` — Maps shorthand model names to full IDs (e.g. `deepseek-v4-pro` → `deepseek/deepseek-v4-pro`)
- `FALLBACK_AGENT_IDS` — Hardcoded model-to-agent mapping when registry unavailable (includes `minimax-m3`, `gemini-*`)
- `CONTEXT_PRUNER_AGENT_ID` — Agent ID for the context-pruner child run
- `CODEBUFF_ACCEPT_ENCODING`, `CODEBUFF_JSON_USER_AGENT`, `FREEBUFF_CLI_USER_AGENT` — HAR-style header constants
- `LAST_REQUEST` / `debounceRequest()` — Global request debounce (1.3s minimum gap between requests)
- `LOG_LEVEL`, `logInfo()`, `logWarn()`, `logError()`, `logDebug()` — Tiered logging system; set via `LOG_LEVEL` env var or config.json `LOG_LEVEL` field (`error`/`warn`/`info`/`debug`). `debug` level restores verbose `[API]` and `[DEBUG]` log lines. `info` is default.
- `checkAndUpdateVersions()` — Fetches `freebuff2api_rs` source and npm registry to auto-update version strings
- `checkProxyVersion()` — Checks npm for latest proxy version; shows VBScript MsgBox alert and exits if outdated
- User-Agent generators: `getApiUserAgent()`, `getChatUserAgent()`, `getAdsUserAgent()`

### 2. Config System (lines 161-314)

- `loadConfig()` — Loads `.config/config.json` with env var overrides (`LISTEN_ADDR`, `UPSTREAM_BASE_URL`, `REQUEST_TIMEOUT`, `AUTH_TOKENS`, `API_KEYS`, `ENABLED_MODELS`, `LOG_LEVEL`, `TOKEN_REVALIDATE_INTERVAL`)
- `loadFreebuffCLITokens()` — Reads `~/.config/manicode/credentials.json`, extracts all `authToken` entries
- `saveConfig()` — Writes current config back to `.config/config.json`; auto-creates `.config/` dir if missing; creates backup (`config.backup.json`) on first write; includes `LOG_LEVEL` and `TOKEN_REVALIDATE_INTERVAL`
- `parseDuration()` — Parses duration strings like `15m`, `6h`, `30s`
- `setupOpencodeConfig()` — Writes/updates opencode provider config:
  - Discovers all `opencode.json` files on the system asynchronously at startup (full-drive search on Windows, full filesystem search elsewhere, using `bash`/`find`)
  - Caches discovered paths so opencode config updates don't rescan the disk
  - Iterates all model registry entries, includes only those in `config.enabledModels`
  - Adds `[LIM]` prefix to `name` for limited (premium) models (same convention as dashboard)
  - Writes `modalities` (input/output arrays) and `limit` (context/output) per model, not invalid `multimodal`/`free` fields
  - Reads existing opencode.json before overwriting; if `freebuff.provider.models` is non-empty and registry models that are still enabled are missing from it, they're removed from `config.enabledModels` and persisted via `saveConfig()` — this makes manual model removal from opencode.json persist across restarts
  - Normalizes model IDs through `canonicalModelName()` when comparing enabled models against the registry
  - Falls back to writing all registry models when the enabled list would otherwise produce an empty provider (e.g. stale IDs), and logs warnings about any enabled models that don't exist in the registry
  - Writes to all discovered `opencode.json` locations
- `ENABLED_MODELS` — Config array of model IDs to include in the opencode provider; toggleable via dashboard
- Auto-normalizes `codebuff.com` → `www.codebuff.com`

### 3. ModelRegistry (lines 178-280)

- `start()` — Fetches models immediately, then refreshes every 6 hours
- `refresh()` — Parallel fetch of `free-agents.ts` and `freebuff-models.ts` from GitHub
- `parseConstants(source)` — Regex extracts `export const X = 'value'` into a Map
- `parseAllFreeModels(source, variableMap)` — Regex extracts `'agent-id': new Set([MODEL_VAR, ...])` blocks, resolves variables
- `buildModelMapping()` — Uses hardcoded `SUPPORTED_MODELS` map (4 models → 4 agents)
- `parseModelMetadata()` — Extracts `displayName`, `premium`, `modalities` (input/output arrays), and `limit` (context/output numbers) from `freebuff-models.ts`
- `HARDCODED_MODELS` fallback includes `modalities` and `limit` fields for each model, used when GitHub fetch fails
- Result: `modelToAgent` Map, `allModels` array, `modelMetadata` Map with `{ displayName, premium, modalities, limit }`

### 4. Message Normalization (lines 605-660)

- `normalizeChatMessages(messages)` — Converts `developer` → `system`, injects "You are Buffy..." system prompt when missing
- `normalizeAdMessages(messages)` — Simplifies messages for ad requests
- `buildAgentValidationPayload()` — Builds agent definitions for upstream validation

### 5. UpstreamClient (lines 662-1020)

- `_hostHeader()` — Extracts host from upstream URL for `Host` header
- `apiHeaders(authToken, extra)` — HAR-style headers: `Accept-Encoding: gzip, deflate`, `Connection: keep-alive`, `Host`, `User-Agent: Bun/1.3.11`
- `chatHeaders(authToken)` — Same HAR-style headers with `User-Agent: ai-sdk/openai-compatible/...`
- `cliHeaders(authToken, extra)` — Same HAR-style headers with `User-Agent: Freebuff-CLI/0.0.105`
- `doJSON(authToken, path, body, method, extraHeaders)` — Generic JSON request with AbortController timeout
- `startRun(authToken, agentID, ancestorRunIds)` — `POST /api/v1/agent-runs` with `action: 'START'`
- `finishRun(authToken, runID, totalSteps)` — `POST /api/v1/agent-runs` with `action: 'FINISH'`
- `recordRunStep(authToken, runID, stepNumber, childRunIds, messageId, startTime)` — `POST /api/v1/agent-runs/{id}/steps`
- `chatCompletions(authToken, body, proxyAgent)` — `POST /api/v1/chat/completions` (streaming-aware, uses `node-fetch` + `SocksProxyAgent` when proxyAgent provided)
- `createSession(authToken, model, proxyAgent, countryCode)` — `POST /api/v1/freebuff/session`
- `getSession(authToken, instanceID, proxyAgent)` — `GET /api/v1/freebuff/session` with `x-freebuff-instance-id` header
- `endSession(authToken, instanceID)` — `DELETE /api/v1/freebuff/session`
- `validateAgents(authToken)` — `POST /api/agents/validate` with agent definitions
- `requestAds(authToken, provider, messages, sessionId)` — `POST /api/v1/ads` with device info and HAR browser UA
- `getStreak(authToken)` — `GET /api/v1/freebuff/streak`
- `reportZeroclickImpression(authToken, ids)` — `POST https://zeroclick.dev/api/v2/impressions`
- `reportCodebuffImpression(authToken, impUrl)` — `POST /api/v1/ads/impression`
- Handles 426 (`freebuff_update_required`) and `model_locked` errors specially

### 6. TokenPool (lines 1022-1168)

- Manages multiple auth tokens with round-robin selection
- Mutex-based locking via promise chain (`withLock()`)
- `getToken()` — Usage-aware selection: sorts tokens by remaining session quota descending, skips banned/unauthorized
- `hasAvailableQuota()` — Returns true if any token has remaining session quota
- `getAggregatedUsage()` — Sums `recentCount` and `limit` across all tokens, returns `{ used, limit, remaining, nextResetAt }`
- `getSessionForToken(token)` — Returns active session for a token (includes `rateLimit` data)
- `ensureSession(token, model)` — Up to 3 retries, handles model_locked and freebuff_update_required. On `model_locked`, attempts to end the existing session and create a fresh one for the requested model before falling back to the locked model. On model at quota: auto-falls back to another model from `rateLimitsByModel`
- Session data stored: `status`, `instanceID`, `expiresAt`, `countryCode`, `remainingMs`, `accessTier`, `rateLimit` (includes `model`, `entitlement`, `limit`, `period`, `resetAt`, `windowHours`, `recentCount`, `rateLimitsByModel`)
- `pollUntilReady(token, model, state)` — Polls up to 60 iterations for `active` status, handles `queued`, `ended`, `superseded`, `disabled`
- `endAllSessionsForToken(token)` — Cleans up all sessions for a token
- `invalidateSession(token, model)` — Removes specific session from cache
- Session key format: `{token}:{model}`

### 7. WarpPlusManager (lines 1170-1275)

- Manages a SOCKS5 proxy via the `warp-plus` binary for bypassing rate limits
- `ensureBinary()` — Downloads `warp-plus.exe` from GitHub releases if not present
- `start()` — Spawns the binary on `127.0.0.1:8086`, waits up to 20s for readiness
- `_waitForReady(timeout)` — Polls SOCKS5 connectivity via `nodeFetch` to `api.ipify.org`, checks process is still alive
- `stop()` — Kills the process and resets state
- `isReady()` — Returns true when process is running and proxy agent is created
- `getAgent()` — Returns `SocksProxyAgent` instance for use with `node-fetch`
- `lastEndpoint` — Caches the last working WARP endpoint (IP:port) for reuse on restart
- Used by `proxyChatRequest` when `accessTier === 'limited'` to route through Cloudflare WARP

### 8. Run Chain Helpers (lines 1277-1330)

Two distinct run chain patterns:

**Normal chain** (`startRunChainNormal`):
1. Start parent run (e.g. `base2-free`)
2. Start child run (`context-pruner`) with parent as ancestor
3. Record step + finish child run
4. Record step on parent with child run ID

**Gemini chain** (`startRunChainGemini`):
1. Start parent run
2. Start chat run with parent as ancestor

Finalization:
- `finalizeRunChainNormal` — Records step 2 + finishes parent (total_steps: 3)
- `finalizeRunChainGemini` — Records steps + finishes both chat and parent runs

### 9. Utility Functions (lines 1332-1480)

- `generateClientSessionId()` — 13-char random alphanumeric string
- `cloneMap()` / `cloneSlice()` — Deep clone objects/arrays
- `normalizeToolSchemas(tools)` — Entry point for tool schema normalization
- `extractDefinitions(schema)` — Extracts `definitions` and `$defs` from schema
- `normalizeSchemaMap(node, defs, maxDepth)` — Recursively resolves `$ref`, strips `nullable`, normalizes types/enums (max depth: 12)
- `tryResolveRef(node, defs)` — Resolves `$ref` pointers to inline schemas
- `simplifyNullableCombinator(schema, key)` — Simplifies `anyOf`/`oneOf` with null types
- `normalizeTypeField()` — Converts array types to single string
- `normalizeEnumField()` — Deduplicates enum values, removes nulls
- `isNodeStream(body)` — Checks if body is a Node.js stream (has `.pipe` and `.on`)
- `readBodyText(body)` — Reads body to string, handles Node streams, web `ReadableStream` (`getReader`), async iterables, and string fallback
- `pipeBodyToResponse(body, res)` — Pipes body to HTTP response (Node stream or web `ReadableStream`)
- `isSessionInvalid(statusCode, errorBody)` — Checks for retryable session errors (426, `session_superseded`, `waiting_room_required`, `session_model_mismatch`, etc.)
- `isRunInvalid(statusCode, body)` — Checks for `runid not found` / `runid not running`

### 10. HTTP Handlers (lines 1482-1820)

- `authorized(req)` — Checks `x-api-key` header or `Authorization: Bearer` against `config.apiKeys`
- `readBody(req)` — Reads full request body into string
- `writeJSON(res, statusCode, payload)` — JSON response helper
- `writeOpenAIError()` / `writeClaudeError()` — Error response formatters
- `handleHealthz(req, res)` — Returns uptime, token states (with `country_code` and `remaining_ms`), model count, runtime info, model mismatch log, and Warp Plus status (with `exit_country` when active)
- `handleModels(req, res)` — OpenAI-format model list
- `handleChatCompletions(req, res)` — Parses body, calls `proxyChatRequest`
- `handleClaudeMessages(req, res)` — Converts Anthropic format, calls `proxyChatRequest`
- `handleClaudeCountTokens(req, res)` — Estimates tokens (~4 chars/token)
- `proxyChatRequest(res, payload, model, writeError, writeUpstreamError, writeSuccess)` — Core proxy logic:
  1. Get token from pool
  2. Call agent validation, ad chain, and streak (non-blocking)
  3. Ensure session (with retry)
  4. Resolve agent ID from model
  5. Start run chain (with context-pruner child)
  6. Clone payload, normalize messages, inject `codebuff_metadata` (`freebuff_instance_id`, `trace_session_id`, `run_id`, `client_id`, `cost_mode: "free"`) and `provider` (`data_collection: "deny"`)
  7. Normalize tool schemas
  8. Forward to upstream (always via `node-fetch`)
  9. Handle success (streaming or non-streaming)
  10. On 429: retry up to 3 times with progressive delay (3s, 6s, 9s)
  11. On error: invalidate session or retry if run expired
  12. On `session_model_mismatch`: switch to locked model and retry
  13. On `model_locked`: attempt to unlock the session and retry the requested model, fall back to locked model if upstream rejects
  13. On Warp Plus failure: test SOCKS5 connectivity, fall back to direct connection
- `writeOpenAISuccessResponse()` — Pipes SSE stream or copies full response
- `writeClaudeSuccessResponse()` — Streams SSE or converts non-stream response to Anthropic format

### 11. Anthropic Conversion (lines 1822-1900)

- `convertClaudeMessagesRequestToOpenAI(body)` — Converts Anthropic messages format:
  - Extracts `system` field → system message
  - Converts content arrays to text strings
  - Preserves `max_tokens`, `temperature`, `stream`
- `convertOpenAINonStreamResponseToClaude(body)` — Converts OpenAI response to Anthropic format:
  - Maps `choices[0].message.content` → `content[{type: 'text', text}]`
  - Maps `tool_calls` → `content[{type: 'tool_use', ...}]`
  - Maps `finish_reason` → `stop_reason` (`tool_calls` → `tool_use`, `length` → `max_tokens`)

### 12. Token Health & Validation (lines 2021-2100)

- `validateToken(token)` — Returns `{valid, status, error, checkedAt, lockedModel}` where `status` is `active`, `banned`, `unauthorized`, `network_error`, or `unknown`
- `classifyTokenError(e)` — Parses error messages to determine token health status (403→banned, 401→unauthorized, timeout→network_error)
- `validateAllTokens()` — Validates all tokens and returns health results
- `reloadTokenPool()` — Reloads config and recreates TokenPool; preserves health data from previous pool

#### TokenPool Health Tracking (lines 1072-1375)
- All configured tokens remain visible in the pool regardless of health
- `tokenHealth` Map — Stores `{status, error, checkedAt}` per token (persisted across pool reloads)
- `getToken()` — Skips tokens with `banned` or `unauthorized` health during round-robin selection
- `hasUsableTokens()` — Returns `true` if at least one token is not banned/unauthorized
- `setTokenHealth(token, result)` / `getTokenHealth(token)` — Read/write health state

#### Periodic Re-validation
- Configurable via `TOKEN_REVALIDATE_INTERVAL` (default: `5m`) in config.json
- Runs at the configured interval and updates health for all tokens in the pool
- Logs status transitions (e.g. `"Token abc... became active"` or `"Token abc... became banned"`)
- Invalidates upstream sessions for newly banned/unauthorized tokens

### 13. Main Request Router (lines 1944-2060)

Routes by pathname:
- `/` or `/dashboard` → Serve `dashboard.html`
- `/api/config` (GET/POST) → Config read/write
- `/api/tokens` (GET) → Masked token list
- `/api/auth/start` (POST) → `POST https://freebuff.llm.pm/api/code`
- `/api/auth/status` (POST) → `POST https://freebuff.llm.pm/api/status` + auto-save token
- `/api/models` (GET) → Registry models
- `/api/bg` (GET) → Bing wallpaper via peapix.com
- `/api/usage` (GET) → Per-token usage breakdown with `recentCount`, `limit`, `resetAt`, plus aggregated `summary` (`used`, `limit`, `remaining`, `nextResetAt`)
- `/api/ads` (GET) → Fetch upstream ads from `/api/v1/ads`
- `/api/ads/impression` (POST) → Record ad impression
- `/healthz` → Health check (returns `token_state[]` with `health_status`, `health_error`, `health_checked_at` per token; includes `total_tokens`, `usable_tokens`, `dead_tokens` counts; includes `model_mismatches` log of recent model fallback events)
- `/v1/models` → OpenAI models
- `/v1/chat/completions` → OpenAI chat
- `/v1/messages` → Anthropic messages
- `/v1/messages/count_tokens` → Anthropic token counting

### 14. Dashboard (dashboard.html, 368 lines)

- **Anti-Slop Glass** — Refined `backdrop-filter` glassmorphism with inner highlight borders, inset shadows, and `prefers-reduced-transparency` fallback
- **Geist Typography** — Geist font from CDN (replaces Inter), no AI-tell
- **Pure CSS** — Zero Bootstrap dependency, CSS Grid layouts, custom switch toggles, native CSS utility classes
- **OAuth UI** — `startOAuth()` → polling every 2s for 60 attempts → auto-saves token
- **Ad System** — `fetchAds()` → `renderAdInTokenCard()` → impression tracking
- **Usage Stats** — Six stat cards: Sessions Used, Remaining, Burn/hr, Resets In (live countdown), Depletion, Country
- **Per-Token Usage Bar** — Each token card shows a progress bar (`recentCount / limit`) with color coding (green < 80%, orange < 100%, red = full)
- **Session Countdown** — Live `Xm Ys left` timer in Auth Token Status header, using `remaining_ms` from healthz, decremented every second via `setInterval`
- **SS Mode** — Blur tokens for screenshots
- **Auto-refresh** — Health check every 5s, ad rotation every 30s, countdown tick every 1s
- **Collapsible Sections** — Toggle with icon rotation animation
- **Reduced Motion** — `prefers-reduced-motion` disables all animations/transitions
- **Responsive** — CSS Grid with 2/3/6-col stat grid, 2fr/1fr main grid, mobile-first collapse
- **Focus Visible** — `:focus-visible` outlines for keyboard navigation
- **Skeleton Loading** — Shimmer animation for loading states
- **Model Mismatch Notifications** — Detects when upstream uses a different model than requested, shows toast + persistent banner with requested vs actual model details

## Authentication Flow

```
User starts proxy
    ↓
loadConfig() + loadFreebuffCLITokens()
    ↓
checkAndUpdateVersions() — fetch Bun/CLI versions
    ↓
ModelRegistry.start() — fetch models from GitHub
    ↓
validateAllTokens() — test each token via createSession()
    ↓
TokenPool initialized with valid tokens
    ↓
HTTP server starts on 0.0.0.0:8080
    ↓
setInterval: token reload every 5 min
setInterval: version check every 1 hour
    ↓
Ready
```

## Model Registry Parsing

1. Fetch `freebuff-models.ts` from GitHub
2. Extract constants: `export const FREEBUFF_MINIMAX_MODEL_ID = 'minimax/minimax-m2.7'`
3. Build variable map: `{ FREEBUFF_MINIMAX_MODEL_ID: 'minimax/minimax-m2.7', ... }`
4. Fetch `free-agents.ts` from GitHub
5. Parse agent blocks: `'base2-free': new Set([FREEBUFF_MINIMAX_MODEL_ID, ...])`
6. Resolve variables using the map
7. Filter through hardcoded `SUPPORTED_MODELS` (4 models)
8. Result: `modelToAgent` Map + sorted `allModels` array

## Request Lifecycle

```
Client request arrives
    ↓
DebounceRequest() — enforce 1.3s minimum gap
    ↓
Check API key authorization (if configured)
    ↓
Route to handler
    ↓
Parse + validate request body
    ↓
Get token from pool (round-robin)
    ↓
Call agent validation, ad chain, and streak (non-blocking)
    ↓
ensureSession(token, model) — up to 3 retries
    ↓ (with model_lock handling)
Start run chain (normal)
    ├─ Start parent run (agent ID)
    ├─ Start child run (context-pruner)
    ├─ Record + finish child
    └─ Record step on parent
    ↓
Clone payload, normalize messages (developer→system, Buffy prompt)
Inject codebuff_metadata (freebuff_instance_id, trace_session_id, run_id, client_id, cost_mode)
Inject provider (data_collection: deny)
Normalize tool schemas ($ref resolution)
    ↓
Forward to upstream /api/v1/chat/completions (with HAR-style headers)
    ↓
Success → pipe response (stream or buffer)
    ↓ (async)
Finalize run chain
    ├─ Record step 2 on parent
    └─ Finish parent run (total_steps: 3)
```

## Session Management

```
ensureSession(token, model)
    ↓
Check cached session (active + not expired)
    ↓ (cache miss)
createSession(token, model) → POST /api/v1/freebuff/session
    ↓
pollUntilReady() — up to 60 iterations
    ├─ 'active' → return instanceId
    ├─ 'queued' → wait (estimatedWaitMs or 250ms), poll getSession()
    ├─ 'ended'/'superseded' → createSession() again
    ├─ 'disabled' → return (no session needed)
    └─ 'model_locked' → end existing session and retry requested model, then fall back to locked model
    ↓
Cache session keyed by {token}:{model}
```

## Startup Sequence (startServer, lines 1982-2040)

1. `loadConfig()` — Load `.config/config.json` + env vars
2. `loadFreebuffCLITokens()` — Merge CLI tokens into config
3. `checkAndUpdateVersions()` — Fetch latest version strings
4. `new ModelRegistry()` + `.start()` — Fetch models from GitHub
5. `setupOpencodeConfig()` — Write opencode provider config to all discovered `opencode.json` locations (full-drive search, filters disabled models, adds `[LIM]` prefix for limited models, detects manual removals, normalizes model IDs, falls back to all registry models if enabled list is stale)
6. `validateAllTokens()` — Test each token
7. `new TokenPool(validTokens, config, client)` — Initialize pool
8. `http.createServer(handleRequest).listen(port)` — Start server
9. `setInterval(tokenReload, 5min)` — Check for new CLI tokens
10. `setInterval(versionCheck, 1hr)` — Update version strings

## Common Issues

### Syntax Errors

Multiple edits can create duplicate code blocks. Validate with:
```bash
node --check proxy.js
```

### Port Conflicts

```bash
netstat -ano | findstr :8080
taskkill /PID <pid> /F
```

### Log Noise / Verbose API Output

Set `LOG_LEVEL=error` or `LOG_LEVEL=warn` in `.config/config.json` to suppress `[API]` and `[DEBUG]` log lines.  
Use `LOG_LEVEL=debug` to restore verbose logging when troubleshooting upstream calls.

### Token Validation False Positives

`validateToken()` only accepts `status === 'active'`. Does not accept `disabled` or `queued`.

### Browser Not Opening

On Windows, `start.cmd` handles window title management and port cleanup automatically. The cmd window closes automatically on exit (no "Press any key" pause). The cmd window closes automatically on exit (no "Press any key" pause).

### Version Mismatch

If upstream returns `freebuff_update_required` (HTTP 426), the proxy invalidates the current session and retries. `checkAndUpdateVersions()` runs on startup and every hour.

### Body Stream Handling

The proxy uses two different `fetch` implementations:
- **Global `fetch`** (Node 18+ built-in) — returns web `ReadableStream` for `resp.body`
- **`node-fetch`** (v2.7.0) — returns Node.js `Readable` stream for `resp.body`

The `readBodyText()` function handles both: it checks for Node streams (`.pipe`/`.on`), web streams (`.getReader`), async iterables, and falls back to `String()`. The `pipeBodyToResponse()` function similarly handles both stream types.

When adding new upstream calls, always use `readBodyText()` instead of `resp.body.text()` or `resp.text()` to avoid crashes.

### Running Commands in Background

Always run long-lived commands (proxy, dev servers, watchers) in the background to prevent shell hangup. Use `Start-Process` or run detached:

```powershell
# Good: Background process that won't block
Start-Process -FilePath "bun" -ArgumentList "run", "proxy.js" -WindowStyle Hidden

# Bad: Foreground process that blocks the terminal
bun run proxy.js
```

If a process must run in the terminal, ensure it's detached or use `&` in Unix shells. On Windows, `start.cmd` handles this automatically.

## Testing

```bash
# Syntax check
node --check proxy.js

# Start proxy
node proxy.js

# Test endpoints
curl http://localhost:8080/healthz
curl http://localhost:8080/v1/models
curl http://localhost:8080/api/tokens
curl http://localhost:8080/api/models

# Test chat completion
curl -X POST http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"minimax/minimax-m2.7","messages":[{"role":"user","content":"Hello"}]}'

# Test Anthropic endpoint
curl -X POST http://localhost:8080/v1/messages \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek/deepseek-v4-pro","max_tokens":100,"messages":[{"role":"user","content":"Hello"}]}'
```

## Dependencies

```json
{
  "freebuff": "^0.0.96",
  "node-forge": "^1.4.0",
  "node-fetch": "^2.7.0",
  "socks-proxy-agent": "^8.0.0",
  "https-proxy-agent": "^9.1.0",
  "socks": "^2.8.9"
}
```

Plus Node.js built-ins: `fs`, `path`, `os`, `http`, `https`, `url`, `crypto`.

## Performance

| Setting | Value |
|---------|-------|
| Model registry refresh | 6 hours |
| Token reload check | 5 minutes |
| Token re-validation interval | 5 minutes (configurable) |
| Session poll max iterations | 60 |
| Session poll delay | 250ms-2s |
| Version check | 1 hour |
| Request timeout | 15 minutes |
| Request debounce | 1.3 seconds |
| 429 retry attempts | 3 |
| 429 retry delays | 3s, 6s, 9s |
| Session poll max iterations | 60 |
| Session poll delay | 250ms-2s |
| Health check (dashboard) | 5 seconds |
| Ad rotation | 30 seconds |

## Security

- API keys for proxy authentication (optional, via `API_KEYS` config)
- Token masking in dashboard and API responses (`token.substring(0,8) + '...' + token.substring(len-4)`)
- No token logging in request logs
- Config file should be `.gitignore`'d
- CORS not configured (same-origin only)
- SS Mode in dashboard blurs token display

## Future Improvements

- [ ] WebSocket support for streaming
- [ ] Token expiration detection
- [ ] Automatic token refresh
- [x] Rate limiting — Global 1.3s debounce + 429 retry with progressive backoff
- [x] Auto-configure opencode provider — Writes `opencode.json` on startup with `[LIM]` prefix for limited models, respects `ENABLED_MODELS`, syncs manual model removals back to config
- [x] HAR-style fingerprinting — Browser-compatible headers for upstream compatibility
- [x] Agent validation — Validates agent definitions with upstream before chat requests
- [x] Ad chain + streak — Completes ad flow and streak check before session creation
- [x] Message normalization — developer→system, Buffy prompt injection
- [x] Context-pruner run chain — Proper child run lifecycle matching upstream expectations
- [x] Token health tracking — Banned/unauthorized tokens stay visible, surfaced in /healthz and dashboard
- [x] Periodic token re-validation — Configurable interval, auto-detects banned tokens mid-session
- [x] Log level system — LOG_LEVEL env/config (error/warn/info/debug) quietens upstream call noise
- [x] Usage tracking — rateLimit data stored in session cache; exposed via /healthz and /api/usage; shown in dashboard with progress bars and countdown
- [x] Usage-aware token selection — `getToken()` prefers tokens with more remaining quota; per-model quota fallback in `ensureSession`
- [x] Model unlock on request mismatch — Ends locked session and retries requested model, falls back to locked model if rejected
- [ ] Request/response logging
- [ ] Metrics export (Prometheus)
- [ ] Docker containerization
- [x] Model unlock on request mismatch — Ends locked session and retries requested model, falls back to locked model if rejected
- [ ] Multiple upstream backends
- [ ] Model-specific routing rules
- [ ] Request caching
