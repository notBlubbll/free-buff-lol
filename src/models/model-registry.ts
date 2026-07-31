const https = require("https");

function createModelRegistry({
  getConfig,
  modelRefreshInterval,
  sourceUrls,
  isBlacklistedModel,
  canonicalModelName,
  logInfo,
  logError,
}) {
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
      this.refreshTimer = setInterval(
        () => this.refresh(),
        modelRefreshInterval,
      );
    }

    stop() {
      if (this.refreshTimer) {
        clearInterval(this.refreshTimer);
        this.refreshTimer = null;
      }
    }

    async refresh() {
      const fallback = [
        [
          "deepseek/deepseek-v4-pro",
          "base2-free-deepseek",
          "DeepSeek V4 Pro",
          true,
          { input: ["text", "image"], output: ["text"] },
          { context: 128000, output: 32000 },
        ],
        [
          "mimo/mimo-v2.5-pro",
          "base2-free-mimo-pro",
          "MiMo 2.5 Pro",
          true,
          { input: ["text", "image"], output: ["text"] },
          { context: 512000, output: 32000 },
        ],
        [
          "moonshotai/kimi-k2.6",
          "base2-free-kimi",
          "Kimi K2.6",
          true,
          { input: ["text", "image"], output: ["text"] },
          { context: 256000, output: 32000 },
        ],
        [
          "minimax/minimax-m3",
          "base2-free-minimax-m3",
          "MiniMax M3",
          false,
          { input: ["text", "image", "video"], output: ["text"] },
          { context: 512000, output: 32000 },
        ],
        [
          "deepseek/deepseek-v4-flash",
          "base2-free-deepseek-flash",
          "DeepSeek V4 Flash",
          false,
          { input: ["text"], output: ["text"] },
          { context: 128000, output: 32000 },
        ],
        [
          "mimo/mimo-v2.5",
          "base2-free-mimo",
          "MiMo 2.5",
          false,
          { input: ["text", "image"], output: ["text"] },
          { context: 512000, output: 32000 },
        ],
        [
          "minimax/minimax-m2.7",
          "base2-free",
          "MiniMax M2.7",
          false,
          { input: ["text"], output: ["text"] },
          { context: 128000, output: 32000 },
        ],
        [
          "google/gemini-3.1-flash-lite-preview",
          "basher",
          "Gemini 3.1 Flash Lite",
          false,
          { input: ["text", "image"], output: ["text"] },
          { context: 256000, output: 32000 },
        ],
        [
          "google/gemini-3.1-pro-preview",
          "thinker-with-files-gemini",
          "Gemini 3.1 Pro",
          true,
          { input: ["text", "image"], output: ["text"] },
          { context: 256000, output: 32000 },
        ],
      ];
      let loaded = false;
      try {
        const [modelsSource, agentsSource, idsSource, configSource] =
          await Promise.all([
            this.fetchSource(sourceUrls.models),
            this.fetchSource(sourceUrls.agents),
            this.fetchSource(sourceUrls.ids),
            this.fetchSource(sourceUrls.config),
          ]);
        const objects = this.parseObjectLiterals(configSource);
        const variables = new Map([
          ...this.parseConstants(configSource, objects),
          ...this.parseConstants(idsSource, objects),
          ...this.parseConstants(modelsSource, objects),
          ...this.parseConstants(agentsSource),
        ]);
        this.resolveConstantAliases(variables, [
          modelsSource,
          idsSource,
          configSource,
          agentsSource,
        ]);
        const roots = this.parseRootAgentModelMapping(agentsSource, variables);
        for (const [agent, models] of this.parseAllFreeModels(
          agentsSource,
          variables,
        )) {
          for (const model of models)
            if (!roots.has(model)) roots.set(model, agent);
        }
        for (const [model, agent] of [
          ["google/gemini-3.1-flash-lite-preview", "basher"],
          ["google/gemini-3.1-pro-preview", "thinker-with-files-gemini"],
          ["google/gemini-2.5-flash-lite", "file-picker"],
        ])
          if (!roots.has(model)) roots.set(model, agent);
        if (!roots.has("tencent/hy3"))
          roots.set("tencent/hy3", "base2-free-hy3-atlas");
        const metadata = this.parseModelMetadata(modelsSource, variables);
        const userModels = this.parseUserFacingModelIds(
          modelsSource,
          variables,
        );
        const currentConfig = getConfig();
        const configured = Array.isArray(currentConfig?.enabledModels)
          ? currentConfig.enabledModels.map(canonicalModelName)
          : [];
        const compatibility = new Map([
          [
            "google/gemini-2.5-flash-lite",
            ["Gemini 2.5 Flash Lite", false, true],
          ],
          [
            "google/gemini-3.1-flash-lite-preview",
            ["Gemini 3.1 Flash Lite", false, true],
          ],
          ["google/gemini-3.1-pro-preview", ["Gemini 3.1 Pro", true, true]],
          ["tencent/hy3", ["HY3", true, false]],
        ]);
        for (const [model, [displayName, premium, multimodal]] of compatibility)
          if (!metadata.has(model) && configured.includes(model))
            metadata.set(model, {
              displayName,
              premium,
              multimodal,
              modalities: {
                input: multimodal ? ["text", "image"] : ["text"],
                output: ["text"],
              },
              limit: null,
              metadata_source: "local compatibility mapping",
            });
        const catalog = [
          ...new Set([...userModels, ...metadata.keys(), ...configured]),
        ].filter((model) => roots.has(model));
        if (catalog.length) {
          const modelToAgent = new Map(),
            allModels = [],
            displayNames = new Map(),
            modelMetadata = new Map(),
            agentModels = new Map();
          for (const model of catalog) {
            if (isBlacklistedModel(model)) {
              logInfo(`Model registry: blacklisted model excluded: ${model}`);
              continue;
            }
            const agent = roots.get(model),
              meta = metadata.get(model);
            modelToAgent.set(model, agent);
            allModels.push(model);
            displayNames.set(
              model,
              meta?.displayName || model.split("/").pop(),
            );
            modelMetadata.set(
              model,
              meta ||
                this.createUnknownMetadata(
                  model,
                  "catalog model without metadata",
                ),
            );
            if (!agentModels.has(agent)) agentModels.set(agent, []);
            agentModels.get(agent).push(model);
          }
          allModels.sort();
          this.agentModels = agentModels;
          this.modelToAgent = modelToAgent;
          this.allModels = allModels;
          this.modelDisplayNames = displayNames;
          this.modelMetadata = modelMetadata;
          this.lastOK = new Date();
          loaded = true;
          logInfo(
            `Model registry: fetched ${allModels.length} user-facing models from GitHub: ${allModels.join(", ")}`,
          );
        }
      } catch (error) {
        logError("Model registry: GitHub fetch failed:", error.message);
      }
      if (!loaded) {
        const modelToAgent = new Map(),
          allModels = [],
          displayNames = new Map(),
          modelMetadata = new Map(),
          agentModels = new Map();
        for (const [
          model,
          agent,
          displayName,
          premium,
          modalities,
          limit,
        ] of fallback) {
          if (isBlacklistedModel(model)) continue;
          modelToAgent.set(model, agent);
          allModels.push(model);
          displayNames.set(model, displayName);
          modelMetadata.set(model, {
            displayName,
            premium,
            modalities,
            limit,
            metadata_source: "local fallback",
          });
          if (!agentModels.has(agent)) agentModels.set(agent, []);
          agentModels.get(agent).push(model);
        }
        allModels.sort();
        this.agentModels = agentModels;
        this.modelToAgent = modelToAgent;
        this.allModels = allModels;
        this.modelDisplayNames = displayNames;
        this.modelMetadata = modelMetadata;
        this.lastOK = new Date();
        logInfo(
          `Model registry: hardcoded fallback ${allModels.length} models: ${allModels.join(", ")}`,
        );
      }
    }

    fetchSource(sourceUrl) {
      return new Promise((resolve, reject) => {
        const req = https.get(sourceUrl, (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => resolve(data));
        });
        req.on("error", reject);
        req.setTimeout(30000, () => {
          req.destroy();
          reject(new Error("Request timeout"));
        });
      });
    }
    parseConstants(source, objects) {
      const result = new Map(),
        pattern = /export const (\w+)\s*=\s*['"]([^'"]+)['"]/g;
      let match;
      while ((match = pattern.exec(source))) result.set(match[1], match[2]);
      if (objects) {
        const refs = /export const (\w+)\s*=\s*(\w+)\.(\w+)/g;
        while ((match = refs.exec(source)))
          if (objects.has(`${match[2]}.${match[3]}`))
            result.set(match[1], objects.get(`${match[2]}.${match[3]}`));
      }
      return result;
    }
    resolveConstantAliases(values, sources) {
      const aliases = new Map();
      for (const source of sources) {
        const pattern = /export const (\w+)\s*=\s*(\w+)\s*$/gm;
        let match;
        while ((match = pattern.exec(source))) aliases.set(match[1], match[2]);
      }
      for (let pass = 0; pass <= aliases.size; pass++) {
        let changed = false;
        for (const [name, target] of aliases) {
          const value = values.get(target);
          if (value && values.get(name) !== value) {
            values.set(name, value);
            changed = true;
          }
        }
        if (!changed) break;
      }
    }
    parseObjectLiterals(source) {
      const result = new Map(),
        pattern =
          /(?:export\s+)?const\s+(\w+)\s*=\s*\{([\s\S]*?)\}\s*(?:as\s+const)?/g;
      let object;
      while ((object = pattern.exec(source))) {
        const properties = /(?:^|,)\s*(\w+)\s*:\s*['"]([^'"]+)['"]/g;
        let property;
        while ((property = properties.exec(object[2])))
          result.set(`${object[1]}.${property[1]}`, property[2]);
      }
      return result;
    }
    parseAllFreeModels(source, variables) {
      const result = new Map(),
        blocks =
          /(?:'([^']+)'|(\w+)|\[([^\]]+)\])\s*:\s*new\s+Set\(\[([^\]]*)\]\)/g;
      let block;
      while ((block = blocks.exec(source))) {
        const agent =
            block[1] || block[2] || variables.get(block[3]) || block[3],
          models = [],
          tokens = /(?:'([^']+)')|(\w+)/g;
        let token;
        while ((token = tokens.exec(block[4])))
          if (token[1]) models.push(token[1].trim());
          else if (variables.has(token[2]))
            models.push(variables.get(token[2]));
        if (models.length) result.set(agent, models);
      }
      return result;
    }
    parseUserFacingModelIds(source, variables) {
      const declaration = /export\s+const\s+FREEBUFF_MODELS\s*=\s*/.exec(
        source,
      );
      if (!declaration) return [];
      const start = source.indexOf(
        "[",
        declaration.index + declaration[0].length,
      );
      if (start < 0) return [];
      let depth = 0,
        quote = null,
        end = -1;
      for (let i = start; i < source.length; i++) {
        const char = source[i];
        if (quote) {
          if (char === quote && source[i - 1] !== "\\") quote = null;
          continue;
        }
        if (char === "'" || char === '"' || char === "`") quote = char;
        else if (char === "[") depth++;
        else if (char === "]" && --depth === 0) {
          end = i;
          break;
        }
      }
      if (end < 0) return [];
      const body = source.slice(start + 1, end),
        objects = new Map(),
        objectPattern =
          /(?:export\s+)?const\s+(\w+)\s*=\s*\{([\s\S]*?)\}\s*as\s+const/g;
      let object;
      while ((object = objectPattern.exec(source))) {
        const id = object[2].match(/\bid:\s*(\w+|'[^']+')/);
        if (id)
          objects.set(
            object[1],
            id[1].startsWith("'") ? id[1].slice(1, -1) : variables.get(id[1]),
          );
      }
      const result = [],
        seen = new Set(),
        entries = /(?:\.\.\.)?\b([A-Za-z_$][\w$]*)\b/g;
      let entry;
      while ((entry = entries.exec(body))) {
        const model = objects.get(entry[1]);
        if (model && !seen.has(model)) {
          seen.add(model);
          result.push(model);
        }
      }
      return result;
    }
    parseRootAgentModelMapping(source, variables) {
      const result = new Map(),
        block = /FREEBUFF_ROOT_AGENT_ID_BY_MODEL[^\{]*\{([^}]+)\}/gs.exec(
          source,
        );
      if (!block) return result;
      const entries = /\[(\w+)\]\s*:\s*'([^']+)'/g;
      let entry;
      while ((entry = entries.exec(block[1]))) {
        const model = variables.get(entry[1]);
        if (model) result.set(model, entry[2]);
      }
      return result;
    }
    parseModelMetadata(source, variables) {
      const result = new Map(),
        blocks = /(?:export\s+)?const\s+(\w+)\s*=\s*\{/g;
      let block;
      while ((block = blocks.exec(source))) {
        const end = this.findMatchingBrace(
          source,
          block.index + block[0].length - 1,
        );
        if (end < 0) continue;
        const body = source.slice(block.index + block[0].length, end),
          idMatch = body.match(/\bid:\s*(\w+|'[^']*')/);
        if (!idMatch) continue;
        const id = idMatch[1].startsWith("'")
          ? idMatch[1].slice(1, -1)
          : variables.get(idMatch[1]);
        if (!id) continue;
        const display = body.match(/\bdisplayName:\s*'([^']+)'/),
          premium = body.match(/\bpremium:\s*(true|false)/),
          multimodal = body.match(/\bmultimodal:\s*(true|false)/),
          availability = body.match(/\bavailability:\s*'([^']+)'/),
          tagline = body.match(/\btagline:\s*'([^']+)'/),
          dataUse = body.match(/\bdataUse:\s*'([^']+)'/),
          experimental = body.match(/\bexperimental:\s*(true|false)/),
          context = this.parseContextWindow(source, id, variables),
          multi = multimodal ? multimodal[1] === "true" : null;
        result.set(id, {
          displayName: display ? display[1] : id.split("/").pop(),
          tagline: tagline ? tagline[1] : null,
          availability: availability ? availability[1] : null,
          premium: premium ? premium[1] === "true" : false,
          multimodal: multi,
          modalities:
            multi === null
              ? null
              : {
                  input: multi ? ["text", "image"] : ["text"],
                  output: ["text"],
                },
          limit: context ? { context, output: null } : null,
          data_use: dataUse ? dataUse[1] : null,
          experimental: experimental ? experimental[1] === "true" : false,
          metadata_source: sourceUrls.models,
          context_window_source: context
            ? `${sourceUrls.models}:FREEBUFF_MODEL_CONTEXT_WINDOWS`
            : null,
        });
      }
      return result;
    }
    findMatchingBrace(source, start) {
      let depth = 0,
        quote = null;
      for (let i = start; i < source.length; i++) {
        const char = source[i];
        if (quote) {
          if (char === quote && source[i - 1] !== "\\") quote = null;
          continue;
        }
        if (char === "'" || char === '"' || char === "`") quote = char;
        else if (char === "{") depth++;
        else if (char === "}" && --depth === 0) return i;
      }
      return -1;
    }
    parseContextWindow(source, modelId, variables) {
      const table =
        /FREEBUFF_MODEL_CONTEXT_WINDOWS\s*:[^=]*=\s*\{([\s\S]*?)\n\}/.exec(
          source,
        );
      if (!table) return null;
      const entries = /\[([^\]]+)\]\s*:\s*([\d_]+)/g;
      let entry;
      while ((entry = entries.exec(table[1])))
        if (
          (variables.get(entry[1].trim()) ||
            entry[1].trim().replace(/^['"]|['"]$/g, "")) === modelId
        )
          return Number(entry[2].replace(/_/g, "")) || null;
      return null;
    }
    createUnknownMetadata(model, reason) {
      return {
        displayName: model.split("/").pop(),
        premium: false,
        modalities: null,
        limit: null,
        metadata_source: reason,
      };
    }
    normalizeOpenCodeLimit(limit) {
      if (!limit || typeof limit !== "object") return null;
      const normalized = {};
      if (Number.isFinite(limit.context)) normalized.context = limit.context;
      if (Number.isFinite(limit.output)) normalized.output = limit.output;
      return Number.isFinite(normalized.context) &&
        Number.isFinite(normalized.output)
        ? normalized
        : null;
    }
    getDisplayName(model) {
      return this.modelDisplayNames.get(model) || model.split("/").pop();
    }
    getModels() {
      return [...this.allModels];
    }
    hasModel(model) {
      return this.modelToAgent.has(model);
    }
    getAgentForModel(model) {
      return this.modelToAgent.get(model);
    }
    getAgentIDs() {
      return [...new Set(this.modelToAgent.values())];
    }
    getModelMetadata(model) {
      return this.modelMetadata.get(model) || null;
    }
    getAllModelMetadata() {
      return Object.fromEntries(this.modelMetadata);
    }
  }
  return ModelRegistry;
}

module.exports = { createModelRegistry };
