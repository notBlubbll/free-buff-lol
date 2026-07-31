const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const https = require("https");
const url = require("url");
const crypto = require("crypto");
const nodeFetch = require("node-fetch");

const {
  FREE_AGENTS_SOURCE_URL,
  FREEBUFF_MODELS_SOURCE_URL,
  FREEBUFF_MODEL_IDS_SOURCE_URL,
  MODEL_CONFIG_SOURCE_URL,
  MODEL_REFRESH_INTERVAL,
  TOKEN_RELOAD_INTERVAL,
  FREEBUFF2API_RS_SOURCE,
  PROXY_VERSION,
  NPM_PACKAGE_NAME,
  IS_BUN,
  RUNTIME_VERSION,
  runtime,
  FALLBACK_AGENT_IDS,
  GEMINI_PARENT_AGENT_ID,
  GEMINI_SUBAGENT_IDS,
  CONTEXT_PRUNER_AGENT_ID,
  CODEBUFF_ACCEPT_ENCODING,
  CODEBUFF_JSON_USER_AGENT,
  FREEBUFF_CLI_USER_AGENT,
  CANONICAL_MODEL_ALIASES,
  logDebug,
  logInfo,
  logWarn,
  logError,
  debounceRequest,
  isBlacklistedModel,
  canonicalModelName,
  getApiUserAgent,
  getChatUserAgent,
  getAdsUserAgent,
  debugLog,
  httpGet,
  versionCompare,
  parseDuration,
} = require("./src/core");

const { createStateStore } = require("./src/config/state");
const {
  loadConfig: loadConfigFactory,
  saveConfig: saveConfigFactory,
} = require("./src/config/config");
const { createModelRegistry } = require("./src/models/model-registry");
const { createTokenPool } = require("./src/tokens/token-pool");
const { createUpstreamClient } = require("./src/upstream/client");
const { createRunChains } = require("./src/upstream/run-chains");
const { createAccountManager } = require("./src/tokens/accounts");
const { createTokenValidation } = require("./src/tokens/validation");
const { createProxyChatRequest } = require("./src/requests/proxy-chat");
const { createErrorWriters } = require("./src/requests/errors");
const { createResponseWriters } = require("./src/requests/responses");
const {
  normalizeChatMessages,
  normalizeAdMessages,
  normalizeMultimodalContent,
} = require("./src/requests/messages");
const { normalizeToolSchemas } = require("./src/requests/tools");
const {
  isNodeStream,
  readBodyText,
  pipeBodyToResponse,
  generateClientSessionId,
  cloneMap,
  cloneSlice,
  countOpenAIPayloadTokens,
} = require("./src/requests/utilities");
const {
  convertClaudeMessagesRequestToOpenAI,
  convertOpenAINonStreamResponseToClaude,
} = require("./src/requests/anthropic");
const { createHttpHandlers } = require("./src/http/handlers");

// ─── Mutable State ───
let config = null;
let modelRegistry = null;
let tokenPool = null;
let activeServer = null;
let activeIntervals = [];
let stopTokenWatcher = () => {};
const startTime = new Date();

const MODEL_MISMATCH_LOG = [];
const MODEL_MISMATCH_MAX = 50;
const EVENT_LOG = [];
const EVENT_LOG_MAX = 200;

function pushEvent(level, message, extra) {
  const entry = { level, message, at: new Date().toISOString(), ...extra };
  EVENT_LOG.unshift(entry);
  if (EVENT_LOG.length > EVENT_LOG_MAX) EVENT_LOG.length = EVENT_LOG_MAX;
}

function logModelMismatch(requestedModel, actualModel, reason, tokenIdx) {
  const entry = {
    requested: requestedModel,
    actual: actualModel,
    reason: reason || "unknown",
    token: tokenIdx != null ? `token-${tokenIdx + 1}` : null,
    at: new Date().toISOString(),
  };
  MODEL_MISMATCH_LOG.unshift(entry);
  if (MODEL_MISMATCH_LOG.length > MODEL_MISMATCH_MAX)
    MODEL_MISMATCH_LOG.length = MODEL_MISMATCH_MAX;
  logWarn(
    `[Model Mismatch] requested=${requestedModel}, actual=${actualModel}, reason=${reason}`,
  );
}

