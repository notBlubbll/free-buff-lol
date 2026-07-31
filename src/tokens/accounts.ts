function createAccountManager(deps) {
  const {
    crypto,
    getConfig,
    getTokenPool,
    saveConfig,
    logInfo,
    logDebug,
    logWarn,
    logError,
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
  function tokenFingerprint(token) {
    return crypto.createHash("sha256").update(token).digest("hex").slice(0, 16);
  }

  function normalizeEmail(email) {
    return typeof email === "string" && email.trim()
      ? email.trim().toLowerCase()
      : null;
  }

  function accountIdentityKey(identity, token) {
    if (identity.accountId) return `id:${identity.accountId}`;
    if (identity.email) return `email:${normalizeEmail(identity.email)}`;
    return `temp:${tokenFingerprint(token)}`;
  }

  function accountForToken(token) {
    return (
      config?.tokenAccounts?.[token] || {
        accountId: config?.tokenEmails?.[token]
          ? `email:${normalizeEmail(config.tokenEmails[token])}`
          : `temp:${tokenFingerprint(token)}`,
        email: normalizeEmail(config?.tokenEmails?.[token]),
        temporary: !config?.tokenEmails?.[token],
        identityStatus: config?.tokenEmails?.[token] ? "legacy" : "unknown",
      }
    );
  }

  function markAccountUsed(token) {
    if (!token) return;
    if (!config.tokenAccounts) config.tokenAccounts = {};
    const account = accountForToken(token);
    config.tokenAccounts[token] = {
      ...account,
      lastUsedAt: new Date().toISOString(),
    };
    if (
      !markAccountUsed.lastPersistAt ||
      Date.now() - markAccountUsed.lastPersistAt > 120000
    ) {
      markAccountUsed.lastPersistAt = Date.now();
      saveConfig(config);
    }
  }

  function accountCheckInfo(token) {
    const account = accountForToken(token);
    const sessionQuota = tokenPool ? tokenPool.getUsageForToken(token) : null;
    return {
      last_used_at: account.lastUsedAt || null,
      last_account_check_at: account.lastAccountCheckAt || null,
      last_account_check_status: account.lastAccountCheckStatus || "never",
      last_account_check_error: account.lastAccountCheckError || null,
      quota: mergeQuotaSources(account.quota, sessionQuota),
    };
  }

  function normalizeMultimodalContent(content) {
    if (!Array.isArray(content)) return content;
    return content.map((part) => {
      if (!part || typeof part !== "object") return part;
      if (part.type === "image" && part.source) {
        const source = part.source;
        if (source.type === "base64" && source.media_type && source.data)
          return {
            type: "image_url",
            image_url: {
              url: `data:${source.media_type};base64,${source.data}`,
            },
          };
        if (source.type === "url" && source.url)
          return { type: "image_url", image_url: { url: source.url } };
      }
      if (
        part.type === "image_url" ||
        part.type === "video_url" ||
        part.type === "text"
      )
        return part;
      return part;
    });
  }

  function extractQuota(state) {
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
  }

  function mergeQuotaSources(primary, fallback) {
    if (!primary && !fallback) return null;
    const merged = { ...(fallback || {}), ...(primary || {}) };
    const primaryModels = primary?.rateLimitsByModel;
    const fallbackModels = fallback?.rateLimitsByModel;
    if (primaryModels || fallbackModels) {
      merged.rateLimitsByModel = {
        ...(fallbackModels || {}),
        ...(primaryModels || {}),
      };
    }
    return merged;
  }

  function removeTokenMetadata(token) {
    if (config.tokenEmails) delete config.tokenEmails[token];
    if (config.tokenAccounts) delete config.tokenAccounts[token];
  }

  async function resolveAndReconcileToken(token, hint = {}, client = null) {
    if (!token) return { token, changed: false, identity: null };
    if (!config.tokenAccounts) config.tokenAccounts = {};
    if (!config.tokenEmails) config.tokenEmails = {};
    const current = accountForToken(token);
    let identity;
    if (hint.accountId || hint.email) {
      identity = {
        status: "resolved",
        accountId: hint.accountId ? String(hint.accountId) : null,
        email: normalizeEmail(hint.email),
        endpoint: hint.source || "credential",
      };
    } else {
      try {
        identity = client
          ? await client.getAccountIdentity(token)
          : { status: "pending", error: "identity lookup unavailable" };
      } catch (e) {
        identity = { status: "pending", error: e.message };
      }
    }
    const resolved = identity.status === "resolved";
    const accountId = resolved
      ? accountIdentityKey(identity, token)
      : accountIdentityKey({}, token);
    const duplicate = resolved
      ? config.authTokens.find((other) => {
          if (other === token) return false;
          const metadata = accountForToken(other);
          return (
            metadata.accountId === accountId ||
            (identity.email &&
              normalizeEmail(metadata.email) === identity.email)
          );
        })
      : null;

    if (duplicate) {
      if (tokenPool) await tokenPool.endAllSessionsForToken(duplicate);
      config.authTokens = config.authTokens.filter(
        (value) => value !== duplicate,
      );
      removeTokenMetadata(duplicate);
      logInfo(
        `[Account] Replaced old token ${duplicate.substring(0, 8)}... with newer credential for ${identity.email || accountId}`,
      );
    }
    config.authTokens = [
      ...new Set([
        ...config.authTokens.filter((value) => value !== token),
        token,
      ]),
    ];
    config.tokenAccounts[token] = {
      accountId,
      email: resolved
        ? identity.email || current.email || null
        : current.email || null,
      temporary: !resolved,
      identityStatus: identity.status,
      identityCheckedAt: new Date().toISOString(),
      identityEndpoint: identity.endpoint || null,
      identityError: identity.error || null,
      source: hint.source || current.source || "config",
    };
    if (config.tokenAccounts[token].email)
      config.tokenEmails[token] = config.tokenAccounts[token].email;
    return {
      token,
      changed: Boolean(duplicate),
      identity: config.tokenAccounts[token],
      replaced: duplicate || null,
    };
  }

  async function reconcileAllTokenAccounts(entries = [], client = null) {
    const hints = new Map(
      entries
        .filter((entry) => entry && entry.token)
        .map((entry) => [entry.token, entry]),
    );
    const replacements = [];
    for (const token of [...new Set(config.authTokens || [])]) {
      if (!config.authTokens.includes(token)) continue;
      const result = await resolveAndReconcileToken(
        token,
        hints.get(token) || {},
        client,
      );
      if (result.replaced) replacements.push(result.replaced);
    }
    saveConfig(config);
    return replacements;
  }

  async function checkIdleAccounts() {
    if (checkIdleAccounts.running) return;
    checkIdleAccounts.running = true;
    try {
      if (!tokenPool || !config.authTokens?.length) return;
      const now = Date.now();
      const client = tokenPool.client;
      let changed = false;
      for (const token of tokenPool.tokens) {
        const account = accountForToken(token);
        const lastUsed = account.lastUsedAt
          ? new Date(account.lastUsedAt).getTime()
          : 0;
        const lastChecked = account.lastAccountCheckAt
          ? new Date(account.lastAccountCheckAt).getTime()
          : 0;
        if (lastChecked && now - lastChecked < 12000) continue;
        if (lastUsed && now - lastUsed < 12000) continue;
        const checkedAt = new Date().toISOString();
        const maskedToken = `${token.substring(0, 8)}...${token.substring(token.length - 4)}`;
        const accountLabel = account.email || account.accountId || maskedToken;
        logInfo(`[Account Check] Starting ${accountLabel} (${maskedToken})`);
        try {
          const identity = await client.getAccountIdentity(token);
          let quota = null;
          const activeSession = tokenPool.getSessionForToken(token);
          if (activeSession?.instanceID) {
            logInfo(
              `[Account Check] ${accountLabel}: refreshing existing session`,
            );
            const state = await client.getSession(
              token,
              activeSession.instanceID,
            );
            quota = extractQuota(state);
            logInfo(
              `[Account Check] ${accountLabel}: session response status=${state?.status || "none"}, keys=${Object.keys(state || {}).join(",")}, quota_keys=${quota ? Object.keys(quota).join(",") : "none"}`,
            );
            if (quota)
              tokenPool.updateTokenUsage(
                token,
                activeSession.model || quota.model,
                quota,
              );
            if (!quota) {
              const probeModel =
                activeSession.model || tokenPool.lockedModels.get(token) || "";
              logInfo(
                `[Account Check] ${accountLabel}: session had no quota, forcing probe${probeModel ? ` for ${probeModel}` : ""}`,
              );
              const probeState = await client.createSession(token, probeModel);
              quota = extractQuota(probeState);
              logInfo(
                `[Account Check] ${accountLabel}: forced probe status=${probeState?.status || "none"}, keys=${Object.keys(probeState || {}).join(",")}, quota_keys=${quota ? Object.keys(quota).join(",") : "none"}`,
              );
              if (probeState?.instanceId) {
                const session = tokenPool._sessionFromState(probeState);
                session.model = probeState.model || probeModel || session.model;
                tokenPool.sessions.set(
                  tokenPool.sessionKey(token, session.model),
                  session,
                );
              }
              if (quota)
                tokenPool.updateTokenUsage(
                  token,
                  probeModel || quota.model,
                  quota,
                );
            }
          } else {
            // Explicitly probe accounts without a local session and retain the result.
            logInfo(
              `[Account Check] ${accountLabel}: probing upstream session quota`,
            );
            const state = await client.createSession(token);
            const model =
              state?.model || state?.rateLimit?.model || "__account__";
            if (state?.instanceId) {
              const session = tokenPool._sessionFromState(state);
              session.model = model;
              tokenPool.sessions.set(
                tokenPool.sessionKey(token, model),
                session,
              );
              if (state.status === "active")
                tokenPool.lockedModels.delete(token);
            }
            quota = extractQuota(state);
            logDebug(
              `[Account Check] ${accountLabel}: probe response keys=${Object.keys(state || {}).join(",")}, quota_keys=${quota ? Object.keys(quota).join(",") : "none"}`,
            );
            if (quota) tokenPool.updateTokenUsage(token, model, quota);
          }
          if (!quota) quota = tokenPool.getUsageForToken(token);
          if (quota) {
            const remaining = Math.max(
              0,
              Number(quota.limit) - Number(quota.recentCount),
            );
            const status =
              Number(quota.limit) > 0 &&
              Number(quota.recentCount) >= Number(quota.limit)
                ? "rate_limited"
                : "usable";
            logInfo(
              `[Account Check] ${accountLabel}: ${status}, ${remaining}/${quota.limit} requests remaining${quota.resetAt ? `, reset ${quota.resetAt}` : ""}`,
            );
          } else {
            logWarn(
              `[Account Check] ${accountLabel}: upstream returned no quota data`,
            );
          }
          config.tokenAccounts[token] = {
            ...account,
            ...(identity.status === "resolved"
              ? {
                  accountId: accountIdentityKey(identity, token),
                  email: identity.email || account.email || null,
                  temporary: false,
                  identityStatus: "resolved",
                  identityEndpoint:
                    identity.endpoint || account.identityEndpoint || null,
                }
              : {}),
            lastAccountCheckAt: checkedAt,
            lastAccountCheckStatus: quota
              ? Number(quota.limit) > 0 &&
                Number(quota.recentCount) >= Number(quota.limit)
                ? "rate_limited"
                : "quota_checked"
              : "quota_unavailable",
            lastAccountCheckError: quota
              ? null
              : identity.error || "Upstream returned no quota data",
            quota: quota
              ? {
                  model: quota.model || null,
                  limit: Number(quota.limit) || 0,
                  recentCount: Number(quota.recentCount) || 0,
                  resetAt: quota.resetAt || null,
                  period: quota.period || null,
                  entitlement: quota.entitlement || null,
                  rateLimitsByModel: quota.rateLimitsByModel || null,
                  checkedAt,
                }
              : account.quota || null,
          };
          if (config.tokenAccounts[token].email)
            config.tokenEmails[token] = config.tokenAccounts[token].email;
          changed = true;
        } catch (e) {
          tokenPool.updateTokenUsageFromError(token, null, e);
          const quota =
            tokenPool.getUsageForToken(token) || account.quota || null;
          logDebug(
            `[Account Check] ${accountLabel}: error response retained quota=${quota ? `${quota.recentCount}/${quota.limit}` : "none"}`,
          );
          if (quota) {
            const remaining = Math.max(
              0,
              Number(quota.limit) - Number(quota.recentCount),
            );
            logWarn(
              `[Account Check] ${accountLabel}: rate-limited, ${remaining}/${quota.limit} requests remaining${quota.resetAt ? `, reset ${quota.resetAt}` : ""}`,
            );
          } else {
            logError(`[Account Check] ${accountLabel}: failed: ${e.message}`);
          }
          config.tokenAccounts[token] = {
            ...account,
            lastAccountCheckAt: checkedAt,
            lastAccountCheckStatus: quota
              ? Number(quota.limit) > 0 &&
                Number(quota.recentCount) >= Number(quota.limit)
                ? "rate_limited"
                : "quota_checked"
              : "error",
            lastAccountCheckError: quota ? null : e.message,
            quota: quota ? { ...quota, checkedAt } : account.quota || null,
          };
          changed = true;
        }
      }
      if (changed) saveConfig(config);
    } finally {
      checkIdleAccounts.running = false;
    }
  }

  function quotaSummary(quota) {
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
  }

  // quotaSummary remains available to account consumers through the manager.

  return {
    tokenFingerprint,
    normalizeEmail,
    accountIdentityKey,
    accountForToken,
    markAccountUsed,
    accountCheckInfo,
    normalizeMultimodalContent,
    extractQuota,
    mergeQuotaSources,
    removeTokenMetadata,
    resolveAndReconcileToken,
    reconcileAllTokenAccounts,
    checkIdleAccounts,
  };
}

module.exports = { createAccountManager };
