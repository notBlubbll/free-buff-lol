const fs = require("fs");
const path = require("path");

function loadConfig({ rootDir, loadCLITokens, parseDuration, logInfo }) {
  const configPath = path.join(rootDir, ".config", "config.json");
  let rawConfig = {
    LISTEN_ADDR: "127.0.0.1:8080",
    UPSTREAM_BASE_URL: "https://www.codebuff.com",
    REQUEST_TIMEOUT: "15m",
    LOG_LEVEL: "info",
    TOKEN_REVALIDATE_INTERVAL: "5m",
  };
  if (fs.existsSync(configPath)) {
    try {
      rawConfig = {
        ...rawConfig,
        ...JSON.parse(fs.readFileSync(configPath, "utf8")),
      };
    } catch (error) {
      console.error("Failed to parse config.json:", error.message);
    }
  }
  const env = process.env;
  if (env.LISTEN_ADDR) rawConfig.LISTEN_ADDR = env.LISTEN_ADDR;
  if (env.UPSTREAM_BASE_URL)
    rawConfig.UPSTREAM_BASE_URL = env.UPSTREAM_BASE_URL;
  if (env.REQUEST_TIMEOUT) rawConfig.REQUEST_TIMEOUT = env.REQUEST_TIMEOUT;
  if (env.AUTH_TOKENS)
    rawConfig.AUTH_TOKENS = env.AUTH_TOKENS.split(",")
      .map((t) => t.trim())
      .filter(Boolean);
  if (env.API_KEYS)
    rawConfig.API_KEYS = env.API_KEYS.split(",")
      .map((t) => t.trim())
      .filter(Boolean);
  if (env.ENABLED_MODELS)
    rawConfig.ENABLED_MODELS = env.ENABLED_MODELS.split(",")
      .map((t) => t.trim())
      .filter(Boolean);
  if (env.MOCK_COUNTRY)
    rawConfig.MOCK_COUNTRY = env.MOCK_COUNTRY.trim().toUpperCase();
  if (env.LOG_LEVEL) rawConfig.LOG_LEVEL = env.LOG_LEVEL;
  if (env.TOKEN_REVALIDATE_INTERVAL)
    rawConfig.TOKEN_REVALIDATE_INTERVAL = env.TOKEN_REVALIDATE_INTERVAL;

  if (!rawConfig.AUTH_TOKENS || rawConfig.AUTH_TOKENS.length === 0) {
    const result = loadCLITokens();
    const tokens = result.tokens || result;
    if (tokens.length > 0) {
      rawConfig.AUTH_TOKENS = tokens;
      logInfo(`Loaded ${tokens.length} token(s) from Freebuff CLI`);
    }
  }

  const requestTimeout = parseDuration(rawConfig.REQUEST_TIMEOUT);
  const tokenRevalidateInterval = parseDuration(
    rawConfig.TOKEN_REVALIDATE_INTERVAL,
  );
  if (!rawConfig.LISTEN_ADDR) throw new Error("LISTEN_ADDR cannot be empty");
  if (!rawConfig.UPSTREAM_BASE_URL)
    throw new Error("UPSTREAM_BASE_URL cannot be empty");
  if (requestTimeout <= 0)
    throw new Error("REQUEST_TIMEOUT must be greater than zero");
  if (tokenRevalidateInterval <= 0)
    throw new Error("TOKEN_REVALIDATE_INTERVAL must be greater than zero");

  let baseURL = rawConfig.UPSTREAM_BASE_URL.trim().replace(/\/+$/, "");
  try {
    const parsed = new URL(baseURL);
    if (parsed.host.toLowerCase() === "codebuff.com") {
      parsed.host = "www.codebuff.com";
      baseURL = parsed.toString().replace(/\/+$/, "");
    }
  } catch (_) {}

  const listenAddr = rawConfig.LISTEN_ADDR.trim();
  let listenHost = "127.0.0.1";
  let listenPort = 8080;
  if (listenAddr.startsWith(":")) {
    listenPort = Number.parseInt(listenAddr.substring(1), 10);
  } else {
    const separator = listenAddr.lastIndexOf(":");
    if (separator > 0) {
      listenHost = listenAddr.substring(0, separator).trim() || listenHost;
      listenPort = Number.parseInt(listenAddr.substring(separator + 1), 10);
    } else {
      listenPort = Number.parseInt(listenAddr, 10);
    }
  }
  if (!Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65535)
    throw new Error("LISTEN_ADDR must contain a valid port (1-65535)");

  return {
    listenAddr,
    listenHost,
    listenPort,
    upstreamBaseURL: baseURL,
    authTokens: [...new Set(rawConfig.AUTH_TOKENS || [])],
    tokenEmails: rawConfig.TOKEN_EMAILS || {},
    tokenAccounts: rawConfig.TOKEN_ACCOUNTS || {},
    requestTimeout,
    apiKeys: [...new Set(rawConfig.API_KEYS || [])],
    mockCountry: rawConfig.MOCK_COUNTRY || null,
    enabledModels: Array.isArray(rawConfig.ENABLED_MODELS)
      ? rawConfig.ENABLED_MODELS
      : null,
    legacyDisabledModels: Array.isArray(rawConfig.DISABLED_MODELS)
      ? rawConfig.DISABLED_MODELS
      : null,
    logLevel: rawConfig.LOG_LEVEL,
    tokenRevalidateInterval,
  };
}

function saveConfig(rootDir, cfg) {
  const configDir = path.join(rootDir, ".config");
  if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, "config.json");
  const backupPath = path.join(configDir, "config.backup.json");
  if (!fs.existsSync(backupPath) && fs.existsSync(configPath)) {
    try {
      fs.copyFileSync(configPath, backupPath);
    } catch (error) {
      console.error("Failed to create config backup:", error.message);
    }
  }
  fs.writeFileSync(
    configPath,
    JSON.stringify(
      {
        LISTEN_ADDR: `${cfg.listenHost || "127.0.0.1"}:${cfg.listenPort || 8080}`,
        UPSTREAM_BASE_URL: cfg.upstreamBaseURL,
        AUTH_TOKENS: cfg.authTokens,
        TOKEN_EMAILS: cfg.tokenEmails || {},
        TOKEN_ACCOUNTS: cfg.tokenAccounts || {},
        REQUEST_TIMEOUT: `${cfg.requestTimeout / (60 * 1000)}m`,
        API_KEYS: cfg.apiKeys,
        ENABLED_MODELS: cfg.enabledModels || [],
        LOG_LEVEL: cfg.logLevel || "info",
        TOKEN_REVALIDATE_INTERVAL: `${(cfg.tokenRevalidateInterval || 300000) / (60 * 1000)}m`,
      },
      null,
      2,
    ),
  );
}

module.exports = { loadConfig, saveConfig };
