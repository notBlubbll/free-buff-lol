# FREEBUFF-PROXY Development Guide

## Project Structure

```
FREEBUFF-PROXY/
├── proxy.js              # Main proxy implementation (1317 lines)
├── dashboard.html        # Liquid glass dashboard with OAuth UI (961 lines)
├── .config/
│   └── config.json       # Runtime configuration
├── package.json          # Project metadata (freebuff, node-forge)
├── start.cmd             # Auto-detect launcher (Bun preferred, Node fallback)
├── start-node.cmd        # Node.js-only launcher
├── README.md             # User documentation
└── AGENTS.md             # This file (developer guide)
```

## Key Components

### 1. Constants & Version Tracking (lines 1-99)

- Source URLs for GitHub TypeScript files and Rust reference
- Version constants: `BUN_VERSION`, `FREEBUFF_CLI_VERSION`, `AI_SDK_COMPAT_VERSION`
- `CANONICAL_MODEL_ALIASES` — Maps shorthand model names to full IDs (e.g. `deepseek-v4-pro` → `deepseek/deepseek-v4-pro`)
- `FALLBACK_AGENT_IDS` — Hardcoded model-to-agent mapping when registry unavailable
- `checkAndUpdateVersions()` — Fetches `freebuff2api_rs` source and npm registry to auto-update version strings
- User-Agent generators: `getApiUserAgent()`, `getChatUserAgent()`, `getAdsUserAgent()`

### 2. Config System (lines 101-176)

- `loadConfig()` — Loads `.config/config.json` with env var overrides (`LISTEN_ADDR`, `UPSTREAM_BASE_URL`, `REQUEST_TIMEOUT`, `AUTH_TOKENS`, `API_KEYS`)
- `loadFreebuffCLITokens()` — Reads `~/.config/manicode/credentials.json`, extracts all `authToken` entries
- `saveConfig()` — Writes current config back to `.config/config.json`
- `parseDuration()` — Parses duration strings like `15m`, `6h`, `30s`
- Auto-normalizes `codebuff.com` → `www.codebuff.com`

### 3. ModelRegistry (lines 178-280)

- `start()` — Fetches models immediately, then refreshes every 6 hours
- `refresh()` — Parallel fetch of `free-agents.ts` and `freebuff-models.ts` from GitHub
- `parseConstants(source)` — Regex extracts `export const X = 'value'` into a Map
- `parseAllFreeModels(source, variableMap)` — Regex extracts `'agent-id': new Set([MODEL_VAR, ...])` blocks, resolves variables
- `buildModelMapping()` — Uses hardcoded `SUPPORTED_MODELS` map (4 models → 4 agents)
- Result: `modelToAgent` Map, `allModels` array

### 4. UpstreamClient (lines 282-419)

- `doJSON(authToken, path, body, method, extraHeaders)` — Generic JSON request with AbortController timeout
- `startRun(authToken, agentID, ancestorRunIds)` — `POST /api/v1/agent-runs` with `action: 'START'`
- `finishRun(authToken, runID, totalSteps)` — `POST /api/v1/agent-runs` with `action: 'FINISH'`
- `recordRunStep(authToken, runID, stepNumber, childRunIds, messageId, startTime)` — `POST /api/v1/agent-runs/{id}/steps`
- `chatCompletions(authToken, body)` — `POST /api/v1/chat/completions` (streaming-aware)
- `createSession(authToken, model)` — `POST /api/v1/freebuff/session`
- `getSession(authToken, instanceID)` — `GET /api/v1/freebuff/session` with `x-freebuff-instance-id` header
- `endSession(authToken, instanceID)` — `DELETE /api/v1/freebuff/session`
- Handles 426 (`freebuff_update_required`) and `model_locked` errors specially

### 5. TokenPool (lines 421-567)

- Manages multiple auth tokens with round-robin selection
- Mutex-based locking via promise chain (`withLock()`)
- `ensureSession(token, model)` — Up to 3 retries, handles model_locked and freebuff_update_required
- Session data stored: `status`, `instanceID`, `expiresAt`, `countryCode`, `remainingMs`
- `pollUntilReady(token, model, state)` — Polls up to 60 iterations for `active` status, handles `queued`, `ended`, `superseded`, `disabled`
- `endAllSessionsForToken(token)` — Cleans up all sessions for a token
- `invalidateSession(token, model)` — Removes specific session from cache
- Session key format: `{token}:{model}`

