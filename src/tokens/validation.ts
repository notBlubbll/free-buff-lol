function createTokenValidation(deps) {
  const {
    getConfig,
    setConfig,
    getTokenPool,
    setTokenPool,
    loadConfig,
    TokenPool,
    UpstreamClient,
    logError,
    logWarn,
    logInfo,
    extractQuota,
  } = deps;
  const config = new Proxy(
    {},
    {
      get: (_, key) => getConfig()?.[key],
      set: (_, key, value) => {
        getConfig()[key] = value;
        return true;
      },
    },
  );
  const tokenPool = new Proxy(
    {},
    {
      get: (_, key) => {
        const value = getTokenPool()?.[key];
        return typeof value === "function" ? value.bind(getTokenPool()) : value;
      },
    },
  );
  // --- Token Validation ---
  async function validateToken(token) {
    const now = new Date().toISOString();
    try {
      const client = new UpstreamClient(config);
      const cached = tokenPool?.getSessionForToken(token);
      if (cached?.instanceID) {
        try {
          const existing = await client.getSession(token, cached.instanceID);
          if (
            existing &&
            (existing.status === "active" || existing.status === "queued")
          ) {
            return {
              valid: true,
              status: "active",
              error: null,
              checkedAt: now,
              lockedModel: cached.model || existing.model || null,
              session: existing,
            };
          }
        } catch (_) {}
      }
      let session = await client.createSession(token);
      if (session && session.status === "active") {
        return {
          valid: true,
          status: "active",
          error: null,
          checkedAt: now,
          lockedModel: session.model || null,
          session,
        };
      }
      return {
        valid: false,
        status: "unknown",
        error: `unexpected session status: ${session ? session.status : "empty"}`,
        checkedAt: now,
      };
    } catch (e) {
      let lockedModel = null;
      try {
        const parsed = JSON.parse(e.message);
        if (
          parsed.type === "model_locked" &&
          parsed.body &&
          parsed.body.currentModel
        )
          lockedModel = parsed.body.currentModel;
      } catch (_) {}
      if (lockedModel) {
        try {
          const client2 = new UpstreamClient(config);
          const session = await client2.createSession(token, lockedModel);
          if (session && session.status === "active") {
            return {
              valid: true,
              status: "active",
              error: null,
              checkedAt: now,
              lockedModel,
              session,
            };
          }
          return {
            valid: false,
            status: "unknown",
            error: `locked model ${lockedModel} not active`,
            checkedAt: now,
          };
        } catch (e2) {
          logError(
            `Token validation error for ${token.substring(0, 8)}... (tried locked model ${lockedModel}): ${e2.message}`,
          );
          return {
            valid: false,
            status: classifyTokenError(e2),
            error: e2.message,
            checkedAt: now,
          };
        }
      }
      const status = classifyTokenError(e);
      logError(
        `Token validation error for ${token.substring(0, 8)}...: ${e.message}`,
      );
      return { valid: false, status, error: e.message, checkedAt: now };
    }
  }

  function classifyTokenError(e) {
    const msg = (e && e.message) || String(e);
    if (
      msg.includes("429") &&
      (msg.includes("rate_limited") || msg.includes('"limit"'))
    )
      return "rate_limited";
    if (msg.includes("403") && msg.includes("banned")) return "banned";
    if (
      msg.includes("401") ||
      msg.includes("Invalid API key") ||
      msg.includes("unauthorized")
    )
      return "unauthorized";
    if (
      msg.includes("ECONNREFUSED") ||
      msg.includes("ETIMEDOUT") ||
      msg.includes("network") ||
      msg.includes("fetch failed")
    )
      return "network_error";
    return "unknown";
  }

  async function validateAllTokens() {
    if (!config.authTokens || config.authTokens.length === 0) {
      logWarn("No auth tokens configured");
      return [];
    }
    const results = [];
    for (const token of config.authTokens) {
      const result = await validateToken(token);
      results.push({ token, ...result });
      if (result.valid) logInfo(`Token ${token.substring(0, 8)}... is valid`);
      else
        logWarn(
          `Token ${token.substring(0, 8)}... is INVALID (${result.status})`,
        );
    }
    return results;
  }

  async function reloadTokenPool() {
    setConfig(loadConfig());
    const client = new UpstreamClient(config);
    const previousPool = tokenPool;
    const previousHealth = previousPool ? previousPool.getAllTokenHealth() : {};
    const previousSessions = previousPool ? previousPool.sessions : new Map();
    const previousLocks = previousPool ? previousPool.lockedModels : new Map();
    if (previousPool) previousPool.dispose();
    setTokenPool(new TokenPool(config.authTokens, config, client));
    for (const [key, session] of previousSessions.entries()) {
      const token = key.split(":")[0];
      if (config.authTokens.includes(token))
        tokenPool.sessions.set(key, session);
    }
    for (const [token, model] of previousLocks.entries()) {
      if (config.authTokens.includes(token))
        tokenPool.lockedModels.set(token, model);
    }
    for (const [token, health] of Object.entries(previousHealth)) {
      if (config.authTokens.includes(token)) {
        tokenPool.setTokenHealth(token, health);
      }
    }
    logInfo(
      `TokenPool reloaded with ${config.authTokens.length} token(s), preserved ${tokenPool.sessions.size} session(s)`,
    );
  }

  async function probeNewModels(models) {
    if (!tokenPool || !tokenPool.tokens || tokenPool.tokens.length === 0)
      return;
    const client = new UpstreamClient(config);
    const remaining = [...models];
    for (const token of tokenPool.tokens) {
      if (remaining.length === 0) break;
      for (const [key, session] of tokenPool.sessions.entries()) {
        if (!key.startsWith(token + ":")) continue;
        if (session.rateLimit && session.rateLimit.rateLimitsByModel) {
          for (const model of remaining) {
            if (session.rateLimit.rateLimitsByModel[model]) {
              tokenPool.updateTokenUsage(token, model, session.rateLimit);
              remaining.splice(remaining.indexOf(model), 1);
            }
          }
        }
      }
    }
    if (remaining.length > 0 && tokenPool.getToken()) {
      const probeToken = tokenPool.getToken();
      const probeModel = (config.enabledModels || [])[0];
      if (probeToken && probeModel) {
        try {
          const state = await client.createSession(probeToken, probeModel);
          const quota = extractQuota(state);
          if (quota) {
            tokenPool.updateTokenUsage(probeToken, probeModel, quota);
            if (quota.rateLimitsByModel) {
              for (const model of remaining) {
                if (quota.rateLimitsByModel[model]) {
                  tokenPool.updateTokenUsage(
                    probeToken,
                    model,
                    quota.rateLimitsByModel[model],
                  );
                  remaining.splice(remaining.indexOf(model), 1);
                }
              }
            }
          }
          if (state && state.instanceId) {
            client.endSession(probeToken, state.instanceId).catch(() => {});
          }
        } catch (e) {
          tokenPool.updateTokenUsageFromError(probeToken, null, e);
        }
      }
    }
    if (remaining.length < models.length) {
      logInfo(
        `[Probe] Pre-seeded quota data for ${models.length - remaining.length}/${models.length} new model(s)`,
      );
    }
  }

  return {
    validateToken,
    classifyTokenError,
    validateAllTokens,
    reloadTokenPool,
    probeNewModels,
  };
}

module.exports = { createTokenValidation };
