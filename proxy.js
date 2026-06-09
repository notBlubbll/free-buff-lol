// v2026-05-28 - cache bust
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const url = require('url');
const crypto = require('crypto');
const { spawn } = require('child_process');
const nodeFetch = require('node-fetch');
const { SocksProxyAgent } = require('socks-proxy-agent');

const FREE_AGENTS_SOURCE_URL = 'https://raw.githubusercontent.com/CodebuffAI/codebuff/main/common/src/constants/free-agents.ts';
const FREEBUFF_MODELS_SOURCE_URL = 'https://raw.githubusercontent.com/CodebuffAI/codebuff/main/common/src/constants/freebuff-models.ts';
const MODEL_CONFIG_SOURCE_URL = 'https://raw.githubusercontent.com/CodebuffAI/codebuff/main/common/src/constants/model-config.ts';
const MODEL_REFRESH_INTERVAL = 6 * 60 * 60 * 1000;
const TOKEN_RELOAD_INTERVAL = 5 * 60 * 1000;
const CONTEXT_PRUNER_AGENT_ID = 'context-pruner';
const FREEBUFF2API_RS_SOURCE = 'https://raw.githubusercontent.com/XxxXTeam/freebuff2api_rs/main/src/codebuff.rs';

const PROXY_VERSION = '1.0.0';
const NPM_PACKAGE_NAME = 'freebuff-proxy';

const IS_BUN = typeof Bun !== 'undefined';
const RUNTIME_VERSION = IS_BUN ? Bun.version : process.version.replace('v', '');

let BUN_VERSION = '1.3.11';
let AI_SDK_PROVIDER_UTILS_VERSION = '3.0.20';
let FREEBUFF_CLI_VERSION = '0.0.96';
let AI_SDK_COMPAT_VERSION = FREEBUFF_CLI_VERSION;
let DETECTED_COUNTRY = null;

let LAST_REQUEST = 0;
async function debounceRequest() {
  const now = Date.now();
  const elapsed = now - LAST_REQUEST;
  if (elapsed < 1300) {
    await new Promise(r => setTimeout(r, 1300 - elapsed));
  }
  LAST_REQUEST = Date.now();
}

const CANONICAL_MODEL_ALIASES = {
  'deepseek-v4-pro': 'deepseek/deepseek-v4-pro',
  'deepseek-v4-flash': 'deepseek/deepseek-v4-flash',
  'deepseek-v3.1-terminus': 'deepseek/deepseek-v4-pro',
  'mimo-v2.5-pro': 'mimo/mimo-v2.5-pro',
  'mimo-v2.5': 'mimo/mimo-v2.5',
  'kimi-k2.6': 'moonshotai/kimi-k2.6',
  'minimax-m2.7': 'minimax/minimax-m2.7',
};

const FALLBACK_AGENT_IDS = {
  'minimax/minimax-m2.7': 'base2-free',
  'moonshotai/kimi-k2.6': 'base2-free-kimi',
  'deepseek/deepseek-v4-pro': 'base2-free-deepseek',
  'deepseek/deepseek-v4-flash': 'base2-free-deepseek-flash',
  'mimo/mimo-v2.5-pro': 'base2-free-mimo-pro',
  'mimo/mimo-v2.5': 'base2-free-mimo',
};

function canonicalModelName(model) {
  return CANONICAL_MODEL_ALIASES[model] || model;
}

function getApiUserAgent() { return `Bun/${BUN_VERSION}`; }
function getChatUserAgent() {
  return `ai-sdk/openai-compatible/0.0.0-test/codebuff ai-sdk/provider-utils/${AI_SDK_PROVIDER_UTILS_VERSION} runtime/browser`;
}
function getAdsUserAgent() { return `Freebuff-CLI/${FREEBUFF_CLI_VERSION}`; }

async function httpGet(url, options = {}) {
  return new Promise((resolve) => {
    const req = https.get(url, { headers: { 'Accept': 'application/json', ...options.headers }, timeout: 10000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    req.on('error', () => resolve({ status: 0, data: '' }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, data: '' }); });
  });
}

async function checkAndUpdateVersions() {
  const updates = [];

  try {
    const { status, data } = await httpGet(FREEBUFF2API_RS_SOURCE, { headers: { 'Accept': 'text/plain' } });
    if (status === 200) {
      const bunMatch = data.match(/"Bun\/(\d+\.\d+\.\d+)"/);
      if (bunMatch && bunMatch[1] !== BUN_VERSION) {
        updates.push(`Bun: ${BUN_VERSION} -> ${bunMatch[1]}`);
        BUN_VERSION = bunMatch[1];
      }
    }
  } catch (e) {
    console.error(`[Versions] Failed to fetch RS source: ${e.message}`);
  }

  try {
    const { status: npmStatus, data: npmData } = await httpGet('https://registry.npmjs.org/freebuff/latest');
    if (npmStatus === 200) {
      try {
        const pkg = JSON.parse(npmData);
        if (pkg.version && pkg.version !== FREEBUFF_CLI_VERSION) {
          updates.push(`Freebuff-CLI: ${FREEBUFF_CLI_VERSION} -> ${pkg.version}`);
          FREEBUFF_CLI_VERSION = pkg.version;
          AI_SDK_COMPAT_VERSION = pkg.version;
        }
      } catch (e) {}
    }
  } catch (e) {
    console.error(`[Versions] Failed to fetch npm registry: ${e.message}`);
  }

  if (updates.length > 0) {
    console.log(`[Versions] Updated: ${updates.join(', ')}`);
    return true;
  }
  return false;
}

function versionCompare(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

async function checkProxyVersion() {
  try {
    const { status, data } = await httpGet(`https://registry.npmjs.org/${NPM_PACKAGE_NAME}/latest`);
    if (status !== 200) return;
    const pkg = JSON.parse(data);
    const latest = pkg.version;
    if (!latest || versionCompare(latest, PROXY_VERSION) <= 0) return;

    const msg = `Freebuff Proxy is outdated!\n\nCurrent: v${PROXY_VERSION}\nLatest:  v${latest}\n\nUpdate with: npm install -g ${NPM_PACKAGE_NAME}\nor: cd ${__dirname} && npm install\n\nThe proxy will now close.`;
    console.log(`\n${'='.repeat(60)}`);
    console.log(`  OUTDATED: v${PROXY_VERSION} -> v${latest}`);
    console.log(`  Update: npm install -g ${NPM_PACKAGE_NAME}`);
    console.log(`${'='.repeat(60)}\n`);

    if (process.platform === 'win32') {
      const vbsPath = path.join(os.tmpdir(), 'freebuff_alert.vbs');
      fs.writeFileSync(vbsPath, `MsgBox "Freebuff Proxy is outdated!" & vbCrLf & vbCrLf & "Current: v${PROXY_VERSION}" & vbCrLf & "Latest:  v${latest}" & vbCrLf & vbCrLf & "Run: npm install -g ${NPM_PACKAGE_NAME}", vbExclamation, "Freebuff Proxy - Update Required"`);
      const { execSync } = require('child_process');
      try { execSync(`cscript //nologo "${vbsPath}"`, { timeout: 30000 }); } catch {}
      try { fs.unlinkSync(vbsPath); } catch {}
    }

    process.exit(1);
  } catch (e) {
    // silent fail
  }
}

let config = null;
let modelRegistry = null;
let tokenPool = null;
let startTime = new Date();

function parseDuration(str) {
  if (!str) return 0;
  const match = str.match(/^(\d+)(h|m|s)$/);
  if (!match) return 0;
  const value = parseInt(match[1]);
  const unit = match[2];
  if (unit === 'h') return value * 60 * 60 * 1000;
  if (unit === 'm') return value * 60 * 1000;
  if (unit === 's') return value * 1000;
  return 0;
}

function loadConfig() {
  const configPath = path.join(__dirname, '.config', 'config.json');
  let rawConfig = {
    LISTEN_ADDR: ':8080',
    UPSTREAM_BASE_URL: 'https://www.codebuff.com',
    REQUEST_TIMEOUT: '15m'
  };
  if (fs.existsSync(configPath)) {
    try { rawConfig = { ...rawConfig, ...JSON.parse(fs.readFileSync(configPath, 'utf8')) }; } catch (e) { console.error('Failed to parse config.json:', e.message); }
  }
  if (process.env.LISTEN_ADDR) rawConfig.LISTEN_ADDR = process.env.LISTEN_ADDR;
  if (process.env.UPSTREAM_BASE_URL) rawConfig.UPSTREAM_BASE_URL = process.env.UPSTREAM_BASE_URL;
  if (process.env.REQUEST_TIMEOUT) rawConfig.REQUEST_TIMEOUT = process.env.REQUEST_TIMEOUT;
  if (process.env.AUTH_TOKENS) rawConfig.AUTH_TOKENS = process.env.AUTH_TOKENS.split(',').map(t => t.trim()).filter(Boolean);
  if (process.env.API_KEYS) rawConfig.API_KEYS = process.env.API_KEYS.split(',').map(t => t.trim()).filter(Boolean);
  if (process.env.WARP_PLUS !== undefined) rawConfig.WARP_PLUS = process.env.WARP_PLUS === 'true';
  if (process.env.OUTBOUND_PROXY) rawConfig.OUTBOUND_PROXY = process.env.OUTBOUND_PROXY;
  if (!rawConfig.AUTH_TOKENS || rawConfig.AUTH_TOKENS.length === 0) {
    const cliTokens = loadFreebuffCLITokens();
    if (cliTokens.length > 0) { rawConfig.AUTH_TOKENS = cliTokens; console.log(`Loaded ${cliTokens.length} token(s) from Freebuff CLI`); }
  }
  const requestTimeout = parseDuration(rawConfig.REQUEST_TIMEOUT);
  if (!rawConfig.LISTEN_ADDR) throw new Error('LISTEN_ADDR cannot be empty');
  if (!rawConfig.UPSTREAM_BASE_URL) throw new Error('UPSTREAM_BASE_URL cannot be empty');
  if (requestTimeout <= 0) throw new Error('REQUEST_TIMEOUT must be greater than zero');
  let baseURL = rawConfig.UPSTREAM_BASE_URL.trim().replace(/\/+$/, '');
  try { const parsed = new URL(baseURL); if (parsed.host.toLowerCase() === 'codebuff.com') { parsed.host = 'www.codebuff.com'; baseURL = parsed.toString().replace(/\/+$/, ''); } } catch (e) {}
  return {
    listenAddr: rawConfig.LISTEN_ADDR,
    upstreamBaseURL: baseURL,
    authTokens: [...new Set(rawConfig.AUTH_TOKENS || [])],
    requestTimeout,
    apiKeys: [...new Set(rawConfig.API_KEYS || [])],
    warpPlus: rawConfig.WARP_PLUS !== false,
    outboundProxy: rawConfig.OUTBOUND_PROXY || null,
    disabledModels: Array.isArray(rawConfig.DISABLED_MODELS) ? rawConfig.DISABLED_MODELS : []
  };
}

function loadFreebuffCLITokens() {
  const tokens = [];
  const credFile = 'credentials.json';
  const subPath = path.join('.config', 'manicode', credFile);

  const searchPaths = [];
  const seen = new Set();
  const addPath = (p) => {
    const resolved = path.resolve(p);
    if (!seen.has(resolved)) { seen.add(resolved); searchPaths.push(resolved); }
  };

  const home = os.homedir();
  addPath(path.join(home, subPath));

  const envCandidates = [
    process.env.USERPROFILE, process.env.HOME,
    (process.env.HOMEDRIVE && process.env.HOMEPATH) ? path.join(process.env.HOMEDRIVE, process.env.HOMEPATH) : null,
    process.env.APPDATA, process.env.LOCALAPPDATA, process.env.XDG_CONFIG_HOME
  ].filter(Boolean);
  for (const envDir of envCandidates) {
    if (envDir) {
      addPath(path.join(envDir, subPath));
      if (path.basename(envDir) !== 'manicode') {
        addPath(path.join(envDir, credFile));
      }
    }
  }

  if (process.platform === 'win32') {
    try {
      const root = path.parse(home).root || 'C:\\';
      const usersDir = path.join(root, 'Users');
      if (fs.existsSync(usersDir)) {
        for (const entry of fs.readdirSync(usersDir)) {
          if (entry.startsWith('.')) continue;
          const userDir = path.join(usersDir, entry);
          try {
            if (!fs.statSync(userDir).isDirectory()) continue;
          } catch (e) { continue; }
          addPath(path.join(userDir, subPath));
          addPath(path.join(userDir, 'AppData', 'Roaming', 'manicode', credFile));
          addPath(path.join(userDir, 'AppData', 'Local', 'manicode', credFile));
        }
      }
    } catch (e) {}
  } else {
    const etcPasswd = '/etc/passwd';
    try {
      const passwd = fs.readFileSync(etcPasswd, 'utf8');
      for (const line of passwd.split('\n')) {
        const parts = line.split(':');
        if (parts.length >= 6 && parts[2] !== '0' && parts[5]) {
          addPath(path.join(parts[5], subPath));
          addPath(path.join(parts[5], '.local', 'share', 'manicode', credFile));
        }
      }
    } catch (e) {}
    addPath(path.join('/root', subPath));
  }

  for (const credPath of searchPaths) {
    if (fs.existsSync(credPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(credPath, 'utf8'));
        if (data.default && data.default.authToken) tokens.push(data.default.authToken);
        for (const [key, value] of Object.entries(data)) {
          if (key !== 'default' && value && value.authToken) tokens.push(value.authToken);
        }
        if (tokens.length > 0) break;
      } catch (e) { console.error('Failed to parse Freebuff CLI credentials:', e.message); }
    }
  }
  return tokens;
}