### 6. Run Chain Helpers (lines 569-603)

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
- `finalizeRunChainNormal` — Records step 2 + finishes parent
- `finalizeRunChainGemini` — Records steps + finishes both chat and parent runs

### 7. Utility Functions (lines 605-754)

- `generateClientSessionId()` — 13-char random alphanumeric string
- `cloneMap()` / `cloneSlice()` — Deep clone objects/arrays
- `normalizeToolSchemas(tools)` — Entry point for tool schema normalization
- `extractDefinitions(schema)` — Extracts `definitions` and `$defs` from schema
- `normalizeSchemaMap(node, defs, maxDepth)` — Recursively resolves `$ref`, strips `nullable`, normalizes types/enums (max depth: 12)
- `tryResolveRef(node, defs)` — Resolves `$ref` pointers to inline schemas
- `simplifyNullableCombinator(schema, key)` — Simplifies `anyOf`/`oneOf` with null types
- `normalizeTypeField()` — Converts array types to single string
- `normalizeEnumField()` — Deduplicates enum values, removes nulls
- `isSessionInvalid(statusCode, errorBody)` — Checks for retryable session errors (426, `session_superseded`, `waiting_room_required`, etc.)
- `isRunInvalid(statusCode, body)` — Checks for `runid not found` / `runid not running`

### 8. HTTP Handlers (lines 756-1089)

- `authorized(req)` — Checks `x-api-key` header or `Authorization: Bearer` against `config.apiKeys`
- `readBody(req)` — Reads full request body into string
- `writeJSON(res, statusCode, payload)` — JSON response helper
- `writeOpenAIError()` / `writeClaudeError()` — Error response formatters
- `handleHealthz(req, res)` — Returns uptime, token states (with `country_code` and `remaining_ms`), model count, runtime info
- `handleModels(req, res)` — OpenAI-format model list
- `handleChatCompletions(req, res)` — Parses body, calls `proxyChatRequest`
- `handleClaudeMessages(req, res)` — Converts Anthropic format, calls `proxyChatRequest`
- `handleClaudeCountTokens(req, res)` — Estimates tokens (~4 chars/token)
- `proxyChatRequest(res, payload, model, writeError, writeUpstreamError, writeSuccess)` — Core proxy logic:
  1. Get token from pool
  2. Ensure session (with retry)
  3. Resolve agent ID from model
  4. Start run chain
  5. Clone payload, inject `codebuff_metadata` (run_id, cost_mode, client_id, instance_id)
  6. Normalize tool schemas
  7. Forward to upstream
  8. Handle success (streaming or non-streaming)
  9. On error: invalidate session or retry if run expired
- `writeOpenAISuccessResponse()` — Pipes SSE stream or copies full response
- `writeClaudeSuccessResponse()` — Streams SSE or converts non-stream response to Anthropic format

### 9. Anthropic Conversion (lines 1024-1088)

- `convertClaudeMessagesRequestToOpenAI(body)` — Converts Anthropic messages format:
  - Extracts `system` field → system message
  - Converts content arrays to text strings
  - Preserves `max_tokens`, `temperature`, `stream`
- `convertOpenAINonStreamResponseToClaude(body)` — Converts OpenAI response to Anthropic format:
  - Maps `choices[0].message.content` → `content[{type: 'text', text}]`
  - Maps `tool_calls` → `content[{type: 'tool_use', ...}]`
  - Maps `finish_reason` → `stop_reason` (`tool_calls` → `tool_use`, `length` → `max_tokens`)

### 10. Token Validation (lines 1091-1131)

- `validateToken(token)` — Creates session, checks `status === 'active'`. Handles `model_locked` by retrying with locked model.
- `validateAllTokens()` — Validates all configured tokens sequentially
- `reloadTokenPool()` — Reloads config and recreates TokenPool

### 11. Main Request Router (lines 1133-1248)