// ─── CLI Token Loading ───
function loadFreebuffCLITokens() {
  const tokens = [];
  const watchedPaths = [];
  const credFile = "credentials.json";
  const subPath = path.join(".config", "manicode", credFile);
  const searchPaths = [];
  const seen = new Set();
  const addPath = (p) => {
    const resolved = path.resolve(p);
    if (!seen.has(resolved)) {
      seen.add(resolved);
      searchPaths.push(resolved);
    }
  };

  const home = os.homedir();
  addPath(path.join(home, subPath));
  const envCandidates = [
    process.env.USERPROFILE,
    process.env.HOME,
    process.env.HOMEDRIVE && process.env.HOMEPATH
      ? path.join(process.env.HOMEDRIVE, process.env.HOMEPATH)
      : null,
    process.env.APPDATA,
    process.env.LOCALAPPDATA,
    process.env.XDG_CONFIG_HOME,
  ].filter(Boolean);
  for (const envDir of envCandidates) {
    addPath(path.join(envDir, subPath));
    if (path.basename(envDir) !== "manicode")
      addPath(path.join(envDir, credFile));
  }

  if (process.platform === "win32") {
    try {
      const root = path.parse(home).root || "C:\\";
      const usersDir = path.join(root, "Users");
      if (fs.existsSync(usersDir)) {
        for (const entry of fs.readdirSync(usersDir)) {
          if (entry.startsWith(".")) continue;
          const userDir = path.join(usersDir, entry);
          try {
            if (!fs.statSync(userDir).isDirectory()) continue;
          } catch (e) {
            continue;
          }
          addPath(path.join(userDir, subPath));
          addPath(
            path.join(userDir, "AppData", "Roaming", "manicode", credFile),
          );
          addPath(path.join(userDir, "AppData", "Local", "manicode", credFile));
        }
      }
    } catch (e) {}
  } else {
    try {
      const passwd = fs.readFileSync("/etc/passwd", "utf8");
      for (const line of passwd.split("\n")) {
        const parts = line.split(":");
        if (parts.length >= 6 && parts[2] !== "0" && parts[5]) {
          addPath(path.join(parts[5], subPath));
          addPath(path.join(parts[5], ".local", "share", "manicode", credFile));
        }
      }
    } catch (e) {}
    addPath(path.join("/root", subPath));
  }

  for (const credPath of searchPaths) {
    if (fs.existsSync(credPath)) {
      watchedPaths.push(credPath);
      try {
        const data = JSON.parse(fs.readFileSync(credPath, "utf8"));
        if (data.default && data.default.authToken)
          tokens.push(data.default.authToken);
        for (const [key, value] of Object.entries(data)) {
          if (key !== "default" && value && value.authToken)
            tokens.push(value.authToken);
        }
        if (tokens.length > 0) break;
      } catch (e) {
        console.error("Failed to parse Freebuff CLI credentials:", e.message);
      }
    }
  }
  const accounts = [];
  for (const credPath of watchedPaths) {
    try {
      const data = JSON.parse(fs.readFileSync(credPath, "utf8"));
      const entries = [];
      if (data.default) entries.push(data.default);
      entries.push(
        ...Object.values(data).filter(
          (value) =>
            value && typeof value === "object" && value !== data.default,
        ),
      );
      for (const entry of entries) {
        if (!entry || !entry.authToken) continue;
        const user = entry.user || entry.account || {};
        accounts.push({
          token: entry.authToken,
          accountId: entry.accountId || entry.userId || user.id || null,
          email: entry.email || user.email || null,
          source: "cli",
        });
      }
    } catch (_) {}
  }
  return { tokens, accounts, watchedPaths };
}

// ─── Config Load / Save (uses extracted factory + inline CLI loader) ───
function loadConfig() {
  const rootDir = __dirname;
  return loadConfigFactory({
    rootDir,
    loadCLITokens: loadFreebuffCLITokens,
    parseDuration,
    logInfo,
  });
}
function saveConfig(cfg) {
  return saveConfigFactory(__dirname, cfg);
}

// ─── State Persistence ───
const stateStore = createStateStore(__dirname, logWarn);

function loadState() {
  return stateStore.load();
}
function saveState(state) {
  return stateStore.save(state);
}

// ─── Version Checks ───
async function checkAndUpdateVersions() {
  const updates = [];
  try {
    const { status, data } = await httpGet(FREEBUFF2API_RS_SOURCE, {
      headers: { Accept: "text/plain" },
    });
    if (status === 200) {
      const bunMatch = data.match(/"Bun\/(\d+\.\d+\.\d+)"/);
      if (bunMatch && bunMatch[1] !== runtime.bunVersion) {
        updates.push(`Bun: ${runtime.bunVersion} -> ${bunMatch[1]}`);
        runtime.bunVersion = bunMatch[1];
      }
    }
  } catch (e) {
    console.error(`[Versions] Failed to fetch RS source: ${e.message}`);
  }
  try {
    const { status: npmStatus, data: npmData } = await httpGet(
      "https://registry.npmjs.org/freebuff/latest",
    );
    if (npmStatus === 200) {
      try {
        const pkg = JSON.parse(npmData);
        if (pkg.version && pkg.version !== runtime.freebuffCliVersion) {
          updates.push(
            `Freebuff-CLI: ${runtime.freebuffCliVersion} -> ${pkg.version}`,
          );
          runtime.freebuffCliVersion = pkg.version;
          runtime.aiSdkCompatVersion = pkg.version;
        }
      } catch (e) {}
    }
  } catch (e) {
    console.error(`[Versions] Failed to fetch npm registry: ${e.message}`);
  }
  if (updates.length > 0) {
    console.log(`[Versions] Updated: ${updates.join(", ")}`);
    return true;
  }
  return false;
}

async function checkProxyVersion() {
  try {
    const { status, data } = await httpGet(
      `https://registry.npmjs.org/${NPM_PACKAGE_NAME}/latest`,
    );
    if (status !== 200) return;
    const pkg = JSON.parse(data);
    const latest = pkg.version;
    if (!latest || versionCompare(latest, PROXY_VERSION) <= 0) return;
    const msg = `Freebuff Proxy is outdated!\n\nCurrent: v${PROXY_VERSION}\nLatest:  v${latest}\n\nUpdate with: npm install -g ${NPM_PACKAGE_NAME}\nor: cd ${__dirname} && npm install\n\nThe proxy will now close.`;
    console.log(
      `\n${"=".repeat(60)}\n  OUTDATED: v${PROXY_VERSION} -> v${latest}\n  Update: npm install -g ${NPM_PACKAGE_NAME}\n${"=".repeat(60)}\n`,
    );
    if (process.platform === "win32") {
      const vbsPath = path.join(os.tmpdir(), "freebuff_alert.vbs");
      fs.writeFileSync(
        vbsPath,
        `MsgBox "Freebuff Proxy is outdated!" & vbCrLf & vbCrLf & "Current: v${PROXY_VERSION}" & vbCrLf & "Latest:  v${latest}" & vbCrLf & vbCrLf & "Run: npm install -g ${NPM_PACKAGE_NAME}", vbExclamation, "Freebuff Proxy - Update Required"`,
      );
      const { execSync } = require("child_process");
      try {
        execSync(`cscript //nologo "${vbsPath}"`, { timeout: 30000 });
      } catch {}
      try {
        fs.unlinkSync(vbsPath);
      } catch {}
    }
    process.exit(1);
  } catch (e) {}
}