let configBackupDone = false;
function saveConfig(cfg) {
  const configPath = path.join(__dirname, '.config', 'config.json');
  const backupPath = path.join(__dirname, '.config', 'config.backup.json');
  if (!configBackupDone && !fs.existsSync(backupPath)) {
    try {
      fs.copyFileSync(configPath, backupPath);
      console.log('Initial config backup created:', backupPath);
    } catch (e) { console.error('Failed to create config backup:', e.message); }
    configBackupDone = true;
  }
  fs.writeFileSync(configPath, JSON.stringify({
    LISTEN_ADDR: cfg.listenAddr,
    UPSTREAM_BASE_URL: cfg.upstreamBaseURL,
    AUTH_TOKENS: cfg.authTokens,
    REQUEST_TIMEOUT: `${cfg.requestTimeout / (60 * 1000)}m`,
    API_KEYS: cfg.apiKeys,
    DISABLED_MODELS: cfg.disabledModels || []
  }, null, 2));
}

function setupOpencodeConfig() {
  const models = {};
  for (const m of modelRegistry.getModels()) {
    models[m] = { name: modelRegistry.getDisplayName(m) };
  }
  const providerEntry = {
    npm: '@ai-sdk/openai-compatible',
    name: 'Freebuff Proxy',
    options: { baseURL: `http://localhost:${parseInt(config.listenAddr.replace(':', '')) || 8080}/v1` },
    models
  };

  const configPaths = [
    path.join(os.homedir(), '.config', 'opencode', 'opencode.json')
  ];
  if (process.platform === 'win32') {
    configPaths.unshift(path.join(os.homedir(), '.opencode', 'opencode.json'));
    const systemProfile = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'config', 'systemprofile', '.opencode', 'opencode.json');
    try { if (fs.existsSync(path.dirname(systemProfile))) configPaths.push(systemProfile); } catch {}
  }

  for (const configFile of configPaths) {
    try {
      const dir = path.dirname(configFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      let existing = { $schema: 'https://opencode.ai/config.json' };
      if (fs.existsSync(configFile)) {
        existing = JSON.parse(fs.readFileSync(configFile, 'utf8'));
        const backupFile = path.join(dir, 'openconfig.b4freebuff.json');
        if (!fs.existsSync(backupFile)) {
          fs.copyFileSync(configFile, backupFile);
          console.log(`[Opencode] Backup created: ${backupFile}`);
        } else {
          console.log(`[Opencode] Backup already exists: ${backupFile}`);
        }
      } else {
        console.log(`[Opencode] No existing config found, will create: ${configFile}`);
      }
      if (!existing.provider || typeof existing.provider !== 'object') existing.provider = {};
      existing.provider['freebuff'] = providerEntry;
      fs.writeFileSync(configFile, JSON.stringify(existing, null, 2));
      console.log(`[Opencode] Config updated: ${configFile}`);
    } catch (e) {
      console.error(`[Opencode] Failed to update ${configFile}: ${e.message}`);
    }
  }
}

// --- Model Registry ---
class ModelRegistry {
  constructor() {
    this.agentModels = new Map();
    this.modelToAgent = new Map();
    this.modelToParentAgent = new Map();
    this.modelToSessionModel = new Map();
    this.modelDisplayNames = new Map();
    this.modelMetadata = new Map();
    this.allModels = [];
    this.lastOK = null;
    this.refreshTimer = null;
  }

  async start() {
    await this.refresh();
    this.refreshTimer = setInterval(() => this.refresh(), MODEL_REFRESH_INTERVAL);
  }

  stop() {
    if (this.refreshTimer) { clearInterval(this.refreshTimer); this.refreshTimer = null; }
  }

  async refresh() {
    const HARDCODED_MODELS = [
      { model: 'deepseek/deepseek-v4-pro', agent: 'base2-free-deepseek', displayName: 'DeepSeek V4 Pro', premium: true, multimodal: false },
      { model: 'mimo/mimo-v2.5-pro', agent: 'base2-free-mimo-pro', displayName: 'MiMo 2.5 Pro', premium: true, multimodal: true },
      { model: 'moonshotai/kimi-k2.6', agent: 'base2-free-kimi', displayName: 'Kimi K2.6', premium: true, multimodal: true },
      { model: 'minimax/minimax-m3', agent: 'base2-free-minimax-m3', displayName: 'MiniMax M3', premium: false, multimodal: true },
      { model: 'deepseek/deepseek-v4-flash', agent: 'base2-free-deepseek-flash', displayName: 'DeepSeek V4 Flash', premium: false, multimodal: false },
      { model: 'mimo/mimo-v2.5', agent: 'base2-free-mimo', displayName: 'MiMo 2.5', premium: false, multimodal: true },
      { model: 'minimax/minimax-m2.7', agent: 'base2-free', displayName: 'MiniMax M2.7', premium: false, multimodal: false },
    ];

    let loaded = false;
    try {
      const [modelsSource, agentsSource, configSource] = await Promise.all([
        this.fetchSource(FREEBUFF_MODELS_SOURCE_URL),
        this.fetchSource(FREE_AGENTS_SOURCE_URL),
        this.fetchSource(MODEL_CONFIG_SOURCE_URL)
      ]);

      const objectLiterals = this.parseObjectLiterals(configSource);
      const modelConstants = this.parseConstants(modelsSource, objectLiterals);
      const agentConstants = this.parseConstants(agentsSource);
      const variableMap = new Map([...modelConstants, ...agentConstants]);

      const rootAgentMapping = this.parseRootAgentModelMapping(agentsSource, variableMap);
      const parsedMetadata = this.parseModelMetadata(modelsSource, variableMap);

      if (rootAgentMapping.size > 0) {
        const modelToAgent = new Map();
        const allModels = [];
        const modelDisplayNames = new Map();
        const modelMetadata = new Map();
        const agentModels = new Map();

        for (const [model, agent] of rootAgentMapping) {
          modelToAgent.set(model, agent);
          allModels.push(model);
          const meta = parsedMetadata.get(model);
          const displayName = meta ? meta.displayName : model.split('/').pop();
          modelDisplayNames.set(model, displayName);
          modelMetadata.set(model, meta || { displayName, premium: false, multimodal: false });
          if (!agentModels.has(agent)) agentModels.set(agent, []);
          agentModels.get(agent).push(model);
        }

        allModels.sort();
        this.agentModels = agentModels;
        this.modelToAgent = modelToAgent;
        this.allModels = allModels;
        this.modelDisplayNames = modelDisplayNames;
        this.modelMetadata = modelMetadata;
        this.lastOK = new Date();
        loaded = true;
        console.log(`Model registry: fetched ${allModels.length} models from GitHub: ${allModels.join(', ')}`);
      }
    } catch (e) {
      console.error('Model registry: GitHub fetch failed:', e.message);
    }

    if (!loaded) {
      const modelToAgent = new Map();
      const allModels = [];
      const modelDisplayNames = new Map();
      const modelMetadata = new Map();
      const agentModels = new Map();

      for (const entry of HARDCODED_MODELS) {
        modelToAgent.set(entry.model, entry.agent);
        allModels.push(entry.model);
        modelDisplayNames.set(entry.model, entry.displayName);
        modelMetadata.set(entry.model, { displayName: entry.displayName, premium: entry.premium, multimodal: entry.multimodal });
        if (!agentModels.has(entry.agent)) agentModels.set(entry.agent, []);
        agentModels.get(entry.agent).push(entry.model);
      }

      allModels.sort();
      this.agentModels = agentModels;
      this.modelToAgent = modelToAgent;
      this.allModels = allModels;
      this.modelDisplayNames = modelDisplayNames;
      this.modelMetadata = modelMetadata;
      this.lastOK = new Date();
      console.log(`Model registry: hardcoded fallback ${allModels.length} models: ${allModels.join(', ')}`);
    }
  }

