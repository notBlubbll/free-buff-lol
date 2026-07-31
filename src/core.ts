const fs = require("fs");
const path = require("path");
const https = require("https");

const rootDir = path.join(__dirname, "..");

const FREE_AGENTS_SOURCE_URL =
  "https://raw.githubusercontent.com/CodebuffAI/codebuff/main/common/src/constants/free-agents.ts";
const FREEBUFF_MODELS_SOURCE_URL =
  "https://raw.githubusercontent.com/CodebuffAI/codebuff/main/common/src/constants/freebuff-models.ts";
const FREEBUFF_MODEL_IDS_SOURCE_URL =
  "https://raw.githubusercontent.com/CodebuffAI/codebuff/main/common/src/constants/freebuff-model-ids.ts";
const MODEL_CONFIG_SOURCE_URL =
  "https://raw.githubusercontent.com/CodebuffAI/codebuff/main/common/src/constants/model-config.ts";
const MODEL_REFRESH_INTERVAL = 6 * 60 * 60 * 1000;
const TOKEN_RELOAD_INTERVAL = 5 * 60 * 1000;
const FREEBUFF2API_RS_SOURCE =
  "https://raw.githubusercontent.com/XxxXTeam/freebuff2api_rs/main/src/codebuff.rs";
const PROXY_VERSION = "1.0.0";
const NPM_PACKAGE_NAME = "freebuff-proxy";

const IS_BUN = typeof Bun !== "undefined";
const RUNTIME_VERSION = IS_BUN ? Bun.version : process.version.replace("v", "");
const runtime = {
  bunVersion: "1.3.11",
  aiSdkProviderUtilsVersion: "3.0.20",
  freebuffCliVersion: "0.0.96",
  aiSdkCompatVersion: "0.0.96",
  detectedCountry: null,
};

const LOG_LEVEL = process.env.LOG_LEVEL || "info";
const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
function logAt(level, ...args) {
  if ((LOG_LEVELS[level] || 0) <= (LOG_LEVELS[LOG_LEVEL] || 2))
    console.log(`[${level.toUpperCase()}]`, ...args);
}
function logDebug(...args) {
  logAt("debug", ...args);
}
function logInfo(...args) {
  logAt("info", ...args);
}
function logWarn(...args) {
  logAt("warn", ...args);
}
function logError(...args) {
  logAt("error", ...args);
}

let lastRequest = 0;
async function debounceRequest() {
  const elapsed = Date.now() - lastRequest;
  if (elapsed < 1300)
    await new Promise((resolve) => setTimeout(resolve, 1300 - elapsed));
  lastRequest = Date.now();
}

const CANONICAL_MODEL_ALIASES = {
  "deepseek-v4-pro": "deepseek/deepseek-v4-pro",
  "deepseek-v4-flash": "deepseek/deepseek-v4-flash",
  "deepseek-v3.1-terminus": "deepseek/deepseek-v4-pro",
  "mimo-v2.5-pro": "mimo/mimo-v2.5-pro",
  "mimo-v2.5": "mimo/mimo-v2.5",
  "kimi-k2.6": "moonshotai/kimi-k2.6",
  "kimi-k2.7-code": "moonshotai/kimi-k2.7-code",
  "minimax-m2.7": "minimax/minimax-m2.7",
  "minimax-m3": "minimax/minimax-m3",
  "gemini-3.1-flash-lite": "google/gemini-3.1-flash-lite-preview",
  "gemini-3.1-pro": "google/gemini-3.1-pro-preview",
  "gemini-pro": "google/gemini-3.1-pro-preview",
};

const FALLBACK_AGENT_IDS = {
  "minimax/minimax-m2.7": "base2-free",
  "minimax/minimax-m3": "base2-free-minimax-m3",
  "moonshotai/kimi-k2.6": "base2-free-kimi",
  "moonshotai/kimi-k2.7-code": "base2-free-kimi",
  "deepseek/deepseek-v4-pro": "base2-free-deepseek",
  "deepseek/deepseek-v4-flash": "base2-free-deepseek-flash",
  "mimo/mimo-v2.5-pro": "base2-free-mimo-pro",
  "mimo/mimo-v2.5": "base2-free-mimo",
  "google/gemini-2.5-flash-lite": "base2-free-deepseek-flash",
  "google/gemini-3.1-flash-lite-preview": "base2-free-deepseek-flash",
  "google/gemini-3.1-pro-preview": "base2-free-deepseek-flash",
};

const GEMINI_PARENT_AGENT_ID = "base2-free-deepseek-flash";
const GEMINI_SUBAGENT_IDS = {
  "google/gemini-2.5-flash-lite": "file-picker",
  "google/gemini-3.1-flash-lite-preview": "basher",
  "google/gemini-3.1-pro-preview": "thinker-with-files-gemini",
};
const CONTEXT_PRUNER_AGENT_ID = "context-pruner";
const BLACKLISTED_MODEL_PATTERNS = [/glm/i];
const CODEBUFF_ACCEPT_ENCODING = "gzip, deflate";
const CODEBUFF_JSON_USER_AGENT = "Bun/1.3.11";
const FREEBUFF_CLI_USER_AGENT = "Freebuff-CLI/0.0.105";

function isBlacklistedModel(modelId) {
  return (
    !!modelId &&
    typeof modelId === "string" &&
    BLACKLISTED_MODEL_PATTERNS.some((re) => re.test(modelId))
  );
}
function canonicalModelName(model) {
  return CANONICAL_MODEL_ALIASES[model] || model;
}
function getApiUserAgent() {
  return `Bun/${runtime.bunVersion}`;
}
function getChatUserAgent() {
  return `ai-sdk/openai-compatible/0.0.0-test/codebuff ai-sdk/provider-utils/${runtime.aiSdkProviderUtilsVersion} runtime/browser`;
}
function getAdsUserAgent() {
  return `Freebuff-CLI/${runtime.freebuffCliVersion}`;
}

const debugLogPath = path.join(rootDir, ".config", "debug-luna.log");
function debugLog(entry) {
  try {
    const configDir = path.join(rootDir, ".config");
    if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
    fs.appendFileSync(
      debugLogPath,
      JSON.stringify({ ts: new Date().toISOString(), ...entry }, null, 2) +
        "\n---\n",
    );
  } catch (_) {}
}

async function httpGet(requestUrl, options = {}) {
  return new Promise((resolve) => {
    const req = https.get(
      requestUrl,
      {
        headers: { Accept: "application/json", ...options.headers },
        timeout: 10000,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve({ status: res.statusCode, data }));
      },
    );
    req.on("error", () => resolve({ status: 0, data: "" }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ status: 0, data: "" });
    });
  });
}

function versionCompare(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

function parseDuration(value) {
  if (typeof value === "number") return value;
  const match = String(value || "")
    .trim()
    .match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/i);
  if (!match) return 0;
  const amount = Number(match[1]);
  return (
    amount *
    { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 }[
      match[2]?.toLowerCase() || "ms"
    ]
  );
}

module.exports = {
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
  CANONICAL_MODEL_ALIASES,
  FALLBACK_AGENT_IDS,
  GEMINI_PARENT_AGENT_ID,
  GEMINI_SUBAGENT_IDS,
  CONTEXT_PRUNER_AGENT_ID,
  CODEBUFF_ACCEPT_ENCODING,
  CODEBUFF_JSON_USER_AGENT,
  FREEBUFF_CLI_USER_AGENT,
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
};