// ─── Opencode Config ───
let cachedOpencodeConfigPaths = null;
function collectAllUserOpencodePaths() {
  const paths = [];
  const candidates = [];
  if (process.platform === "win32") {
    candidates.push(
      path.join(os.homedir(), ".config", "opencode", "opencode.json"),
    );
    candidates.push(path.join(os.homedir(), ".opencode", "opencode.json"));
    const userProfiles = [
      process.env.USERPROFILE,
      process.env.HOMEDRIVE
        ? path.join(process.env.HOMEDRIVE, process.env.HOMEPATH || "")
        : null,
    ].filter(Boolean);
    const userDirs = ["C:\\Users"];
    try {
      if (fs.existsSync("C:\\Users")) {
        for (const name of fs.readdirSync("C:\\Users")) {
          userDirs.push(path.join("C:\\Users", name));
        }
      }
    } catch (_) {}
    for (const ud of userDirs) {
      candidates.push(path.join(ud, ".config", "opencode", "opencode.json"));
      candidates.push(path.join(ud, ".opencode", "opencode.json"));
    }
    if (fs.existsSync("C:\\Windows\\system32\\config\\systemprofile")) {
      candidates.push(
        path.join(
          "C:\\Windows\\system32\\config\\systemprofile",
          ".config",
          "opencode",
          "opencode.json",
        ),
      );
      candidates.push(
        path.join(
          "C:\\Windows\\system32\\config\\systemprofile",
          ".opencode",
          "opencode.json",
        ),
      );
    }
    if (fs.existsSync("C:\\Windows\\ServiceProfiles\\LocalService")) {
      candidates.push(
        path.join(
          "C:\\Windows\\ServiceProfiles\\LocalService",
          ".config",
          "opencode",
          "opencode.json",
        ),
      );
      candidates.push(
        path.join(
          "C:\\Windows\\ServiceProfiles\\LocalService",
          ".opencode",
          "opencode.json",
        ),
      );
    }
    if (fs.existsSync("C:\\Windows\\ServiceProfiles\\NetworkService")) {
      candidates.push(
        path.join(
          "C:\\Windows\\ServiceProfiles\\NetworkService",
          ".config",
          "opencode",
          "opencode.json",
        ),
      );
      candidates.push(
        path.join(
          "C:\\Windows\\ServiceProfiles\\NetworkService",
          ".opencode",
          "opencode.json",
        ),
      );
    }
  } else {
    candidates.push(
      path.join(os.homedir(), ".config", "opencode", "opencode.json"),
    );
    candidates.push(path.join(os.homedir(), ".opencode", "opencode.json"));
    try {
      const passwd = fs.readFileSync("/etc/passwd", "utf8");
      for (const line of passwd.split("\n")) {
        const home = line.split(":")[5];
        if (home) {
          candidates.push(
            path.join(home, ".config", "opencode", "opencode.json"),
          );
          candidates.push(path.join(home, ".opencode", "opencode.json"));
        }
      }
    } catch (_) {}
  }
  for (const p of candidates) {
    if (p && !paths.includes(p)) paths.push(p);
  }
  return paths;
}