  fetchSource(urlStr) {
    return new Promise((resolve, reject) => {
      const req = https.get(urlStr, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(data));
      });
      req.on('error', reject);
      req.setTimeout(30000, () => { req.destroy(); reject(new Error('Request timeout')); });
    });
  }

  parseConstants(source, objectLiterals) {
    const constants = new Map();
    const pattern = /export const (\w+)\s*=\s*['"]([^'"]+)['"]/g;
    let match;
    while ((match = pattern.exec(source)) !== null) constants.set(match[1], match[2]);
    if (objectLiterals) {
      const refPattern = /export const (\w+)\s*=\s*(\w+)\.(\w+)/g;
      while ((match = refPattern.exec(source)) !== null) {
        const key = `${match[2]}.${match[3]}`;
        if (objectLiterals.has(key)) constants.set(match[1], objectLiterals.get(key));
      }
    }
    return constants;
  }

  parseObjectLiterals(source) {
    const result = new Map();
    const lines = source.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const objMatch = lines[i].match(/^(?:export\s+)?const\s+(\w+)\s*=\s*\{$/);
      if (!objMatch) continue;
      const objName = objMatch[1];
      for (let j = i + 1; j < Math.min(i + 20, lines.length); j++) {
        const line = lines[j].trim();
        if (line.startsWith('}')) break;
        const propMatch = line.match(/^(\w+):\s*['"]([^'"]+)['"]/);
        if (propMatch) result.set(`${objName}.${propMatch[1]}`, propMatch[2]);
      }
    }
    return result;
  }

  parseAllFreeModels(source, variableMap) {
    const blockPattern = /'([^']+)':\s*new\s+Set\(\[([^\]]*)\]\)/g;
    const result = new Map();
    let match;
    while ((match = blockPattern.exec(source)) !== null) {
      const agentID = match[1];
      const modelsStr = match[2];
      const models = [];
      const tokenPattern = /(?:'([^']+)')|(\w+)/g;
      let tokenMatch;
      while ((tokenMatch = tokenPattern.exec(modelsStr)) !== null) {
        if (tokenMatch[1]) models.push(tokenMatch[1].trim());
        else if (tokenMatch[2] && variableMap.has(tokenMatch[2])) models.push(variableMap.get(tokenMatch[2]));
      }
      if (models.length > 0) result.set(agentID, models);
    }
    return result;
  }

  parseRootAgentModelMapping(source, variableMap) {
    const result = new Map();
    const blockPattern = /FREEBUFF_ROOT_AGENT_ID_BY_MODEL[^{]*\{([^}]+)\}/gs;
    const blockMatch = blockPattern.exec(source);
    if (!blockMatch) return result;
    const body = blockMatch[1];
    const entryPattern = /\[(\w+)\]\s*:\s*'([^']+)'/g;
    let m;
    while ((m = entryPattern.exec(body)) !== null) {
      const varName = m[1];
      const agentId = m[2];
      const modelId = variableMap.get(varName);
      if (modelId) result.set(modelId, agentId);
    }
    return result;
  }

  buildModelMapping(agentModels, rootAgentMapping) {
    const modelToAgent = new Map();
    const allModels = [];
    for (const [model, rootAgent] of rootAgentMapping) {
      modelToAgent.set(model, rootAgent);
      allModels.push(model);
    }
    allModels.sort();
    return { modelToAgent, allModels };
  }

  parseDisplayNames(source) {
    const map = new Map();
    const lines = source.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const idMatch = lines[i].match(/id:\s*(\w+|'[^']*')/);
      if (!idMatch) continue;
      let idRef = idMatch[1];
      for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
        const dnMatch = lines[j].match(/displayName:\s*'([^']+)'/);
        if (dnMatch) {
          const id = idRef.startsWith("'") ? idRef.slice(1, -1) : idRef;
          map.set(id, dnMatch[1]);
          break;
        }
      }
    }
    const resolved = new Map();
    const constPattern = /export const (\w+)\s*=\s*['"]([^'"]+)['"]/g;
    let cm;
    while ((cm = constPattern.exec(source)) !== null) {
      if (map.has(cm[1])) resolved.set(cm[2], map.get(cm[1]));
    }
    return resolved;
  }

  parseModelMetadata(source, variableMap) {
    const result = new Map();
    const lines = source.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const blockMatch = lines[i].match(/^const\s+(\w+)\s*=\s*\{$/);
      if (!blockMatch) continue;
      const varName = blockMatch[1];
      let id = null, displayName = null, premium = false, multimodal = false;
      for (let j = i + 1; j < Math.min(i + 20, lines.length); j++) {
        const line = lines[j];
        if (line.trim().startsWith('}')) break;
        const idMatch = line.match(/id:\s*(\w+|'[^']*')/);
        if (idMatch) {
          const ref = idMatch[1];
          id = ref.startsWith("'") ? ref.slice(1, -1) : (variableMap.get(ref) || ref);
        }
        const dnMatch = line.match(/displayName:\s*'([^']+)'/);
        if (dnMatch) displayName = dnMatch[1];
        const premMatch = line.match(/premium:\s*(true|false)/);
        if (premMatch) premium = premMatch[1] === 'true';
        const mmMatch = line.match(/multimodal:\s*(true|false)/);
        if (mmMatch) multimodal = mmMatch[1] === 'true';
      }
      if (id && displayName) result.set(id, { displayName, premium, multimodal });
    }
    return result;
  }

  getDisplayName(model) {
    return this.modelDisplayNames.get(model) || model.split('/').pop();
  }

  getModels() { return [...this.allModels]; }
  hasModel(model) { return this.modelToAgent.has(model); }
  getAgentForModel(model) { return this.modelToAgent.get(model); }
  getAgentIDs() { return Array.from(new Set(this.modelToAgent.values())); }
  getModelMetadata(model) { return this.modelMetadata.get(model) || null; }
  getAllModelMetadata() {
    const obj = {};
    for (const [k, v] of this.modelMetadata) obj[k] = v;
    return obj;
  }
}

// --- Warp Plus Manager ---
const WARP_PLUS_RELEASE_URL = 'https://github.com/bepass-org/warp-plus/releases/download/v1.2.6/warp-plus_windows-amd64.zip';
const WARP_PLUS_BIN_LOCAL = path.join(__dirname, 'bin', 'warp-plus.exe');
const WARP_PLUS_PORT = 8086;
const WARP_PLUS_ADDR = `socks5://127.0.0.1:${WARP_PLUS_PORT}`;

function findWarpPlusBin() {
  const names = process.platform === 'win32' ? ['warp-plus.exe', 'warp-plus'] : ['warp-plus'];
  const pathDirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    for (const name of names) {
      try {
        const full = path.join(dir, name);
        if (fs.existsSync(full) && fs.statSync(full).isFile()) return full;
      } catch (e) {}
    }
  }
  return null;
}

function getWarpPlusBin() {
  return findWarpPlusBin() || WARP_PLUS_BIN_LOCAL;
}

class WarpPlusManager {
  constructor() {
    this.process = null;
    this.ready = false;
    this.starting = false;
    this.proxyAgent = null;
    this.lastEndpoint = null;
  }

  async ensureBinary() {
    const binPath = getWarpPlusBin();
    if (fs.existsSync(binPath)) {
      this._binPath = binPath;
      const inPath = binPath !== WARP_PLUS_BIN_LOCAL;
      console.log(`[WarpPlus] Binary found at: ${binPath}${inPath ? ' (from PATH)' : ' (local)'}`);
      return true;
    }
    console.log('[WarpPlus] Binary not found in PATH or local, downloading...');
    const binDir = path.dirname(WARP_PLUS_BIN_LOCAL);
    if (!fs.existsSync(binDir)) fs.mkdirSync(binDir, { recursive: true });
    const tmpPath = WARP_PLUS_BIN_LOCAL + '.tmp';
    const zipPath = path.join(binDir, 'warp-plus.zip');
    try {
      const resp = await fetch(WARP_PLUS_RELEASE_URL, { redirect: 'follow' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const buffer = Buffer.from(await resp.arrayBuffer());
      fs.writeFileSync(zipPath, buffer);
      const { execSync } = require('child_process');
      execSync(`powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${binDir}' -Force"`);
      fs.unlinkSync(zipPath);
      if (!fs.existsSync(WARP_PLUS_BIN_LOCAL)) throw new Error('warp-plus.exe not found after extraction');
      this._binPath = WARP_PLUS_BIN_LOCAL;
      console.log('[WarpPlus] Binary downloaded successfully');
      return true;
    } catch (e) {
      console.error('[WarpPlus] Failed to download binary:', e.message);
      try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {}
      try { if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath); } catch {}
      return false;
    }
  }

  async start() {
    if (this.process || this.starting) return true;
    this.starting = true;
    const hasBin = await this.ensureBinary();
    if (!hasBin) { this.starting = false; return false; }
    const binPath = this._binPath || getWarpPlusBin();
    console.log(`[WarpPlus] Starting SOCKS5 proxy on port ${WARP_PLUS_PORT}...`);
    try {
      const args = ['-b', `127.0.0.1:${WARP_PLUS_PORT}`, '-4'];
      if (this.lastEndpoint) {
        args.push('-e', this.lastEndpoint);
        console.log(`[WarpPlus] Reusing cached endpoint: ${this.lastEndpoint}`);
      }
      this.process = spawn(binPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        cwd: path.dirname(binPath)
      });
      this.process.stdout.on('data', (d) => {
        const msg = d.toString().trim();
        if (msg && !msg.includes('connection test failed')) {
          console.log(`[WarpPlus] ${msg}`);
          const epMatch = msg.match(/using warp endpoints.*?"\[(.+?)\]"/);
          if (epMatch) this.lastEndpoint = epMatch[1].split(' ')[0].trim();
        }
      });
      this.process.stderr.on('data', (d) => {
        const msg = d.toString().trim();
        if (msg && !msg.includes('connection test failed')) console.log(`[WarpPlus] ${msg}`);
      });
      this.process.on('exit', (code) => {
        console.log(`[WarpPlus] Process exited with code ${code}`);
        this.process = null;
        this.ready = false;
        this.proxyAgent = null;
      });
      this.process.on('error', (e) => {
        console.error(`[WarpPlus] Process error: ${e.message}`);
        this.process = null;
        this.ready = false;
        this.proxyAgent = null;
      });
      await this._waitForReady(20000);
      this.proxyAgent = new SocksProxyAgent(WARP_PLUS_ADDR);
      this.ready = true;
      this.starting = false;
      console.log(`[WarpPlus] Ready${this.lastEndpoint ? ' (endpoint: ' + this.lastEndpoint + ')' : ''}`);
      return true;
    } catch (e) {
      console.error('[WarpPlus] Failed to start:', e.message);
      this.stop();
      this.starting = false;
      return false;
    }
  }