Routes by pathname:
- `/` or `/dashboard` → Serve `dashboard.html`
- `/api/config` (GET/POST) → Config read/write
- `/api/tokens` (GET) → Masked token list
- `/api/auth/start` (POST) → `POST https://freebuff.llm.pm/api/code`
- `/api/auth/status` (POST) → `POST https://freebuff.llm.pm/api/status` + auto-save token
- `/api/models` (GET) → Registry models
- `/api/bg` (GET) → Bing wallpaper via peapix.com
- `/api/ads` (GET) → Fetch upstream ads from `/api/v1/ads`
- `/api/ads/impression` (POST) → Record ad impression
- `/healthz` → Health check
- `/v1/models` → OpenAI models
- `/v1/chat/completions` → OpenAI chat
- `/v1/messages` → Anthropic messages
- `/v1/messages/count_tokens` → Anthropic token counting

### 12. Dashboard (dashboard.html, 961 lines)

- **Liquid Glass Engine** — Canvas-generated displacement maps with refraction profiles (`calculateRefractionProfile`, `generateDisplacementMap`, `generateSpecularMap`)
- **SVG Filter Pipeline** — `feGaussianBlur` → `feDisplacementMap` → `feColorMatrix` → `feComposite` → `feBlend`
- **OAuth UI** — `startOAuth()` → polling every 2s for 60 attempts → auto-saves token
- **Ad System** — `fetchAds()` → `renderAdInTokenCard()` → impression tracking
- **Country Card** — Displays `country_code` from session response in a stats card
- **Session Countdown** — Live `Xm Ys left` timer in Auth Token Status header, using `remaining_ms` from healthz, decremented every second via `setInterval`
- **SS Mode** — Blur tokens for screenshots
- **Auto-refresh** — Health check every 5s, ad rotation every 30s, countdown tick every 1s
- **Collapsible Sections** — Toggle with icon rotation animation

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
Check API key authorization (if configured)
    ↓
Route to handler
    ↓
Parse + validate request body
    ↓
Get token from pool (round-robin)
    ↓
ensureSession(token, model) — up to 3 retries
    ↓ (with model_lock handling)
Start run chain (normal)
    ├─ Start parent run (agent ID)
    ├─ Start child run (context-pruner)
    ├─ Record + finish child
    └─ Record step on parent
    ↓
Clone payload, inject codebuff_metadata
Normalize tool schemas ($ref resolution)
    ↓
Forward to upstream /api/v1/chat/completions
    ↓
Success → pipe response (stream or buffer)
    ↓ (async)
Finalize run chain
    ├─ Record step 2 on parent
    └─ Finish parent run
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
    └─ 'model_locked' → switch to locked model, retry
    ↓
Cache session keyed by {token}:{model}
```

## Startup Sequence (startServer, lines 1250-1317)

1. `loadConfig()` — Load `.config/config.json` + env vars
2. `loadFreebuffCLITokens()` — Merge CLI tokens into config
3. `checkAndUpdateVersions()` — Fetch latest version strings
4. `new ModelRegistry()` + `.start()` — Fetch models from GitHub
5. `validateAllTokens()` — Test each token
6. `new TokenPool(validTokens, config, client)` — Initialize pool
7. `http.createServer(handleRequest).listen(port)` — Start server
8. `setInterval(tokenReload, 5min)` — Check for new CLI tokens
9. `setInterval(versionCheck, 1hr)` — Update version strings

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

### Token Validation False Positives

`validateToken()` only accepts `status === 'active'`. Handles `model_locked` by retrying with the locked model. Does not accept `disabled` or `queued`.

### Browser Not Opening

On Windows, `start.cmd` handles window title management and port cleanup automatically. The cmd window closes automatically on exit (no "Press any key" pause). The cmd window closes automatically on exit (no "Press any key" pause).

### Version Mismatch

If upstream returns `freebuff_update_required` (HTTP 426), the proxy invalidates the current session and retries. `checkAndUpdateVersions()` runs on startup and every hour.

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
  "node-forge": "^1.4.0"
}
```

Plus Node.js built-ins: `fs`, `path`, `os`, `http`, `https`, `url`, `crypto`.

## Performance

| Setting | Value |
|---------|-------|
| Model registry refresh | 6 hours |
| Token reload check | 5 minutes |
| Version check | 1 hour |
| Request timeout | 15 minutes |
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
- [ ] Rate limiting
- [ ] Request/response logging
- [ ] Metrics export (Prometheus)
- [ ] Docker containerization
- [ ] Multiple upstream backends
- [ ] Model-specific routing rules
- [ ] Request caching
- [ ] Gemini run chain implementation (currently only normal chain used)