function discoverOpencodeConfigsAsync() {
  if (cachedOpencodeConfigPaths !== null)
    return Promise.resolve([...cachedOpencodeConfigPaths]);
  const fallbackPaths = collectAllUserOpencodePaths();
  const existingFallbacks = [
    ...new Set(fallbackPaths.filter((p) => fs.existsSync(path.dirname(p)))),
  ];
  const command =
    process.platform === "win32"
      ? `powershell -NoProfile -NonInteractive -Command "Get-ChildItem -Path C:\\Users,C:\\Windows\\system32\\config,C:\\Windows\\ServiceProfiles -Recurse -Filter 'opencode.json' -ErrorAction SilentlyContinue -Depth 5 | Select-Object -ExpandProperty FullName | Sort-Object -Unique"`
      : `bash -c "find / -maxdepth 12 -name 'opencode.json' -type f 2>/dev/null | sort -u"`;
  return new Promise((resolve) => {
    try {
      const { exec } = require("child_process");
      const child = exec(
        command,
        { timeout: 15000, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
        (err, stdout, stderr) => {
          const found = (stdout || "")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((s) => s.trim())
            .filter((s) => s.toLowerCase().endsWith("opencode.json"));
          if (found.length > 0) {
            logInfo(
              `[Opencode] Discovered ${found.length} config(s): ${found.join(", ")}`,
            );
            cachedOpencodeConfigPaths = [
              ...new Set([...existingFallbacks, ...found]),
            ].filter((p) => fs.existsSync(path.dirname(p)));
            resolve([...cachedOpencodeConfigPaths]);
            return;
          }
          logInfo(
            `[Opencode] Discovery returned no results, using fallback paths (${existingFallbacks.length})`,
          );
          cachedOpencodeConfigPaths = [...existingFallbacks];
          resolve([...cachedOpencodeConfigPaths]);
        },
      );
      if (child && child.unref) child.unref();
    } catch (e) {
      logInfo(
        `[Opencode] Discovery failed (${e.message}), using fallback paths (${existingFallbacks.length})`,
      );
      cachedOpencodeConfigPaths = [...existingFallbacks];
      resolve([...cachedOpencodeConfigPaths]);
    }
  });
}

function discoverOpencodeConfigs() {
  if (cachedOpencodeConfigPaths !== null) return [...cachedOpencodeConfigPaths];
  const fallbackPaths = collectAllUserOpencodePaths();
  return [
    ...new Set(fallbackPaths.filter((p) => fs.existsSync(path.dirname(p)))),
  ];
}

async function setupOpencodeConfig(skipRemovalSync) {
  const configPaths = await discoverOpencodeConfigsAsync();
  let firstRun = false;
  const allRegistryModels = modelRegistry.getModels();
  const registryCanonicalSet = new Set(
    allRegistryModels.map(canonicalModelName),
  );
  if (!Array.isArray(config.enabledModels)) {
    if (Array.isArray(config.legacyDisabledModels)) {
      const disabledSet = new Set(config.legacyDisabledModels);
      config.enabledModels = allRegistryModels.filter(
        (m) => !disabledSet.has(m),
      );
      logInfo(
        `[Opencode] Migrated DISABLED_MODELS -> ENABLED_MODELS (${config.enabledModels.length}/${allRegistryModels.length} models)`,
      );
    } else {
      config.enabledModels = [...allRegistryModels];
      logInfo(
        `[Opencode] Initialized ENABLED_MODELS with all ${allRegistryModels.length} models`,
      );
    }
    delete config.legacyDisabledModels;
    saveConfig(config);
  }
  const unmatchedEnabled = (config.enabledModels || []).filter(
    (m) => !registryCanonicalSet.has(canonicalModelName(m)),
  );
  if (unmatchedEnabled.length > 0)
    logWarn(
      `[Opencode] Warning: enabled models not found in registry: ${unmatchedEnabled.join(", ")}`,
    );

  for (const configFile of configPaths) {
    try {
      const dir = path.dirname(configFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const backupFile = path.join(dir, "openconfig.b4freebuff.json");
      let existing = { $schema: "https://opencode.ai/config.json" };
      if (fs.existsSync(configFile)) {
        existing = JSON.parse(fs.readFileSync(configFile, "utf8"));
        if (!fs.existsSync(backupFile)) {
          fs.copyFileSync(configFile, backupFile);
          logInfo(`[Opencode] Backup created: ${backupFile}`);
          firstRun = true;
        }
      } else {
        logInfo(
          `[Opencode] No existing config found, will create: ${configFile}`,
        );
        firstRun = true;
      }
      if (!existing.provider || typeof existing.provider !== "object")
        existing.provider = {};
      const existingModels =
        existing.provider["freebuff"] &&
        existing.provider["freebuff"].models &&
        Object.keys(existing.provider["freebuff"].models).length > 0
          ? Object.keys(existing.provider["freebuff"].models).map(
              canonicalModelName,
            )
          : null;
      if (existingModels && existingModels.length > 0 && !skipRemovalSync) {
        const enabledSet = new Set(
          (config.enabledModels || []).map(canonicalModelName),
        );
        const removedFromProvider = allRegistryModels.filter(
          (m) =>
            enabledSet.has(canonicalModelName(m)) &&
            !existingModels.includes(canonicalModelName(m)),
        );
        if (removedFromProvider.length > 0) {
          config.enabledModels = config.enabledModels.filter(
            (m) => !removedFromProvider.includes(canonicalModelName(m)),
          );
          saveConfig(config);
          for (const rm of removedFromProvider)
            logInfo(
              `[Opencode] Detected manual removal of ${rm}, removed from ENABLED_MODELS`,
            );
        }
      }
      let enabledSet = new Set(
        (config.enabledModels || []).map(canonicalModelName),
      );
      let models = {};
      for (const m of allRegistryModels) {
        if (!enabledSet.has(canonicalModelName(m))) {
          logDebug(`[Opencode] Skipping non-enabled model: ${m}`);
          continue;
        }
        const meta = modelRegistry.getModelMetadata(m);
        const name =
          meta && meta.premium
            ? `[LIM] ${modelRegistry.getDisplayName(m)}`
            : modelRegistry.getDisplayName(m);
        const entry = { name, reasoning: true };
        if (meta) {
          if (meta.modalities) entry.modalities = meta.modalities;
          const limit = modelRegistry.normalizeOpenCodeLimit(meta.limit);
          if (limit) entry.limit = limit;
        }
        models[m] = entry;
      }
      if (Object.keys(models).length === 0 && allRegistryModels.length > 0) {
        logWarn(
          `[Opencode] Warning: no enabled models matched registry; falling back to all ${allRegistryModels.length} registry models`,
        );
        for (const m of allRegistryModels) {
          const meta = modelRegistry.getModelMetadata(m);
          const name =
            meta && meta.premium
              ? `[LIM] ${modelRegistry.getDisplayName(m)}`
              : modelRegistry.getDisplayName(m);
          const entry = { name, reasoning: true };
          if (meta) {
            if (meta.modalities) entry.modalities = meta.modalities;
            const limit = modelRegistry.normalizeOpenCodeLimit(meta.limit);
            if (limit) entry.limit = limit;
          }
          models[m] = entry;
        }
      }
      logInfo(
        `[Opencode] Writing ${Object.keys(models).length}/${allRegistryModels.length} models to ${configFile}`,
      );
      existing.provider["freebuff"] = {
        npm: "@ai-sdk/openai-compatible",
        name: "Freebuff Proxy",
        options: {
          baseURL: `http://localhost:${config.listenPort || 8080}/v1`,
        },
        models,
      };
      fs.writeFileSync(configFile, JSON.stringify(existing, null, 2));
      logInfo(`[Opencode] Config updated: ${configFile}`);
    } catch (e) {
      logError(`[Opencode] Failed to update ${configFile}: ${e.message}`);
    }
  }
  return firstRun;
}

// ─── Build agent validation payload (needed by UpstreamClient) ───
function buildAgentValidationPayload() {
  const agents = [
    {
      id: "base2-free",
      model: "minimax/minimax-m2.7",
      spawnable: [CONTEXT_PRUNER_AGENT_ID],
    },
    {
      id: "base2-free-minimax-m3",
      model: "minimax/minimax-m3",
      spawnable: [CONTEXT_PRUNER_AGENT_ID],
    },
    {
      id: "base2-free-kimi",
      model: "moonshotai/kimi-k2.6",
      spawnable: [CONTEXT_PRUNER_AGENT_ID],
    },
    {
      id: "base2-free-deepseek",
      model: "deepseek/deepseek-v4-pro",
      spawnable: [CONTEXT_PRUNER_AGENT_ID],
    },
    {
      id: "base2-free-deepseek-flash",
      model: "deepseek/deepseek-v4-flash",
      spawnable: [CONTEXT_PRUNER_AGENT_ID],
    },
    {
      id: "base2-free-mimo-pro",
      model: "mimo/mimo-v2.5-pro",
      spawnable: [CONTEXT_PRUNER_AGENT_ID],
    },
    {
      id: "base2-free-mimo",
      model: "mimo/mimo-v2.5",
      spawnable: [CONTEXT_PRUNER_AGENT_ID],
    },
    {
      id: CONTEXT_PRUNER_AGENT_ID,
      model: "deepseek/deepseek-v4-flash",
      spawnable: [],
    },
  ];
  return {
    agentDefinitions: agents.map((a) => ({
      id: a.id,
      publisher: "codebuff",
      model: a.model,
      displayName: `Freebuff ${a.model}`,
      spawnerPrompt: "Freebuff OpenAI-compatible orchestrator",
      inputSchema: {
        prompt: { type: "string", description: "A coding task to complete" },
        params: { type: "object", properties: {}, required: [] },
      },
      outputMode: "last_message",
      includeMessageHistory: true,
      toolNames: a.spawnable.length > 0 ? ["spawn_agents"] : [],
      spawnableAgents: a.spawnable,
      systemPrompt: "Act as a helpful coding assistant.",
    })),
  };
}

// ─── Gemini helpers ───
function isGeminiModel(canonicalModel) {
  return canonicalModel.startsWith("google/gemini-");
}
function getGeminiSubagentId(canonicalModel) {
  if (GEMINI_SUBAGENT_IDS[canonicalModel])
    return GEMINI_SUBAGENT_IDS[canonicalModel];
  if (canonicalModel.includes("pro")) return "thinker-with-files-gemini";
  return "basher";
}

// ─── Session / run validation helpers ───
function isSessionInvalid(statusCode, errorBody) {
  if (statusCode === 426) return true;
  if (statusCode < 400) return false;
  try {
    const payload = JSON.parse(errorBody);
    const error = payload.error || payload.code || "";
    return [
      "freebuff_update_required",
      "waiting_room_required",
      "waiting_room_queued",
      "session_superseded",
      "session_expired",
      "session_model_mismatch",
    ].includes(error);
  } catch (e) {
    return false;
  }
}
function isRunInvalid(statusCode, body) {
  if (statusCode !== 400) return false;
  const msg = body.toLowerCase();
  return msg.includes("runid not found") || msg.includes("runid not running");
}

// ─── Country Detection ───
async function detectCountry() {
  try {
    const resp = await fetch("https://ipapi.co/json/", {
      signal: AbortSignal.timeout(5000),
    });
    if (resp.ok) {
      const data = await resp.json();
      if (data.country_code) {
        runtime.detectedCountry = data.country_code;
        console.log(`[Country] Detected: ${runtime.detectedCountry}`);
        return;
      }
    }
  } catch (_) {}
  try {
    const resp = await fetch("https://ipinfo.io/json", {
      signal: AbortSignal.timeout(5000),
    });
    if (resp.ok) {
      const data = await resp.json();
      if (data.country) {
        runtime.detectedCountry = data.country;
        console.log(`[Country] Detected: ${runtime.detectedCountry}`);
        return;
      }
    }
  } catch (_) {}
  console.log("[Country] Could not detect country");
}

// ─── Token File Watcher ───
let tokenWatcherDebounce = null;
let tokenWatchers = [];
function startTokenFileWatcher(paths) {
  if (!paths || paths.length === 0) return () => {};
  const watched = new Set();
  for (const credPath of paths) {
    if (watched.has(credPath)) continue;
    try {
      const watcher = fs.watch(credPath, { persistent: false }, (eventType) => {
        if (tokenWatcherDebounce) clearTimeout(tokenWatcherDebounce);
        tokenWatcherDebounce = setTimeout(async () => {
          logInfo(
            `[Token Watch] Credential file changed: ${credPath} (${eventType})`,
          );
          const { tokens: newCliTokens } = loadFreebuffCLITokens();
          const oldTokens = new Set(config.authTokens || []);
          const added = newCliTokens.filter((t) => !oldTokens.has(t));
          const removed = [];
          if (added.length > 0) {
            logInfo(`[Token Watch] ${added.length} new token(s) detected`);
            for (const token of added) {
              await accountMgr.resolveAndReconcileToken(
                token,
                (loadFreebuffCLITokens().accounts || []).find(
                  (account) => account.token === token,
                ) || {},
                new UpstreamClient(config),
              );
              const result = await tokenValidation.validateToken(token);
              if (result.valid) {
                config.authTokens.push(token);
                logInfo(
                  `[Token Watch] Added token: ${token.substring(0, 8)}...`,
                );
              } else
                logWarn(
                  `[Token Watch] Skipped invalid token: ${token.substring(0, 8)}... (${result.status})`,
                );
            }
          }
          if (removed.length > 0) {
            logInfo(
              `[Token Watch] ${removed.length} token(s) removed from credentials`,
            );
            config.authTokens = config.authTokens.filter(
              (t) => !removed.includes(t),
            );
            if (config.tokenEmails) {
              for (const t of removed) delete config.tokenEmails[t];
            }
          }
          if (added.length > 0 || removed.length > 0) {
            saveConfig(config);
            await tokenValidation.reloadTokenPool();
            logInfo(
              `[Token Watch] TokenPool reloaded: ${config.authTokens.length} token(s)`,
            );
          }
        }, 1000);
      });
      watched.add(credPath);
      tokenWatchers.push(watcher);
      logDebug(`[Token Watch] Watching ${credPath}`);
    } catch (e) {
      logWarn(`[Token Watch] Could not watch ${credPath}: ${e.message}`);
    }
  }
  return () => {
    for (const watcher of tokenWatchers) watcher.close();
    tokenWatchers = [];
    if (tokenWatcherDebounce) clearTimeout(tokenWatcherDebounce);
    tokenWatcherDebounce = null;
  };
}

// ─── Factory Instantiation ───
const ModelRegistryClass = createModelRegistry({
  getConfig: () => config,
  modelRefreshInterval: MODEL_REFRESH_INTERVAL,
  sourceUrls: {
    models: FREEBUFF_MODELS_SOURCE_URL,
    agents: FREE_AGENTS_SOURCE_URL,
    ids: FREEBUFF_MODEL_IDS_SOURCE_URL,
    config: MODEL_CONFIG_SOURCE_URL,
  },
  isBlacklistedModel,
  canonicalModelName,
  logInfo,
  logError,
});

const UpstreamClientClass = createUpstreamClient({
  CODEBUFF_ACCEPT_ENCODING,
  CODEBUFF_JSON_USER_AGENT,
  FREEBUFF_CLI_USER_AGENT,
  getChatUserAgent,
  logDebug,
  logInfo,
  logWarn,
  logError,
  debugLog,
  buildAgentValidationPayload,
  normalizeAdMessages,
  nodeFetch,
  fetch: globalThis.fetch,
});

const runChains = createRunChains({
  contextPrunerAgentId: CONTEXT_PRUNER_AGENT_ID,
  geminiParentAgentId: GEMINI_PARENT_AGENT_ID,
  getGeminiSubagentId,
  isGeminiModel,
  logError,
});

const TokenPoolClass = createTokenPool({
  loadState,
  saveState,
  extractQuota: (state) => {
    if (!state || typeof state !== "object") return null;
    const direct =
      state.rateLimit ||
      state.rate_limit ||
      state.usage ||
      state.quota ||
      state.data?.rateLimit ||
      state.data?.rate_limit ||
      state.data?.quota;
    if (direct) return direct;
    const limits = state.rateLimitsByModel || state.data?.rateLimitsByModel;
    if (!limits || typeof limits !== "object") return null;
    const modelQuota =
      (state.model && limits[state.model]) || Object.values(limits)[0];
    if (!modelQuota || typeof modelQuota !== "object") return null;
    return {
      ...modelQuota,
      model: state.model || modelQuota.model || null,
      rateLimitsByModel: limits,
    };
  },
  quotaSummary: (quota) => {
    const models =
      quota?.rateLimitsByModel && typeof quota.rateLimitsByModel === "object"
        ? Object.values(quota.rateLimitsByModel).filter(
            (v) => v && Number(v.limit) > 0,
          )
        : [];
    if (models.length > 0) {
      const selected = models.reduce((best, value) => {
        const remaining = Math.max(
          0,
          Number(value.limit) - Number(value.recentCount || 0),
        );
        return !best || remaining > best.remaining
          ? { value, remaining }
          : best;
      }, null);
      return {
        used: Number(selected.value.recentCount) || 0,
        limit: Number(selected.value.limit) || 0,
        resetAt: selected.value.resetAt || quota.resetAt || null,
      };
    }
    return {
      used: Number(quota?.recentCount) || 0,
      limit: Number(quota?.limit) || 0,
      resetAt: quota?.resetAt || null,
    };
  },
  logDebug,
  logInfo,
  logWarn,
  logError,
  pushEvent,
});

const accountMgr = createAccountManager({
  crypto,
  getConfig: () => config,
  getTokenPool: () => tokenPool,
  saveConfig,
  logInfo,
  logDebug,
  logWarn,
  logError,
});

const tokenValidation = createTokenValidation({
  getConfig: () => config,
  setConfig: (c) => {
    config = c;
  },
  getTokenPool: () => tokenPool,
  setTokenPool: (tp) => {
    tokenPool = tp;
  },
  loadConfig,
  TokenPool: TokenPoolClass,
  UpstreamClient: UpstreamClientClass,
  logError,
  logWarn,
  logInfo,
  extractQuota: (state) => {
    if (!state || typeof state !== "object") return null;
    const direct =
      state.rateLimit ||
      state.rate_limit ||
      state.usage ||
      state.quota ||
      state.data?.rateLimit ||
      state.data?.rate_limit ||
      state.data?.quota;
    if (direct) return direct;
    const limits = state.rateLimitsByModel || state.data?.rateLimitsByModel;
    if (!limits || typeof limits !== "object") return null;
    const modelQuota =
      (state.model && limits[state.model]) || Object.values(limits)[0];
    if (!modelQuota || typeof modelQuota !== "object") return null;
    return {
      ...modelQuota,
      model: state.model || modelQuota.model || null,
      rateLimitsByModel: limits,
    };
  },
});

const errorWriters = createErrorWriters({ http });
const responseWriters = createResponseWriters({
  isNodeStream,
  readBodyText,
  convertOpenAINonStreamResponseToClaude,
});

const proxyChatRequestFn = createProxyChatRequest({
  canonicalModelName,
  FALLBACK_AGENT_IDS,
  GEMINI_PARENT_AGENT_ID,
  crypto,
  markAccountUsed: accountMgr.markAccountUsed,
  logModelMismatch,
  logInfo,
  logWarn,
  logError,
  logDebug,
  debugLog,
  pushEvent,
  isGeminiModel,
  getGeminiSubagentId,
  startRunChainGemini: runChains.startGemini,
  startRunChainNormal: runChains.startNormal,
  finalizeRunChainGemini: runChains.finalizeGemini,
  finalizeRunChainNormal: runChains.finalizeNormal,
  normalizeChatMessages,
  cloneMap,
  normalizeToolSchemas,
  generateClientSessionId,
  readBodyText,
  isSessionInvalid,
  isRunInvalid,
  getTokenPool: () => tokenPool,
  getModelRegistry: () => modelRegistry,
});

const httpHandlers = createHttpHandlers({
  getConfig: () => config,
  getTokenPool: () => tokenPool,
  getModelRegistry: () => modelRegistry,
  startTime,
  runtime,
  MODEL_MISMATCH_LOG,
  EVENT_LOG,
  http,
  fs,
  path,
  url,
  crypto,
  debounceRequest,
  proxyChatRequest: proxyChatRequestFn,
  setupOpencodeConfig,
  saveConfig,
  reloadTokenPool: tokenValidation.reloadTokenPool,
  probeNewModels: tokenValidation.probeNewModels,
  resolveAndReconcileToken: accountMgr.resolveAndReconcileToken,
  UpstreamClient: UpstreamClientClass,
  getAdsUserAgent,
  loadFreebuffCLITokens,
  FREEBUFF_MODELS_SOURCE_URL,
  FREEBUFF_MODEL_IDS_SOURCE_URL,
  FREE_AGENTS_SOURCE_URL,
  MODEL_CONFIG_SOURCE_URL,
  MODEL_REFRESH_INTERVAL,
  logDebug,
  logInfo,
  logWarn,
  logError,
  accountForToken: accountMgr.accountForToken,
  accountCheckInfo: accountMgr.accountCheckInfo,
  mergeQuotaSources: accountMgr.mergeQuotaSources,
  errorWriters,
  requestUtilities: {
    isNodeStream,
    readBodyText,
    pipeBodyToResponse,
    countOpenAIPayloadTokens,
  },
  responseWriters,
  anthropicRequests: {
    convertClaudeMessagesRequestToOpenAI,
    convertOpenAINonStreamResponseToClaude,
  },
  IS_BUN,
  RUNTIME_VERSION,
});

// ─── Server Startup ───
async function startServer() {
  console.log(
    "╔═══════════════════════════════════════════════════════════════╗",
  );
  console.log(
    "║  Freebuff2Opencode Proxy - Starting...                        ║",
  );
  console.log(
    "╚═══════════════════════════════════════════════════════════════╝",
  );

  try {
    config = loadConfig();
  } catch (e) {
    console.error("Failed to load config:", e.message);
    process.exit(1);
  }

  const cliResult = loadFreebuffCLITokens();
  const cliTokens = cliResult.tokens;
  const cliAccounts = cliResult.accounts || [];
  const watchedCredentialPaths = cliResult.watchedPaths;
  if (cliTokens.length > 0) {
    logInfo(`[Config] Found ${cliTokens.length} token(s) in CLI credentials`);
    config.authTokens = [
      ...new Set([...(config.authTokens || []), ...cliTokens]),
    ];
  }

  await checkAndUpdateVersions();
  await checkProxyVersion();
  await detectCountry();
  if (config.mockCountry) {
    runtime.detectedCountry = config.mockCountry;
    logInfo(`[Country] MOCKED to: ${runtime.detectedCountry}`);
  }

  modelRegistry = new ModelRegistryClass();
  await modelRegistry.start();

  const firstRun = await setupOpencodeConfig();
  const port = config.listenPort || 8080;
  const host = config.listenHost || "127.0.0.1";

  const client = new UpstreamClientClass(config);
  await accountMgr.reconcileAllTokenAccounts(cliAccounts, client);
  const allTokenResults = await tokenValidation.validateAllTokens();
  const validTokens = allTokenResults.filter((r) => r.valid);

  tokenPool = new TokenPoolClass(config.authTokens, config, client);
  for (const result of allTokenResults) {
    tokenPool.setTokenHealth(result.token, result);
    if (result.session && result.session.instanceId) {
      const session = tokenPool._sessionFromState(result.session);
      const model =
        result.session.model || session.model || result.lockedModel || "";
      if (model)
        tokenPool.sessions.set(
          tokenPool.sessionKey(result.token, model),
          session,
        );
      if (session.rateLimit)
        tokenPool.updateTokenUsage(result.token, model, session.rateLimit);
      if (result.lockedModel)
        tokenPool.lockedModels.set(result.token, result.lockedModel);
    }
  }

  if (validTokens.length === 0 && config.authTokens.length > 0) {
    logWarn(
      `No tokens passed validation; ${config.authTokens.length} configured token(s) will remain visible but skipped`,
    );
  }

  const server = http.createServer((req, res) => {
    res.setTimeout(config.requestTimeout);
    httpHandlers.handleRequest(req, res).catch((error) => {
      logError(`[HTTP] Request failed: ${error.message}`);
      if (!res.headersSent && !res.destroyed) {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: { message: "Internal server error", type: "server_error" } }));
      }
    });
  });
  activeServer = server;
  server.headersTimeout = 15_000;
  server.requestTimeout = config.requestTimeout;
  server.keepAliveTimeout = 5_000;
  server.listen(port, host, () => {
    logInfo(`\nFreebuff2Opencode Proxy on http://${host}:${port}`);
    logInfo(`  Upstream: ${config.upstreamBaseURL}`);
    logInfo(`  Models: ${modelRegistry.getModels().length}`);
    logInfo(
      `  API keys: ${config.apiKeys.length > 0 ? config.apiKeys.length + " (auth enabled)" : "none (open access)"}`,
    );
    logInfo(
      `  Valid tokens: ${validTokens.length} / ${config.authTokens.length}`,
    );
    logInfo("");
    if (firstRun) {
      const dashboardUrl = `http://localhost:${port}`;
      if (process.platform === "win32")
        require("child_process").exec(`start "" "${dashboardUrl}"`);
      else if (process.platform === "darwin")
        require("child_process").exec(`open "${dashboardUrl}"`);
      else require("child_process").exec(`xdg-open "${dashboardUrl}"`);
    }
  });

  stopTokenWatcher = startTokenFileWatcher(watchedCredentialPaths);

  activeIntervals.push(setInterval(async () => {
    const cliResult = loadFreebuffCLITokens();
    const cliTokens = cliResult.tokens;
    const cliAccounts = cliResult.accounts || [];
    const currentTokens = new Set(config.authTokens || []);
    const newTokens = cliTokens.filter((t) => !currentTokens.has(t));
    const removedTokens = [];
    let changed = false;
    if (newTokens.length > 0) {
      logInfo(`Found ${newTokens.length} new token(s) in CLI credentials`);
      for (const token of newTokens) {
        await accountMgr.resolveAndReconcileToken(
          token,
          cliAccounts.find((account) => account.token === token) || {},
          new UpstreamClientClass(config),
        );
        const result = await tokenValidation.validateToken(token);
        if (result.valid) {
          config.authTokens.push(token);
          logInfo(`Added valid token: ${token.substring(0, 8)}...`);
          changed = true;
        } else
          logWarn(
            `Skipped invalid new token: ${token.substring(0, 8)}... (${result.status})`,
          );
      }
    }
    if (removedTokens.length > 0) {
      logInfo(`${removedTokens.length} token(s) removed from CLI credentials`);
      config.authTokens = config.authTokens.filter(
        (t) => !removedTokens.includes(t),
      );
      if (config.tokenEmails) {
        for (const t of removedTokens) delete config.tokenEmails[t];
      }
      changed = true;
    }
    if (changed) {
      saveConfig(config);
      await tokenValidation.reloadTokenPool();
    }
  }, TOKEN_RELOAD_INTERVAL));

  const revalidationInterval = config.tokenRevalidateInterval || 5 * 60 * 1000;
  activeIntervals.push(setInterval(async () => {
    if (!tokenPool || !config.authTokens || config.authTokens.length === 0)
      return;
    logInfo("Re-validating configured tokens...");
    await accountMgr.reconcileAllTokenAccounts([], tokenPool.client);
    const results = await tokenValidation.validateAllTokens();
    for (const result of results) {
      const previous = tokenPool.getTokenHealth(result.token);
      tokenPool.setTokenHealth(result.token, result);
      if (previous.status !== result.status) {
        if (result.valid)
          logInfo(`Token ${result.token.substring(0, 8)}... became active`);
        else
          logWarn(
            `Token ${result.token.substring(0, 8)}... became ${result.status}`,
          );
      }
      if (
        !result.valid &&
        (result.status === "banned" || result.status === "unauthorized")
      )
        await tokenPool.endAllSessionsForToken(result.token);
    }
  }, revalidationInterval));

  activeIntervals.push(setInterval(async () => {
    if (!tokenPool || !config.authTokens || config.authTokens.length === 0)
      return;
    const client = new UpstreamClientClass(config);
    await tokenPool.refreshQuota(client);
  }, 90 * 1000));

  activeIntervals.push(setInterval(async () => {
    try {
      await accountMgr.checkIdleAccounts();
    } catch (e) {
      logWarn(`[Account] Idle check failed: ${e.message}`);
    }
  }, 12 * 1000));

  activeIntervals.push(setInterval(
    async () => {
      try {
        await checkAndUpdateVersions();
      } catch (e) {}
      try {
        await checkProxyVersion();
      } catch (e) {}
    },
    60 * 60 * 1000,
  ));
}

async function stopServer() {
  for (const timer of activeIntervals) clearInterval(timer);
  activeIntervals = [];
  stopTokenWatcher();
  stopTokenWatcher = () => {};
  if (!activeServer) return;
  const server = activeServer;
  activeServer = null;
  await new Promise((resolve) => {
    const timeout = setTimeout(resolve, 5000);
    server.close(() => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

process.once("SIGINT", () => stopServer().finally(() => process.exit(0)));
process.once("SIGTERM", () => stopServer().finally(() => process.exit(0)));

module.exports = { startServer, stopServer };
if (require.main === module) startServer();