  async _waitForReady(timeout) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (!this.process || !this.process.pid) throw new Error('process died');
      try {
        const agent = new SocksProxyAgent(WARP_PLUS_ADDR);
        await nodeFetch('https://api.ipify.org?format=json', { agent, signal: AbortSignal.timeout(3000) });
        return;
      } catch {
        await new Promise(r => setTimeout(r, 1000));
      }
    }
    throw new Error('readiness timeout');
  }

  stop() {
    if (this.process) {
      try { this.process.kill(); } catch {}
      this.process = null;
    }
    this.ready = false;
    this.proxyAgent = null;
    this.starting = false;
  }

  isReady() { return this.ready && this.proxyAgent !== null; }
  getAgent() { return this.proxyAgent; }
}

const warpPlus = new WarpPlusManager();

let outboundProxyAgent = null;
function getOutboundProxyAgent() {
  if (outboundProxyAgent) return outboundProxyAgent;
  const proxyUrl = config && config.outboundProxy;
  if (!proxyUrl) return null;
  try {
    if (proxyUrl.startsWith('socks5://') || proxyUrl.startsWith('socks5h://')) {
      outboundProxyAgent = new SocksProxyAgent(proxyUrl);
    } else if (proxyUrl.startsWith('http://') || proxyUrl.startsWith('https://')) {
      const { HttpsProxyAgent } = require('https-proxy-agent');
      outboundProxyAgent = new HttpsProxyAgent(proxyUrl);
    } else {
      outboundProxyAgent = new SocksProxyAgent('socks5://' + proxyUrl);
    }
    console.log(`[Proxy] Outbound proxy configured: ${proxyUrl.replace(/\/\/[^@]*@/, '//***@')}`);
    return outboundProxyAgent;
  } catch (e) {
    console.error(`[Proxy] Failed to create outbound proxy agent: ${e.message}`);
    return null;
  }
}

// --- Upstream Client ---
class UpstreamClient {
  constructor(cfg) {
    this.baseURL = cfg.upstreamBaseURL;
    this.timeout = cfg.requestTimeout;
  }

  apiHeaders(authToken, extra = {}) {
    return {
      'Authorization': `Bearer ${authToken}`,
      'Accept': 'application/json',
      ...extra
    };
  }

  chatHeaders(authToken, stream = false) {
    return {
      'Authorization': `Bearer ${authToken}`,
      'Content-Type': 'application/json',
      'Accept': '*/*',
      'User-Agent': getChatUserAgent(),
    };
  }

  async doJSON(authToken, pth, body, method = 'POST', extraHeaders = {}) {
    const requestURL = this.baseURL + pth;
    const headers = this.apiHeaders(authToken, {
      'Content-Type': 'application/json',
      ...extraHeaders
    });
    console.log(`[API] ${method} ${pth}`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      const resp = await fetch(requestURL, {
        method,
        headers,
        body: body && method !== 'GET' && method !== 'DELETE' ? JSON.stringify(body) : undefined,
        signal: controller.signal
      });
      clearTimeout(timer);
      const data = await resp.text();
      const responseHeaders = {};
      resp.headers.forEach((v, k) => responseHeaders[k] = v);
      return { status: resp.status, headers: responseHeaders, body: data };
    } catch (e) {
      clearTimeout(timer);
      throw e;
    }
  }

  async startRun(authToken, agentID, ancestorRunIds = []) {
    const resp = await this.doJSON(authToken, '/api/v1/agent-runs', { action: 'START', agentId: agentID, ancestorRunIds });
    if (resp.status < 200 || resp.status >= 300) throw new Error(`start run failed ${resp.status}: ${resp.body}`);
    const parsed = JSON.parse(resp.body);
    if (!parsed.runId) throw new Error(`start run response missing runId: ${resp.body}`);
    return parsed.runId;
  }

  async finishRun(authToken, runID, totalSteps) {
    const resp = await this.doJSON(authToken, '/api/v1/agent-runs', { action: 'FINISH', runId: runID, status: 'completed', totalSteps, directCredits: 0, totalCredits: 0 });
    if (resp.status < 200 || resp.status >= 300) throw new Error(`finish run failed ${resp.status}: ${resp.body}`);
  }

  async recordRunStep(authToken, runID, stepNumber, childRunIds, messageId, startTime) {
    const resp = await this.doJSON(authToken, `/api/v1/agent-runs/${runID}/steps`, {
      stepNumber, credits: 0, childRunIds: childRunIds || [], messageId: messageId || null, status: 'completed', startTime: startTime || new Date().toISOString()
    });
    if (resp.status < 200 || resp.status >= 300) throw new Error(`record run step failed ${resp.status}: ${resp.body}`);
  }

  chatCompletions(authToken, body, proxyAgent) {
    const requestURL = this.baseURL + '/api/v1/chat/completions';
    const isStream = body && body.stream === true;
    const headers = this.chatHeaders(authToken, isStream);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    const fetchOpts = {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
      compress: false,
    };
    if (proxyAgent) fetchOpts.agent = proxyAgent;
    return nodeFetch(requestURL, fetchOpts).then(resp => {
      clearTimeout(timer);
      const responseHeaders = {};
      resp.headers.forEach((v, k) => responseHeaders[k] = v);
      return { status: resp.status, headers: responseHeaders, body: resp.body };
    }).catch(e => {
      clearTimeout(timer);
      throw e;
    });
  }

  createSession(authToken, model = '', proxyAgent, countryCode) {
    const extraHeaders = {};
    if (model) extraHeaders['x-freebuff-model'] = model;
    return this.doSessionRequest('POST', authToken, '', extraHeaders, proxyAgent, countryCode);
  }

  getSession(authToken, instanceID, proxyAgent) {
    return this.doSessionRequest('GET', authToken, instanceID, {}, proxyAgent);
  }

  endSession(authToken, instanceID = '') {
    return this.doSessionRequest('DELETE', authToken, instanceID);
  }

  async doSessionRequest(method, authToken, instanceID, extraHeaders = {}, proxyAgent, countryCode) {
    const headers = { 'Authorization': `Bearer ${authToken}`, 'Accept': 'application/json', 'User-Agent': getApiUserAgent(), ...extraHeaders };
    if (instanceID && (method === 'GET' || method === 'DELETE')) headers['x-freebuff-instance-id'] = instanceID;
    if (method === 'POST') headers['Content-Type'] = 'application/json';
    const body = method === 'POST' ? (countryCode ? JSON.stringify({ countryCode }) : '{}') : null;
    const requestURL = this.baseURL + '/api/v1/freebuff/session';
    console.log(`[DEBUG] Session ${method} sending to ${requestURL}`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      const fetchOpts = { method, headers, body: body || undefined, signal: controller.signal };
      if (proxyAgent) fetchOpts.dispatcher = proxyAgent;
      const resp = await (proxyAgent ? undiciFetch : fetch)(requestURL, fetchOpts);
      clearTimeout(timer);
      const data = await resp.text();
      console.log(`[DEBUG] Session ${method} response (${resp.status}): ${data.substring(0, 300)}`);
      if (resp.status === 404) return { status: 'disabled' };
      if (resp.status < 200 || resp.status >= 300) {
        if (resp.status === 426 || data.includes('freebuff_update_required')) throw new Error('freebuff_update_required');
        if (data.includes('model_locked')) throw new Error(JSON.stringify({ type: 'model_locked', body: JSON.parse(data) }));
        throw new Error(`free session request failed ${resp.status}: ${data}`);
      }
      try { return JSON.parse(data); } catch (e) { throw new Error('decode session: ' + e.message); }
    } catch (e) { clearTimeout(timer); throw e; }
  }
}

// --- Token Pool (sessions keyed by token:sessionModel) ---
class TokenPool {
  constructor(tokens, cfg, client) {
    this.tokens = tokens;
    this.cfg = cfg;
    this.client = client;
    this.currentIndex = 0;
    this.sessions = new Map();
    this.lockedModels = new Map();
    this.mutex = Promise.resolve();
  }

  async withLock(fn) {
    let release;
    const p = new Promise(r => release = r);
    const old = this.mutex;
    this.mutex = p;
    await old;
    try { return await fn(); } finally { release(); }
  }

  getToken() {
    if (this.tokens.length === 0) return null;
    const token = this.tokens[this.currentIndex % this.tokens.length];
    this.currentIndex++;
    return token;
  }

  sessionKey(token, model) { return `${token}:${model}`; }

  async ensureSession(token, model) {
    const locked = await this.withLock(async () => this.lockedModels.get(token));
    if (locked && locked !== model) {
      console.log(`${token.substring(0, 8)}...: token locked to ${locked}, redirecting from ${model}`);
      model = locked;
    }
    let key = this.sessionKey(token, model);
    for (let i = 0; i < 3; i++) {
      const ready = await this.withLock(async () => {
        const session = this.sessions.get(key);
        if (!session) return { ready: false };
        if (session.status === 'active' && session.instanceID) {
          if (!session.expiresAt || Date.now() < session.expiresAt.getTime() - 5000) {
            return { ready: true, instanceID: session.instanceID };
          }
        }
        return { ready: false };
      });
      if (ready.ready) return { instanceID: ready.instanceID, model };

      try {
        let state;
        const current = await this.withLock(async () => this.sessions.get(key));
        if (current && current.status === 'active' && current.instanceID) {
          try { state = await this.client.getSession(token, current.instanceID); } catch (e) { 
            if (e.message === 'freebuff_update_required') throw e;
            state = await this.client.createSession(token, model); 
          }
        } else {
          state = await this.client.createSession(token, model);
        }
        state = await this.pollUntilReady(token, model, state);
        console.log(`[DEBUG] ensureSession: pollUntilReady result: status=${state.status}, instanceId=${state.instanceId}`);
        const instanceID = (state.instanceId || '').trim();
        if (!instanceID) throw new Error('free session active response missing instanceId');
        const expiresAt = state.expiresAt ? new Date(state.expiresAt) : null;
        const countryCode = state.countryCode || null;
        const remainingMs = state.remainingMs || null;
        const accessTier = state.accessTier || null;
        await this.withLock(async () => {
          this.sessions.set(key, { status: 'active', instanceID, expiresAt, countryCode, remainingMs, accessTier });
        });
        console.log(`[DEBUG] ensureSession: returning instanceID=${instanceID} model=${model} accessTier=${accessTier}`);
        return { instanceID, model, accessTier };
      } catch (e) {
        const errorMsg = e.message || '';
        if (errorMsg.includes('model_locked')) {
          let lockedModel = null;
          try { const parsed = JSON.parse(errorMsg); if (parsed.type === 'model_locked' && parsed.body && parsed.body.currentModel) lockedModel = parsed.body.currentModel; } catch (_) {}
          if (lockedModel) {
            console.log(`${key.substring(0, 20)}...: server locked to ${lockedModel}, switching model`);
            const newKey = this.sessionKey(token, lockedModel);
            await this.withLock(async () => { this.sessions.delete(key); this.lockedModels.set(token, lockedModel); });
            model = lockedModel;
            key = newKey;
            continue;
          }
          console.log(`${key.substring(0, 20)}...: session locked to different model, ending all upstream sessions`);
          await this.endAllSessionsForToken(token);
          try { await this.client.endSession(token); } catch (e2) { console.error(`endSession(no-id) failed: ${e2.message}`); }
          await new Promise(r => setTimeout(r, 500));
          continue;
        }
        if (errorMsg === 'freebuff_update_required') {
          console.log(`${key.substring(0, 20)}...: freebuff_update_required, clearing session and retrying`);
          await this.endAllSessionsForToken(token);
          try { await this.client.endSession(token); } catch (e2) { console.error(`endSession(no-id) failed: ${e2.message}`); }
          continue;
        }
        await this.withLock(async () => { this.sessions.delete(key); });
        console.error(`${key.substring(0, 20)}...: session error: ${e.message}`);
        if (i === 2) throw e;
      }
    }
  }

  async getLockedModel(token) {
    return await this.withLock(async () => this.lockedModels.get(token) || null);
  }

  async setLockedModel(token, model) {
    await this.withLock(async () => { this.lockedModels.set(token, model); });
  }

  async endAllSessionsForToken(token) {
    const keysToDelete = [];
    await this.withLock(async () => {
      for (const key of this.sessions.keys()) {
        if (key.startsWith(token + ':')) {
          keysToDelete.push(key);
        }
      }
    });
    for (const key of keysToDelete) {
      const session = await this.withLock(async () => this.sessions.get(key));
      if (session && session.instanceID) {
        try {
          await this.client.endSession(token, session.instanceID);
        } catch (e) {
          console.error(`Failed to end session ${session.instanceID}: ${e.message}`);
        }
      }
      await this.withLock(async () => { this.sessions.delete(key); });
    }
  }

  async pollUntilReady(token, model, state) {
    for (let i = 0; i < 60; i++) {
      const status = (state.status || '').trim();
      if (status === 'active') return state;
      if (status === 'queued') {
        const instanceID = (state.instanceId || '').trim();
        if (!instanceID) throw new Error('free session queued response missing instanceId');
        const estimatedWaitMs = state.estimatedWaitMs || 0;
        const delay = estimatedWaitMs > 0 ? Math.min(Math.max(estimatedWaitMs, 250), 2000) : 250;
        console.log(`Waiting room: position ${state.position || '?'}/${state.queueDepth || '?'}${estimatedWaitMs > 0 ? `, ~${Math.ceil(estimatedWaitMs / 1000)}s` : ''}`);
        await new Promise(r => setTimeout(r, delay));
        state = await this.client.getSession(token, instanceID);
      } else if (status === 'ended' || status === 'superseded' || status === 'none') {
        state = await this.client.createSession(token, model);
      } else if (status === 'disabled') {
        return state;
      } else {
        throw new Error(`unexpected free session status: ${status}`);
      }
    }
    throw new Error('free session poll timeout');
  }

  invalidateSession(token, model) {
    const key = this.sessionKey(token, model);
    this.withLock(async () => { this.sessions.delete(key); });
  }
}

// --- Run Chain Helpers ---
async function startRunChainNormal(client, token, agentID) {
  const startedAt = new Date().toISOString();
  const runId = await client.startRun(token, agentID, []);
  const childStartedAt = new Date().toISOString();
  const childRunId = await client.startRun(token, CONTEXT_PRUNER_AGENT_ID, [runId]);
  await client.recordRunStep(token, childRunId, 1, [], null, childStartedAt);
  await client.finishRun(token, childRunId, 2);
  await client.recordRunStep(token, runId, 1, [childRunId], null, startedAt);
  return { runId, agentId: agentID, startedAt, childRunId, chatRunId: null, chatStartedAt: null };
}

async function startRunChainGemini(client, token, parentAgentID, chatAgentID) {
  const startedAt = new Date().toISOString();
  const parentRunId = await client.startRun(token, parentAgentID, []);
  const chatStartedAt = new Date().toISOString();
  const chatRunId = await client.startRun(token, chatAgentID, [parentRunId]);
  return { runId: parentRunId, agentId: parentAgentID, startedAt, childRunId: null, chatRunId, chatStartedAt };
}

async function finalizeRunChainNormal(client, token, run, messageId) {
  try {
    await client.recordRunStep(token, run.runId, 2, [], messageId, run.startedAt);
    await client.finishRun(token, run.runId, 3);
  } catch (e) { console.error(`finalize run failed: ${e.message}`); }
}

async function finalizeRunChainGemini(client, token, run, messageId) {
  try {
    await client.recordRunStep(token, run.chatRunId, 1, [], messageId, run.chatStartedAt);
    await client.finishRun(token, run.chatRunId, 2);
    await client.recordRunStep(token, run.runId, 1, [run.chatRunId], null, run.startedAt);
    await client.finishRun(token, run.runId, 2);
  } catch (e) { console.error(`finalize gemini run failed: ${e.message}`); }
}

// --- Utility ---
function generateClientSessionId() {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';
  const buf = crypto.randomBytes(10);
  let out = '';
  for (let i = 0; i < 13; i++) out += alphabet[buf[i % buf.length] % 36];
  return out;
}

function cloneMap(input) {
  const output = {};
  for (const [key, value] of Object.entries(input)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) output[key] = cloneMap(value);
    else if (Array.isArray(value)) output[key] = cloneSlice(value);
    else output[key] = value;
  }
  return output;
}

function cloneSlice(input) {
  return input.map(v => {
    if (v && typeof v === 'object' && !Array.isArray(v)) return cloneMap(v);
    if (Array.isArray(v)) return cloneSlice(v);
    return v;
  });
}

function normalizeToolSchemas(tools) {
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') continue;
    const fn = tool.function;
    if (!fn || typeof fn !== 'object') continue;
    const params = fn.parameters;
    if (!params || typeof params !== 'object') continue;
    fn.parameters = normalizeSchemaMap(params, extractDefinitions(params), 12);
  }
}

function extractDefinitions(schema) {
  const merged = {};
  if (schema.definitions && typeof schema.definitions === 'object') Object.assign(merged, schema.definitions);
  if (schema['$defs'] && typeof schema['$defs'] === 'object') Object.assign(merged, schema['$defs']);
  return Object.keys(merged).length > 0 ? merged : null;
}

function normalizeSchemaMap(node, defs, maxDepth) {
  if (maxDepth <= 0) return cloneMap(node);
  defs = mergeDefinitions(defs, extractDefinitions(node));
  const replaced = tryResolveRef(node, defs);
  if (replaced && typeof replaced === 'object' && !Array.isArray(replaced)) {
    return normalizeSchemaMap(replaced, defs, maxDepth - 1);
  }
  const normalized = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'definitions' || key === '$defs' || key === 'nullable') continue;
    normalized[key] = normalizeSchemaValue(value, defs, maxDepth - 1);
  }
  simplifyNullableCombinator(normalized, 'anyOf');
  simplifyNullableCombinator(normalized, 'oneOf');
  normalizeTypeField(normalized);
  normalizeEnumField(normalized);
  if (normalized.const === null) delete normalized.const;
  return normalized;
}

function normalizeSchemaValue(value, defs, maxDepth) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return normalizeSchemaMap(value, defs, maxDepth);
  if (Array.isArray(value)) return value.map(v => normalizeSchemaValue(v, defs, maxDepth));
  return value;
}

function mergeDefinitions(parent, local) {
  if (!parent) return local;
  if (!local) return parent;
  return { ...parent, ...local };
}

function tryResolveRef(node, defs) {
  if (!defs || typeof node.$ref !== 'string' || Object.keys(node).length !== 1) return null;
  const ref = node.$ref;
  let name = '';
  if (ref.startsWith('#/definitions/')) name = ref.slice('#/definitions/'.length);
  else if (ref.startsWith('#/$defs/')) name = ref.slice('#/$defs/'.length);
  if (!name || !defs[name]) return null;
  const def = defs[name];
  return typeof def === 'object' && !Array.isArray(def) ? cloneMap(def) : def;
}

function simplifyNullableCombinator(schema, key) {
  const rawOptions = schema[key];
  if (!Array.isArray(rawOptions)) return;
  const filtered = rawOptions.filter(opt => !isNullSchema(opt));
  if (filtered.length === 0) { delete schema[key]; return; }
  if (filtered.length === 1 && filtered[0] && typeof filtered[0] === 'object' && !Array.isArray(filtered[0])) {
    delete schema[key];
    Object.assign(schema, filtered[0]);
    return;
  }
  schema[key] = filtered;
}

function isNullSchema(schema) {
  if (!schema || typeof schema !== 'object') return false;
  if (schema.type === 'null') return true;
  if (schema.const === null) return true;
  if (Array.isArray(schema.enum) && schema.enum.length === 1 && schema.enum[0] === null) return true;
  return false;
}

function normalizeTypeField(schema) {
  const rawType = schema.type;
  if (typeof rawType === 'string') return;
  if (!Array.isArray(rawType)) return;
  const nonNull = rawType.filter(t => typeof t === 'string' && t !== 'null' && t.trim());
  if (nonNull.length === 0) delete schema.type;
  else schema.type = nonNull[0];
}

function normalizeEnumField(schema) {
  const enumValues = schema.enum;
  if (!Array.isArray(enumValues)) return;
  const seen = new Set();
  const filtered = [];
  for (const entry of enumValues) {
    if (entry === null) continue;
    const key = `${typeof entry}:${JSON.stringify(entry)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    filtered.push(entry);
  }
  if (filtered.length === 0) { delete schema.enum; return; }
  schema.enum = filtered;
}

function isSessionInvalid(statusCode, errorBody) {
  if (statusCode === 426) return true; // freebuff_update_required
  if (statusCode < 400) return false;
  try {
    const payload = JSON.parse(errorBody);
    const error = payload.error || payload.code || '';
    const retryableErrors = ['freebuff_update_required', 'waiting_room_required', 'waiting_room_queued', 'session_superseded', 'session_expired', 'session_model_mismatch', 'free_mode_invalid_agent_hierarchy'];
    return retryableErrors.includes(error);
  } catch (e) { return false; }
}

function isRunInvalid(statusCode, body) {
  if (statusCode !== 400) return false;
  const msg = body.toLowerCase();
  return msg.includes('runid not found') || msg.includes('runid not running');
}

// --- HTTP Handlers ---
function authorized(req) {
  if (!config.apiKeys || config.apiKeys.length === 0) return true;
  const xApiKey = (req.headers['x-api-key'] || '').trim();
  if (xApiKey && config.apiKeys.includes(xApiKey)) return true;
  const authorization = (req.headers['authorization'] || '').trim();
  if (!authorization.startsWith('Bearer ')) return false;
  return config.apiKeys.includes(authorization.substring(7).trim());
}

function isClaudeRequestPath(pathname) { return pathname.startsWith('/v1/messages'); }

function writeJSON(res, statusCode, payload) {
  try { res.writeHead(statusCode, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)); }
  catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('{"error":{"message":"encode failed","type":"server_error"}}'); }
}

function writeOpenAIError(res, statusCode, message, errorType, code) {
  if (!message) message = http.STATUS_CODES[statusCode] || 'Unknown error';
  const payload = { error: { message, type: errorType } };
  if (code) payload.error.code = code;
  writeJSON(res, statusCode, payload);
}

function writeClaudeError(res, statusCode, message, errorType) {
  if (!message) message = http.STATUS_CODES[statusCode] || 'Unknown error';
  if (!errorType) errorType = 'api_error';
  writeJSON(res, statusCode, { type: 'error', error: { type: errorType, message } });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handleHealthz(req, res) {
  if (req.method !== 'GET') { writeOpenAIError(res, 405, 'method not allowed', 'invalid_request_error', ''); return; }
  const tokenState = tokenPool.tokens.map((token, idx) => {
    const maskedToken = token.substring(0, 8) + '...' + token.substring(token.length - 4);
    const allSessions = [];
    for (const [key, session] of tokenPool.sessions.entries()) {
      if (key.startsWith(token + ':')) allSessions.push(session);
    }
    const bestSession = allSessions.find(s => s.status === 'active') || allSessions[0] || null;
    return {
      name: `token-${idx + 1}`,
      token: maskedToken,
      session_status: bestSession?.status || 'none',
      session_instance_id: bestSession?.instanceID || null,
      session_expires_at: bestSession?.expiresAt || null,
      country_code: bestSession?.countryCode || DETECTED_COUNTRY || null,
      access_tier: bestSession?.accessTier || null,
      remaining_ms: bestSession?.remainingMs || null,
      runs: []
    };
  });
  writeJSON(res, 200, {
    ok: true, started_at: startTime.toISOString(),
    uptime_sec: Math.floor((Date.now() - startTime.getTime()) / 1000),
    token_state: tokenState,
    models_count: modelRegistry.getModels().length,
    valid_tokens: tokenPool.tokens.length,
    runtime: IS_BUN ? 'bun' : 'node',
    runtime_version: RUNTIME_VERSION,
    opera_proxy: {
      enabled: config.warpPlus,
      running: warpPlus.isReady(),
      port: WARP_PLUS_PORT,
      exit_country: (warpPlus.isReady() || warpPlus.lastEndpoint) ? 'US' : null
    },
    outbound_proxy: config.outboundProxy ? config.outboundProxy.replace(/\/\/[^@]*@/, '//***@') : null
  });
}

async function handleModels(req, res) {
  if (req.method !== 'GET') { writeOpenAIError(res, 405, 'method not allowed', 'invalid_request_error', ''); return; }
  const created = Math.floor(startTime.getTime() / 1000);
  writeJSON(res, 200, { object: 'list', data: modelRegistry.getModels().map(m => ({ id: m, object: 'model', created, owned_by: 'Freebuff2Opencode', root: m, permission: [] })) });
}

async function handleChatCompletions(req, res) {
  if (req.method !== 'POST') { writeOpenAIError(res, 405, 'method not allowed', 'invalid_request_error', ''); return; }
  let requestBody;
  try { requestBody = await readBody(req); } catch (e) { writeOpenAIError(res, 400, 'failed to read request body', 'invalid_request_error', ''); return; }
  let payload;
  try { payload = JSON.parse(requestBody); } catch (e) { writeOpenAIError(res, 400, 'request body must be valid JSON', 'invalid_request_error', ''); return; }
  const requestedModel = (payload.model || '').trim();
  if (!requestedModel) { writeOpenAIError(res, 400, 'model is required', 'invalid_request_error', ''); return; }
  await proxyChatRequest(res, payload, requestedModel, writeOpenAIError, writePassthroughError, writeOpenAISuccessResponse);
}

async function handleClaudeMessages(req, res) {
  if (req.method !== 'POST') { writeClaudeError(res, 405, 'method not allowed', 'invalid_request_error'); return; }
  let requestBody;
  try { requestBody = await readBody(req); } catch (e) { writeClaudeError(res, 400, 'failed to read request body', 'invalid_request_error'); return; }
  let payload, requestedModel, stream;
  try { ({ payload, modelName: requestedModel, stream } = convertClaudeMessagesRequestToOpenAI(requestBody)); } catch (e) { writeClaudeError(res, 400, e.message, 'invalid_request_error'); return; }
  await proxyChatRequest(res, payload, requestedModel, (r, s, m, t, _) => writeClaudeError(r, s, m, t), writeClaudePassthroughError, (r, resp) => writeClaudeSuccessResponse(r, resp, requestedModel, stream));
}

async function handleClaudeCountTokens(req, res) {
  if (req.method !== 'POST') { writeClaudeError(res, 405, 'method not allowed', 'invalid_request_error'); return; }
  let requestBody;
  try { requestBody = await readBody(req); } catch (e) { writeClaudeError(res, 400, 'failed to read request body', 'invalid_request_error'); return; }
  let payload, requestedModel;
  try { ({ payload, modelName: requestedModel } = convertClaudeMessagesRequestToOpenAI(requestBody)); } catch (e) { writeClaudeError(res, 400, e.message, 'invalid_request_error'); return; }
  writeJSON(res, 200, { input_tokens: countOpenAIPayloadTokens(requestedModel, payload) });
}

function countOpenAIPayloadTokens(model, payload) {
  const segments = [];
  if (Array.isArray(payload.messages)) {
    for (const m of payload.messages) {
      if (m && typeof m === 'object') {
        if (m.role) segments.push(m.role);
        if (typeof m.content === 'string') segments.push(m.content);
        else if (Array.isArray(m.content)) {
          for (const p of m.content) if (p && typeof p === 'object' && p.type === 'text' && p.text) segments.push(p.text);
        }
      }
    }
  }
  return Math.ceil(segments.join('\n').length / 4);
}

async function proxyChatRequest(res, payload, requestedModel, writeError, writeUpstreamError, writeSuccess) {
  const reqStart = Date.now();

  const token = tokenPool.getToken();
  if (!token) { writeError(res, 503, 'no authentication tokens configured', 'server_error', 'no_tokens'); return; }
  const client = tokenPool.client;

  let currentModel = requestedModel;
  for (let attempt = 0; attempt < 2; attempt++) {
    let sessionInstanceID;
    let actualModel = currentModel;
    let accessTier = null;
    try {
      const session = await tokenPool.ensureSession(token, currentModel);
      sessionInstanceID = session.instanceID;
      actualModel = session.model;
      accessTier = session.accessTier;
    } catch (e) {
      writeError(res, 502, `failed to acquire upstream free session: ${e.message}`, 'server_error', '');
      return;
    }

    const canonicalModel = canonicalModelName(actualModel);
    const agentID = modelRegistry.getAgentForModel(canonicalModel) || FALLBACK_AGENT_IDS[canonicalModel] || 'base2-free';

    let run;
    try {
      run = await startRunChainNormal(client, token, agentID);
    } catch (e) {
      writeError(res, 502, `failed to start run chain: ${e.message}`, 'server_error', '');
      return;
    }

    let proxyAgent = null;
    if (accessTier === 'limited' && config.warpPlus) {
      if (!warpPlus.isReady()) {
        console.log('[Proxy] Limit detected, starting Warp Plus...');
        const started = await warpPlus.start();
        if (!started) {
          console.log('[Proxy] Warp Plus failed to start, falling back to direct connection');
        }
      }
      if (warpPlus.isReady()) {
        try {
          await nodeFetch('https://api.ipify.org?format=json', { agent: warpPlus.getAgent(), signal: AbortSignal.timeout(5000) });
          proxyAgent = warpPlus.getAgent();
          console.log('[Proxy] Routing chat through Warp Plus');
        } catch (e) {
          console.log(`[Proxy] Warp Plus connectivity test failed (${e.message}), falling back to direct connection`);
          warpPlus.stop();
        }
      }
    }
    if (!proxyAgent) {
      proxyAgent = getOutboundProxyAgent();
      if (proxyAgent) console.log('[Proxy] Routing chat through outbound proxy');
    }

    const requestedDisplay = actualModel !== requestedModel ? ` (locked from ${requestedModel})` : '';
    console.log(`[Request] model: ${actualModel}${requestedDisplay}, run: ${run.runId}, tier: ${accessTier || 'normal'}${proxyAgent ? ', via warp' : ''}`);
    const userMsg = (payload.messages || []).find(m => m.role === 'user');
    if (userMsg) console.log(`[Prompt] ${typeof userMsg.content === 'string' ? userMsg.content : JSON.stringify(userMsg.content)}`);

    const cloned = cloneMap(payload);
    cloned.model = actualModel;

    if (cloned.tools) normalizeToolSchemas(cloned.tools);

    const clientId = generateClientSessionId();
    if (cloned.stream === undefined) cloned.stream = true;
    cloned.codebuff_metadata = {
      run_id: run.runId,
      client_id: clientId,
      ...(sessionInstanceID ? { freebuff_instance_id: sessionInstanceID } : {}),
      trace_session_id: crypto.randomUUID(),
    };
    cloned.provider = { order: 0, allow_fallbacks: true, data_collection: 'deny' };
    if (!cloned.stop) cloned.stop = ['"cb_easp"'];

    let resp;
    try { resp = await client.chatCompletions(token, cloned, proxyAgent); } catch (e) {
      if (proxyAgent) {
        console.log(`[Proxy] Warp Plus failed (${e.message}), retrying direct connection...`);
        proxyAgent = null;
        try { resp = await client.chatCompletions(token, cloned, null); } catch (e2) { writeError(res, 502, e2.message, 'server_error', ''); return; }
      } else {
        writeError(res, 502, e.message, 'server_error', '');
        return;
      }
    }

    if (resp.status === 429) {
      const errorBodyStr = await readBodyText(resp.body);
      console.log(`[Rate Limit] 429: ${errorBodyStr.substring(0, 200)}`);
      for (let retry = 0; retry < 3; retry++) {
        const waitMs = (retry + 1) * 3000;
        console.log(`[Rate Limit] Waiting ${waitMs / 1000}s before retry ${retry + 1}/3...`);
        await new Promise(r => setTimeout(r, waitMs));
        try { resp = await client.chatCompletions(token, cloned, proxyAgent); } catch (e) {
          writeError(res, 502, e.message, 'server_error', '');
          return;
        }
        if (resp.status !== 429) break;
        console.log(`[Rate Limit] Still 429 on retry ${retry + 1}`);
      }
      if (resp.status === 429) {
        const finalBody = await readBodyText(resp.body);
        writeUpstreamError(res, 429, finalBody);
        return;
      }
    }

    if (resp.status >= 200 && resp.status < 300) {
      let messageId = null;
      let actualResponseModel = null;
      try { const result = await writeSuccess(res, resp); messageId = result.messageId; actualResponseModel = result.model; } catch (e) { console.error(`proxy response copy failed: ${e.message}`); }
      console.log(`[Response] model: ${actualResponseModel || actualModel}, completed in ${Date.now() - reqStart}ms (status: ${resp.status})`);
      setImmediate(() => finalizeRunChainNormal(client, token, run, messageId));
      return;
    }

    const errorBodyStr = await readBodyText(resp.body);
    console.log(`[Upstream Error] ${resp.status}: ${errorBodyStr.substring(0, 200)}`);

    if (isSessionInvalid(resp.status, errorBodyStr)) {
      let errorType = '';
      let lockedModel = null;
      try {
        const errorData = JSON.parse(errorBodyStr);
        errorType = errorData.error || '';
        if (errorType === 'session_model_mismatch') {
          lockedModel = errorData.lockedModel || null;
          if (!lockedModel) {
            const cached = await tokenPool.getLockedModel(token);
            if (cached) lockedModel = cached;
          }
          if (!lockedModel) {
            try { const parsed = JSON.parse(errorBodyStr); if (parsed.body && parsed.body.currentModel) lockedModel = parsed.body.currentModel; } catch (_) {}
          }
        }
      } catch (e) {}
      console.log(`[Session Invalid] status=${resp.status}, error=${errorType}${lockedModel ? ', lockedModel=' + lockedModel : ''}`);
      
      if (errorType === 'freebuff_update_required' || resp.status === 426) {
        console.log(`[Version] Server requires update, invalidating session and retrying...`);
      }
      tokenPool.invalidateSession(token, actualModel);
      if (lockedModel) {
        console.log(`[Model Lock] Switching from ${currentModel} to ${lockedModel}`);
        await tokenPool.setLockedModel(token, lockedModel);
        currentModel = lockedModel;
      }
      continue;
    }

    if (isRunInvalid(resp.status, errorBodyStr)) {
      console.log(`run ${run.runId} invalid, retrying`);
      continue;
    }

    console.error(`upstream error response: ${errorBodyStr}`);
    writeUpstreamError(res, resp.status, errorBodyStr);
    return;
  }

  writeError(res, 502, 'upstream run expired twice in a row', 'server_error', '');
}

function isNodeStream(body) {
  return body && typeof body.pipe === 'function' && typeof body.on === 'function';
}

function readBodyText(body) {
  if (isNodeStream(body)) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      body.on('data', c => chunks.push(c));
      body.on('end', () => resolve(Buffer.concat(chunks).toString()));
      body.on('error', reject);
    });
  }
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    const chunks = [];
    return new Promise((resolve, reject) => {
      function pump() {
        reader.read().then(({ done, value }) => {
          if (done) { resolve(Buffer.concat(chunks).toString()); return; }
          chunks.push(Buffer.from(value));
          pump();
        }).catch(reject);
      }
      pump();
    });
  }
  if (body && typeof body[Symbol.asyncIterator] === 'function') {
    const chunks = [];
    return (async () => {
      for await (const chunk of body) chunks.push(Buffer.from(chunk));
      return Buffer.concat(chunks).toString();
    })();
  }
  return String(body);
}

function pipeBodyToResponse(body, res) {
  if (isNodeStream(body)) {
    return new Promise((resolve, reject) => {
      body.on('data', chunk => res.write(chunk));
      body.on('end', () => { res.end(); resolve(); });
      body.on('error', reject);
    });
  }
  return new Promise((resolve, reject) => {
    const reader = body.getReader();
    function pump() {
      reader.read().then(({ done, value }) => {
        if (done) { res.end(); resolve(); return; }
        res.write(value);
        pump();
      }).catch(reject);
    }
    pump();
  });
}

async function writeOpenAISuccessResponse(res, resp) {
  for (const [key, values] of Object.entries(resp.headers)) {
    if (key.toLowerCase() === 'content-length') continue;
    res.setHeader(key, values);
  }
  res.writeHead(resp.status);
  let messageId = null;
  let model = null;

  if (resp.headers['content-type']?.includes('text/event-stream')) {
    const body = resp.body;
    model = await pipeBodyToResponseAndCaptureModel(body, res);
  } else {
    const buffer = await readBodyText(resp.body);
    res.end(buffer);
    try { const parsed = JSON.parse(buffer); if (parsed.id) messageId = parsed.id; if (parsed.model) model = parsed.model; } catch (e) {}
  }

  return { messageId, model };
}

async function pipeBodyToResponseAndCaptureModel(body, res) {
  let model = null;
  let buffer = '';
  let captured = false;

  function processChunk(chunk) {
    const str = chunk instanceof Buffer ? chunk.toString() : typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
    if (!captured) {
      buffer += str;
      const match = buffer.match(/data:\s*(\{.*?\})\n\n/);
      if (match) {
        captured = true;
        try { const parsed = JSON.parse(match[1]); if (parsed.model) model = parsed.model; } catch (_) {}
        res.write(Buffer.from(buffer));
        buffer = '';
        return;
      }
    }
    res.write(chunk instanceof Buffer ? chunk : Buffer.from(typeof chunk === 'string' ? chunk : chunk));
  }

  if (isNodeStream(body)) {
    return new Promise((resolve, reject) => {
      body.on('data', chunk => { processChunk(chunk); });
      body.on('end', () => { if (!captured) { res.write(Buffer.from(buffer)); } res.end(); resolve(model); });
      body.on('error', reject);
    });
  }
  return new Promise((resolve, reject) => {
    const reader = body.getReader();
    function pump() {
      reader.read().then(({ done, value }) => {
        if (done) { if (!captured) { res.write(Buffer.from(buffer)); } res.end(); resolve(model); return; }
        processChunk(value);
        pump();
      }).catch(reject);
    }
    pump();
  });
}

async function writeClaudeSuccessResponse(res, resp, requestedModel, stream) {
  if (stream) {
    res.writeHead(resp.status, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    const model = await pipeBodyToResponseAndCaptureModel(resp.body, res);
    return { messageId: null, model };
  }
  const body = await readBodyText(resp.body);
  const converted = convertOpenAINonStreamResponseToClaude(body);
  res.writeHead(resp.status, { 'Content-Type': 'application/json' });
  res.end(converted);
  let messageId = null;
  let model = null;
  try { const parsed = JSON.parse(body); if (parsed.id) messageId = parsed.id; if (parsed.model) model = parsed.model; } catch (e) {}
  return { messageId, model };
}

// --- Anthropic Conversion ---
function convertClaudeMessagesRequestToOpenAI(body) {
  const root = JSON.parse(body);
  const modelName = (root.model || '').trim();
  if (!modelName) throw new Error('model is required');
  const stream = root.stream || false;
  const out = { model: modelName, messages: [], stream };
  if (root.max_tokens && root.max_tokens > 0) out.max_tokens = root.max_tokens;
  if (root.temperature !== undefined) out.temperature = root.temperature;
  else if (root.top_p !== undefined) out.top_p = root.top_p;
  const messages = [];
  if (root.system) {
    const sysText = typeof root.system === 'string' ? root.system : Array.isArray(root.system) ? root.system.filter(p => p && p.type === 'text').map(p => p.text).join('\n') : '';
    if (sysText.trim()) messages.push({ role: 'system', content: sysText.trim() });
  }
  if (!Array.isArray(root.messages)) throw new Error('messages must be an array');
  for (const rawMessage of root.messages) {
    if (!rawMessage || typeof rawMessage !== 'object') continue;
    const role = (rawMessage.role || '').trim();
    if (!role) continue;
    const content = rawMessage.content;
    let text = '';
    if (typeof content === 'string') text = content;
    else if (Array.isArray(content)) text = content.filter(p => p && p.type === 'text').map(p => p.text || '').join('\n');
    if (text.trim()) messages.push({ role, content: text.trim() });
  }
  out.messages = messages;
  return { payload: out, modelName, stream };
}

function convertOpenAINonStreamResponseToClaude(body) {
  const response = JSON.parse(body);
  const message = { id: response.id || '', type: 'message', role: 'assistant', model: response.model || '', content: [], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } };
  let hasToolCall = false;
  if (response.choices && response.choices.length > 0) {
    const choice = response.choices[0];
    const text = choice.message && choice.message.content;
    if (text && typeof text === 'string' && text.trim()) message.content.push({ type: 'text', text: text.trim() });
    if (choice.message && choice.message.tool_calls) {
      for (const tc of choice.message.tool_calls) {
        hasToolCall = true;
        message.content.push({ type: 'tool_use', id: tc.id || '', name: (tc.function || {}).name || '', input: parseJSONObject((tc.function || {}).arguments) });
      }
    }
    if (choice.finish_reason) message.stop_reason = mapOpenAIFinishReasonToClaude(choice.finish_reason);
  }
  if (response.usage) { message.usage.input_tokens = response.usage.prompt_tokens || 0; message.usage.output_tokens = response.usage.completion_tokens || 0; }
  if (message.stop_reason === 'end_turn' && hasToolCall) message.stop_reason = 'tool_use';
  return JSON.stringify(message);
}

function parseJSONObject(raw) { if (!raw) return {}; try { const v = JSON.parse(raw); return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {}; } catch (e) { return {}; } }
function mapOpenAIFinishReasonToClaude(reason) { const r = (reason || '').toLowerCase().trim(); if (r === 'tool_calls' || r === 'function_call') return 'tool_use'; if (r === 'length') return 'max_tokens'; return 'end_turn'; }

function writePassthroughError(res, statusCode, body) {
  const trimmed = body.trim();
  try { const payload = JSON.parse(trimmed); writeOpenAIError(res, statusCode, payload.error?.message || payload.message || trimmed, payload.error?.type || 'upstream_error', payload.error?.code || ''); }
  catch (e) { writeOpenAIError(res, statusCode, trimmed, 'upstream_error', ''); }
}

function writeClaudePassthroughError(res, statusCode, body) {
  const trimmed = body.trim();
  try { const payload = JSON.parse(trimmed); writeClaudeError(res, statusCode, payload.error?.message || payload.message || trimmed, 'api_error'); }
  catch (e) { writeClaudeError(res, statusCode, trimmed, 'api_error'); }
}

// --- Token Validation ---
async function validateToken(token) {
  try {
    const client = new UpstreamClient(config);
    const session = await client.createSession(token);
    return session && session.status === 'active';
  } catch (e) {
    let lockedModel = null;
    try { const parsed = JSON.parse(e.message); if (parsed.type === 'model_locked' && parsed.body && parsed.body.currentModel) lockedModel = parsed.body.currentModel; } catch (_) {}
    if (lockedModel) {
      try {
        const client2 = new UpstreamClient(config);
        const session = await client2.createSession(token, lockedModel);
        return session && session.status === 'active';
      } catch (e2) {
        console.error(`Token validation error for ${token.substring(0, 8)}... (tried locked model ${lockedModel}): ${e2.message}`);
        return false;
      }
    }
    console.error(`Token validation error for ${token.substring(0, 8)}...: ${e.message}`);
    return false;
  }
}

async function validateAllTokens() {
  if (!config.authTokens || config.authTokens.length === 0) { console.log('No auth tokens configured'); return []; }
  const results = [];
  for (const token of config.authTokens) {
    const valid = await validateToken(token);
    results.push({ token: token.substring(0, 8) + '...' + token.substring(token.length - 4), valid: !!valid });
    if (valid) console.log(`Token ${token.substring(0, 8)}... is valid`);
    else console.log(`Token ${token.substring(0, 8)}... is INVALID`);
  }
  return results;
}

async function reloadTokenPool() {
  config = loadConfig();
  const client = new UpstreamClient(config);
  tokenPool = new TokenPool(config.authTokens, config, client);
  console.log(`TokenPool reloaded with ${config.authTokens.length} token(s)`);
}

// --- Main Request Handler ---
async function handleRequest(req, res) {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  if (config.apiKeys && config.apiKeys.length > 0 && !authorized(req)) {
    if (isClaudeRequestPath(pathname)) writeClaudeError(res, 401, 'invalid proxy api key', 'authentication_error');
    else writeOpenAIError(res, 401, 'invalid proxy api key', 'authentication_error', '');
    return;
  }

  if (pathname === '/dashboard' || pathname === '/') {
    const dashboardPath = path.join(__dirname, 'dashboard.html');
    if (fs.existsSync(dashboardPath)) { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(fs.readFileSync(dashboardPath)); return; }
    res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Dashboard not found'); return;
  }

  if (pathname === '/api/config') {
    if (req.method === 'GET') { writeJSON(res, 200, config); return; }
    if (req.method === 'POST') {
      try { const body = await readBody(req); const newConfig = JSON.parse(body); config = { ...config, ...newConfig }; saveConfig(config); writeJSON(res, 200, { success: true, config }); }
      catch (e) { writeJSON(res, 400, { error: e.message }); }
      return;
    }
  }

  if (pathname === '/api/tokens' && req.method === 'GET') {
    const maskedTokens = (config.authTokens || []).map(t => ({ token: t.substring(0, 8) + '...' + t.substring(t.length - 4), fullLength: t.length }));
    writeJSON(res, 200, { tokens: maskedTokens, count: maskedTokens.length }); return;
  }

  if (pathname === '/api/auth/start' && req.method === 'POST') {
    try { const resp = await fetch('https://freebuff.llm.pm/api/code', { method: 'POST' }); if (!resp.ok) throw new Error('OAuth server error: ' + resp.status); writeJSON(res, 200, await resp.json()); }
    catch (e) { writeJSON(res, 500, { error: e.message }); }
    return;
  }

  if (pathname === '/api/auth/status' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const { fingerprintId, fingerprintHash, expiresAt } = JSON.parse(body);
      const resp = await fetch('https://freebuff.llm.pm/api/status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fingerprintId, fingerprintHash, expiresAt }) });
      if (!resp.ok) throw new Error('OAuth status error: ' + resp.status);
      const data = await resp.json();
      if (data.user && data.user.authToken) {
        if (!config.authTokens) config.authTokens = [];
        if (!config.authTokens.includes(data.user.authToken)) { config.authTokens.push(data.user.authToken); saveConfig(config); reloadTokenPool(); console.log('New auth token added via OAuth'); }
        data.tokenAdded = true;
      }
      writeJSON(res, 200, data);
    } catch (e) { writeJSON(res, 500, { error: e.message }); }
    return;
  }

  if (pathname === '/api/models' && req.method === 'GET') { writeJSON(res, 200, { models: modelRegistry.getModels(), model_metadata: modelRegistry.getAllModelMetadata() }); return; }

  if (pathname === '/api/bg' && req.method === 'GET') {
    try { const response = await fetch('https://peapix.com/bing/feed'); const data = await response.json(); const item = Array.isArray(data) ? data[0] : data; const imgUrl = item.fullUrl || item.imageUrl || item.url || ''; if (imgUrl) writeJSON(res, 200, { url: imgUrl }); else writeJSON(res, 404, { error: 'not found' }); }
    catch (e) { writeJSON(res, 500, { error: e.message }); }
    return;
  }

  if (pathname === '/api/ads' && req.method === 'GET') {
    const token = (config.authTokens || [])[0];
    if (!token) { writeJSON(res, 200, []); return; }
    try {
      const sessionId = crypto.randomUUID();
      const body = {
        provider: 'gravity',
        messages: [],
        sessionId,
        device: { os: 'windows', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', locale: 'en-US' },
        surface: 'waiting_room',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
      };
      const resp = await fetch(config.upstreamBaseURL + '/api/v1/ads', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': getAdsUserAgent(), 'Accept': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000)
      });
      if (!resp.ok) { writeJSON(res, 200, []); return; }
      const data = await resp.json();
      console.log('[Ads] Response:', JSON.stringify(data).substring(0, 500));
      writeJSON(res, 200, data);
    } catch (e) { console.error('[Ads] Error:', e.message); writeJSON(res, 200, []); }
    return;
  }

  if (pathname === '/api/ads/impression' && req.method === 'POST') {
    const token = (config.authTokens || [])[0];
    if (!token) { writeJSON(res, 200, { success: false }); return; }
    try {
      const body = await readBody(req);
      const { impUrl, mode } = JSON.parse(body);
      const resp = await fetch(config.upstreamBaseURL + '/api/v1/ads/impression', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': getAdsUserAgent(), 'Accept': 'application/json' },
        body: JSON.stringify({ impUrl, mode: mode || 'LITE' }),
        signal: AbortSignal.timeout(10000)
      });
      const data = await resp.json();
      writeJSON(res, 200, data);
    } catch (e) { writeJSON(res, 200, { success: false, error: e.message }); }
    return;
  }

  if (pathname === '/healthz') { await handleHealthz(req, res); return; }
  if (pathname === '/v1/models') { await handleModels(req, res); return; }
  if (pathname === '/v1/chat/completions') { await debounceRequest(); await handleChatCompletions(req, res); return; }
  if (pathname === '/v1/messages') { await debounceRequest(); await handleClaudeMessages(req, res); return; }
  if (pathname === '/v1/messages/count_tokens') { await handleClaudeCountTokens(req, res); return; }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
}

// --- Country Detection ---
async function detectCountry() {
  try {
    const resp = await fetch('https://ipapi.co/json/', { signal: AbortSignal.timeout(5000) });
    if (resp.ok) {
      const data = await resp.json();
      if (data.country_code) {
        DETECTED_COUNTRY = data.country_code;
        console.log(`[Country] Detected: ${DETECTED_COUNTRY}`);
        return;
      }
    }
  } catch (_) {}
  try {
    const resp = await fetch('https://ipinfo.io/json', { signal: AbortSignal.timeout(5000) });
    if (resp.ok) {
      const data = await resp.json();
      if (data.country) {
        DETECTED_COUNTRY = data.country;
        console.log(`[Country] Detected: ${DETECTED_COUNTRY}`);
        return;
      }
    }
  } catch (_) {}
  console.log('[Country] Could not detect country');
}

// --- Server Startup ---
async function startServer() {
  console.log('╔═══════════════════════════════════════════════════════════════╗');
  console.log('║  Freebuff2Opencode Proxy - Starting...                            ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝');

  try { config = loadConfig(); } catch (e) { console.error('Failed to load config:', e.message); process.exit(1); }

  const cliTokens = loadFreebuffCLITokens();
  if (cliTokens.length > 0) {
    console.log(`[Config] Found ${cliTokens.length} token(s) in CLI credentials`);
    config.authTokens = [...new Set([...(config.authTokens || []), ...cliTokens])];
  }

  await checkAndUpdateVersions();
  await checkProxyVersion();

  detectCountry().catch(() => {});

  modelRegistry = new ModelRegistry();
  await modelRegistry.start();

  setupOpencodeConfig();

  const allTokenResults = await validateAllTokens();
  const validTokens = allTokenResults.filter(r => r.valid);
  const port = parseInt(config.listenAddr.replace(':', '')) || 8080;

  const client = new UpstreamClient(config);
  const tokensToUse = validTokens.length > 0
    ? validTokens.map(t => {
        const masked = t.token;
        return config.authTokens.find(tok => tok.startsWith(masked.substring(0, 8)));
      }).filter(Boolean)
    : config.authTokens;
  tokenPool = new TokenPool(tokensToUse, config, client);

  if (validTokens.length === 0 && config.authTokens.length > 0) {
    console.log(`[Warning] No tokens passed validation, using ${config.authTokens.length} configured token(s) anyway`);
  }

  const server = http.createServer(handleRequest);
  server.listen(port, '0.0.0.0', () => {
    console.log(`\nFreebuff2Opencode Proxy on http://0.0.0.0:${port}`);
    console.log(`  Upstream: ${config.upstreamBaseURL}`);
    console.log(`  Models: ${modelRegistry.getModels().length}`);
    console.log(`  API keys: ${config.apiKeys.length > 0 ? config.apiKeys.length + ' (auth enabled)' : 'none (open access)'}`);
    console.log(`  Valid tokens: ${validTokens.length}`);
    console.log(`  Warp Plus: ${config.warpPlus ? 'enabled (auto-start on limit)' : 'disabled'}`);
    if (config.outboundProxy) console.log(`  Outbound Proxy: ${config.outboundProxy.replace(/\/\/[^@]*@/, '//***@')}`);
    console.log('');
  });

  setInterval(async () => {
    const cliTokens = loadFreebuffCLITokens();
    if (cliTokens.length > 0) {
      const currentTokens = new Set(config.authTokens || []);
      const newTokens = cliTokens.filter(t => !currentTokens.has(t));
      if (newTokens.length > 0) {
        console.log(`Found ${newTokens.length} new token(s) in CLI credentials`);
        for (const token of newTokens) {
          const valid = await validateToken(token);
          if (valid) { config.authTokens.push(token); console.log(`Added valid token: ${token.substring(0, 8)}...`); }
        }
        if (config.authTokens.length > currentTokens.size) { saveConfig(config); await reloadTokenPool(); }
      }
    }
  }, TOKEN_RELOAD_INTERVAL);

  setInterval(async () => {
    try { await checkAndUpdateVersions(); } catch (e) { /* ignore */ }
    try { await checkProxyVersion(); } catch (e) { /* ignore */ }
  }, 60 * 60 * 1000);
}

startServer();
