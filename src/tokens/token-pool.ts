function createTokenPool(deps) {
  const {
    loadState,
    saveState,
    extractQuota,
    quotaSummary,
    logDebug,
    logInfo,
    logWarn,
    logError,
    pushEvent,
  } = deps;
  const crypto = deps.crypto || require("crypto");
  class TokenPool {
    constructor(tokens, cfg, client) {
      this.tokens = tokens;
      this.cfg = cfg;
      this.client = client;
      this.currentIndex = 0;
      this.sessions = new Map();
      this.lockedModels = new Map();
      this.mutex = Promise.resolve();
      this.tokenHealth = new Map();
      this.tokenUsage = new Map();

      // Load persisted state
      const state = loadState();
      if (state.lockedModels) {
        for (const [token, model] of Object.entries(state.lockedModels)) {
          if (tokens.includes(token)) this.lockedModels.set(token, model);
        }
      }
      if (state.tokenHealth) {
        for (const [token, health] of Object.entries(state.tokenHealth)) {
          if (tokens.includes(token)) this.tokenHealth.set(token, health);
        }
      }
      if (state.sessions) {
        for (const [key, session] of Object.entries(state.sessions)) {
          const token = key.split(":")[0];
          if (tokens.includes(token)) {
            session.expiresAt = session.expiresAt
              ? new Date(session.expiresAt)
              : null;
            this.sessions.set(key, session);
            if (session.rateLimit)
              this.updateTokenUsage(
                token,
                session.model || key.substring(token.length + 1),
                session.rateLimit,
              );
          }
        }
      }

      for (const token of tokens) {
        if (!this.tokenHealth.has(token)) {
          this.tokenHealth.set(token, {
            status: "unknown",
            error: null,
            checkedAt: null,
          });
        }
      }

      const restoredSessions = this.sessions.size;
      const restoredLocks = this.lockedModels.size;
      const restoredHealth = [...this.tokenHealth.values()].filter(
        (h) => h.status !== "unknown",
      ).length;
      if (restoredSessions || restoredLocks || restoredHealth) {
        logInfo(
          `[State] Restored: ${restoredSessions} session(s), ${restoredLocks} lock(s), ${restoredHealth} health record(s)`,
        );
      }

      // Periodic state save
      this._stateSaveTimer = setInterval(() => this.persistState(), 30_000);
    }

    persistState() {
      const state = { sessions: {}, lockedModels: {}, tokenHealth: {} };
      for (const [key, session] of this.sessions.entries()) {
        state.sessions[key] = {
          ...session,
          expiresAt: session.expiresAt ? session.expiresAt.toISOString() : null,
        };
      }
      for (const [token, model] of this.lockedModels.entries()) {
        state.lockedModels[token] = model;
      }
      for (const [token, health] of this.tokenHealth.entries()) {
        state.tokenHealth[token] = health;
      }
      saveState(state);
    }

    async withLock(fn) {
      let release;
      const p = new Promise((r) => (release = r));
      const old = this.mutex;
      this.mutex = p;
      await old;
      try {
        return await fn();
      } finally {
        release();
      }
    }

    getToken(model = null, excluded = new Set()) {
      if (this.tokens.length === 0) return null;
      const start = this.currentIndex % this.tokens.length;
      const scored = this.tokens
        .map((token, offset) => {
          const health = this.tokenHealth.get(token) || { status: "unknown" };
          if (
            excluded.has(token) ||
            health.status === "banned" ||
            health.status === "unauthorized"
          )
            return null;
          const usage = this.getUsageForToken(token, model);
          if (usage && usage.limit > 0 && usage.recentCount >= usage.limit)
            return null;
          const remaining =
            usage && usage.limit > 0 ? usage.limit - usage.recentCount : null;
          const distance = (offset + start) % this.tokens.length;
          return { token, remaining, distance };
        })
        .filter(Boolean)
        .sort((a, b) => {
          if (a.remaining === null && b.remaining !== null) return 1;
          if (a.remaining !== null && b.remaining === null) return -1;
          return (
            (b.remaining || 0) - (a.remaining || 0) || a.distance - b.distance
          );
        });
      if (scored.length === 0) return null;
      const selectedIndex = this.tokens.indexOf(scored[0].token);
      this.currentIndex = (selectedIndex + 1) % this.tokens.length;
      return scored[0].token;
    }

    dispose() {
      if (this._stateSaveTimer) clearInterval(this._stateSaveTimer);
    }

    sessionKey(token, model) {
      return `${token}:${model}`;
    }

    _sessionFromState(state) {
      const instanceID = (state.instanceId || "").trim();
      const expiresAt = state.expiresAt ? new Date(state.expiresAt) : null;
      const countryCode = state.countryCode || null;
      const remainingMs = state.remainingMs || null;
      const accessTier = state.accessTier || null;
      const countryBlockReason = state.countryBlockReason || null;
      const model = state.model || null;
      const rl = extractQuota(state);
      const rateLimit = rl
        ? {
            model: rl.model || null,
            entitlement: rl.entitlement || null,
            limit: rl.limit || 0,
            period: rl.period || null,
            resetAt: rl.resetAt || null,
            windowHours: rl.windowHours || 0,
            recentCount: rl.recentCount || 0,
            rateLimitsByModel: rl.rateLimitsByModel || null,
          }
        : null;
      return {
        status: "active",
        instanceID,
        expiresAt,
        countryCode,
        remainingMs,
        accessTier,
        countryBlockReason,
        model,
        rateLimit,
        rateLimitUpdatedAt: rateLimit ? Date.now() : null,
      };
    }

    getUsageForToken(token, model = null) {
      const direct = model ? this.tokenUsage.get(`${token}:${model}`) : null;
      if (direct) return direct;
      const candidates = [];
      for (const [key, session] of this.sessions.entries()) {
        if (!key.startsWith(token + ":") || !session.rateLimit) continue;
        if (
          !model ||
          session.model === model ||
          key === this.sessionKey(token, model)
        )
          candidates.push(session);
      }
      if (candidates.length === 0) {
        const stored = [...this.tokenUsage.entries()]
          .filter(
            ([key]) =>
              key.startsWith(token + ":") &&
              (!model || key === `${token}:${model}`),
          )
          .map(([, usage]) => usage)
          .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        return stored[0] || null;
      }
      return candidates.sort(
        (a, b) => (b.rateLimitUpdatedAt || 0) - (a.rateLimitUpdatedAt || 0),
      )[0].rateLimit;
    }

    isQuotaFull(token, model = null) {
      const usage = this.getUsageForToken(token, model);
      return !!(usage && usage.limit > 0 && usage.recentCount >= usage.limit);
    }

    getEffectiveTokenStatus(token, model = null) {
      const health = this.tokenHealth.get(token) || {
        status: "unknown",
        error: null,
        checkedAt: null,
      };
      if (health.status === "banned" || health.status === "unauthorized")
        return health.status;
      return this.isQuotaFull(token, model) ? "rate_limited" : health.status;
    }

    updateTokenUsage(token, model, rateLimit) {
      if (!token || !rateLimit) return;
      const normalized = {
        model: rateLimit.model || model || null,
        entitlement: rateLimit.entitlement || null,
        limit: Number(rateLimit.limit) || 0,
        period: rateLimit.period || null,
        resetAt: rateLimit.resetAt || null,
        windowHours: Number(rateLimit.windowHours) || 0,
        recentCount: Number(rateLimit.recentCount) || 0,
        rateLimitsByModel: rateLimit.rateLimitsByModel || null,
        updatedAt: Date.now(),
      };
      this.tokenUsage.set(
        `${token}:${model || normalized.model || ""}`,
        normalized,
      );
      for (const [key, session] of this.sessions.entries()) {
        if (
          key.startsWith(token + ":") &&
          (!model || session.model === model)
        ) {
          session.rateLimit = normalized;
          session.rateLimitUpdatedAt = normalized.updatedAt;
        }
      }
    }

    async refreshQuota(client) {
      for (const token of this.tokens) {
        const sessions = [...this.sessions.entries()]
          .filter(
            ([key, s]) =>
              key.startsWith(token + ":") &&
              s.instanceID &&
              s.status === "active",
          )
          .map(([key, s]) => ({ model: key.split(":")[1], ...s }));
        for (const session of sessions) {
          try {
            const state = await client.getSession(token, session.instanceID);
            const quota = extractQuota(state);
            if (quota) this.updateTokenUsage(token, session.model, quota);
          } catch (e) {
            logDebug(
              `[Quota] getSession failed for ${token.substring(0, 8)}...: ${e.message}`,
            );
          }
        }
      }
    }

    updateTokenUsageFromError(token, model, error) {
      const message = error?.message || String(error);
      const match = message.match(/\{[\s\S]*\}$/);
      if (!match) return null;
      try {
        const data = JSON.parse(match[0]);
        if (
          data.limit !== undefined ||
          data.recentCount !== undefined ||
          data.status === "rate_limited"
        ) {
          this.updateTokenUsage(token, model, data);
          this.setTokenHealth(token, {
            status:
              data.status === "rate_limited" ||
              Number(data.recentCount) >= Number(data.limit)
                ? "rate_limited"
                : "active",
            error: message,
            checkedAt: new Date().toISOString(),
          });
          return data;
        }
      } catch (_) {}
      return null;
    }

    async ensureSession(token, model) {
      const requestedModel = model;
      const locked = await this.withLock(async () =>
        this.lockedModels.get(token),
      );
      if (locked && locked !== requestedModel) {
        logInfo(
          `${token.substring(0, 8)}...: request for ${requestedModel} differs from cached lock ${locked}, ending session to unlock`,
        );
        pushEvent("model_switch", `Ending session to unlock`, {
          from: locked,
          to: requestedModel,
          reason: "model_mismatch_unlock",
          token: token.substring(0, 8) + "...",
        });
        await this.endAllSessionsForToken(token);
        try {
          await this.client.endSession(token);
        } catch (e2) {
          logError(`endSession(no-id) failed: ${e2.message}`);
        }
        await this.withLock(async () => {
          this.lockedModels.delete(token);
        });
        this.persistState();
        await new Promise((r) => setTimeout(r, 500));
      }
      let key = this.sessionKey(token, model);
      for (let i = 0; i < 3; i++) {
        const ready = await this.withLock(async () => {
          const session = this.sessions.get(key);
          if (!session) return { ready: false };
          if (session.status === "active" && session.instanceID) {
            if (
              !session.expiresAt ||
              Date.now() < session.expiresAt.getTime() - 5000
            ) {
              if (this.isQuotaFull(token, model)) {
                throw new Error(
                  `free session request failed 429: ${JSON.stringify(this.getUsageForToken(token, model))}`,
                );
              }
              return {
                ready: true,
                instanceID: session.instanceID,
                model: session.model || model,
                accessTier: session.accessTier,
              };
            }
          }
          return { ready: false };
        });
        if (ready.ready)
          return {
            instanceID: ready.instanceID,
            model: ready.model,
            accessTier: ready.accessTier,
          };

        try {
          let state;
          const current = await this.withLock(async () =>
            this.sessions.get(key),
          );
          if (current && current.status === "active" && current.instanceID) {
            try {
              state = await this.client.getSession(token, current.instanceID);
            } catch (e) {
              if (e.message === "freebuff_update_required") throw e;
              state = await this.client.createSession(token, model);
            }
          } else {
            state = await this.client.createSession(token, model);
          }
          state = await this.pollUntilReady(token, model, state);
          logDebug(
            `ensureSession: pollUntilReady result: status=${state.status}, instanceId=${state.instanceId}, countryBlockReason=${state.countryBlockReason || "none"}, accessTier=${state.accessTier || "none"}`,
          );

          const instanceID = (state.instanceId || "").trim();
          if (!instanceID)
            throw new Error("free session active response missing instanceId");
          const session = this._sessionFromState(state);
          this.updateTokenUsage(token, model, session.rateLimit);
          const rl = extractQuota(state);
          if (rl && rl.rateLimitsByModel && rl.recentCount >= rl.limit) {
            const reqModelCount = rl.rateLimitsByModel[requestedModel];
            if (
              !reqModelCount ||
              reqModelCount.recentCount >= reqModelCount.limit
            ) {
              const available = Object.entries(rl.rateLimitsByModel)
                .filter(([m, d]) => d.recentCount < d.limit)
                .map(([m]) => m);
              if (available.length > 0 && !available.includes(requestedModel)) {
                logInfo(
                  `${key.substring(0, 20)}...: model ${requestedModel} at quota, falling back to ${available[0]}`,
                );
                pushEvent(
                  "model_switch",
                  `Model ${requestedModel} at quota, falling back`,
                  {
                    from: requestedModel,
                    to: available[0],
                    reason: "quota_fallback",
                    token: token.substring(0, 8) + "...",
                  },
                );
                await this.endAllSessionsForToken(token);
                try {
                  await this.client.endSession(token);
                } catch (_) {}
                model = available[0];
                key = this.sessionKey(token, model);
                state = await this.client.createSession(token, model);
                state = await this.pollUntilReady(token, model, state);
                const newInstanceID = (state.instanceId || "").trim();
                if (!newInstanceID)
                  throw new Error("free session fallback missing instanceId");
                Object.assign(session, this._sessionFromState(state));
                this.updateTokenUsage(token, model, session.rateLimit);
              }
            }
          }
          const boundModel = session.model;
          let returnModel = model;
          if (boundModel && boundModel !== requestedModel) {
            logInfo(
              `${key.substring(0, 20)}...: server bound session to ${boundModel} (requested ${requestedModel}), accepting bound model`,
            );
            pushEvent("model_switch", `Server bound session to ${boundModel}`, {
              from: requestedModel,
              to: boundModel,
              reason: "session_created_with_different_model",
              token: token.substring(0, 8) + "...",
            });
            await this.withLock(async () => {
              this.lockedModels.set(token, boundModel);
            });
            const boundKey = this.sessionKey(token, boundModel);
            await this.withLock(async () => {
              this.sessions.delete(key);
              this.sessions.set(boundKey, session);
            });
            this.persistState();
            returnModel = boundModel;
          } else {
            await this.withLock(async () => {
              this.sessions.set(key, session);
            });
            this.persistState();
          }
          logDebug(
            `ensureSession: returning instanceID=${instanceID} model=${returnModel} accessTier=${session.accessTier}`,
          );
          return {
            instanceID,
            model: returnModel,
            accessTier: session.accessTier,
          };
        } catch (e) {
          const errorMsg = e.message || "";
          if (errorMsg.includes("model_locked")) {
            let lockedModel = null;
            try {
              const parsed = JSON.parse(errorMsg);
              if (
                parsed.type === "model_locked" &&
                parsed.body &&
                parsed.body.currentModel
              )
                lockedModel = parsed.body.currentModel;
            } catch (_) {}
            if (lockedModel) {
              logInfo(
                `${key.substring(0, 20)}...: server locked to ${lockedModel}, switching to locked model`,
              );
              pushEvent("model_switch", `Server locked to ${lockedModel}`, {
                from: model,
                to: lockedModel,
                reason: "model_locked",
                token: token.substring(0, 8) + "...",
              });
              await this.endAllSessionsForToken(token);
              try {
                await this.client.endSession(token);
              } catch (_) {}
              try {
                const lockedState = await this.client.createSession(
                  token,
                  lockedModel,
                );
                const polled = await this.pollUntilReady(
                  token,
                  lockedModel,
                  lockedState,
                );
                const instanceID = (polled.instanceId || "").trim();
                if (instanceID) {
                  const newKey = this.sessionKey(token, lockedModel);
                  const session = this._sessionFromState(polled);
                  this.updateTokenUsage(token, lockedModel, session.rateLimit);
                  await this.withLock(async () => {
                    this.sessions.delete(key);
                    this.lockedModels.set(token, lockedModel);
                    this.sessions.set(newKey, session);
                  });
                  this.persistState();
                  logDebug(
                    `ensureSession: switched to locked model ${lockedModel} instanceID=${instanceID}`,
                  );
                  return {
                    instanceID,
                    model: lockedModel,
                    accessTier: session.accessTier,
                  };
                }
              } catch (switchErr) {
                logError(
                  `${key.substring(0, 20)}...: failed to switch to locked model ${lockedModel} (${switchErr.message}), retrying`,
                );
              }
              const newKey = this.sessionKey(token, lockedModel);
              await this.withLock(async () => {
                this.sessions.delete(key);
                this.lockedModels.set(token, lockedModel);
              });
              this.persistState();
              model = lockedModel;
              key = newKey;
              continue;
            }
            logInfo(
              `${key.substring(0, 20)}...: session locked to different model, ending all upstream sessions`,
            );
            await this.endAllSessionsForToken(token);
            try {
              await this.client.endSession(token);
            } catch (e2) {
              logError(`endSession(no-id) failed: ${e2.message}`);
            }
            await new Promise((r) => setTimeout(r, 500));
            continue;
          }
          if (errorMsg === "freebuff_update_required") {
            logInfo(
              `${key.substring(0, 20)}...: freebuff_update_required, clearing session and retrying`,
            );
            await this.endAllSessionsForToken(token);
            try {
              await this.client.endSession(token);
            } catch (e2) {
              logError(`endSession(no-id) failed: ${e2.message}`);
            }
            continue;
          }
          await this.withLock(async () => {
            this.sessions.delete(key);
          });
          this.persistState();
          logError(`${key.substring(0, 20)}...: session error: ${e.message}`);
          pushEvent("error", `Session error: ${e.message}`, {
            detail: e.message,
            model,
            token: token.substring(0, 8) + "...",
          });

          if (errorMsg.includes("403") && errorMsg.includes("banned")) {
            this.setTokenHealth(token, {
              valid: false,
              status: "banned",
              error: e.message,
              checkedAt: new Date().toISOString(),
            });
            break;
          }

          if (errorMsg.includes("429") || errorMsg.includes("rate_limited")) {
            this.updateTokenUsageFromError(token, model, e);
            throw e;
          }

          if (i === 2) throw e;
        }
      }
    }

    async getLockedModel(token) {
      return await this.withLock(
        async () => this.lockedModels.get(token) || null,
      );
    }

    async setLockedModel(token, model) {
      await this.withLock(async () => {
        this.lockedModels.set(token, model);
      });
      this.persistState();
    }

    async clearLockedModel(token) {
      const result = await this.withLock(async () => {
        const locked = this.lockedModels.get(token) || null;
        this.lockedModels.delete(token);
        return locked;
      });
      if (result) {
        await this.endAllSessionsForToken(token);
        try {
          await this.client.endSession(token);
        } catch (e) {
          logError(`endSession(no-id) failed: ${e.message}`);
        }
      }
      this.persistState();
      return result;
    }

    async clearAllLockedModels() {
      const all = [];
      const tokens = this.tokens.slice();
      for (const token of tokens) {
        const locked = await this.withLock(async () => {
          const m = this.lockedModels.get(token) || null;
          this.lockedModels.delete(token);
          return m;
        });
        if (locked) all.push({ token, lockedModel: locked });
      }
      for (const { token } of all) {
        await this.endAllSessionsForToken(token);
        try {
          await this.client.endSession(token);
        } catch (e) {
          logError(`endSession(no-id) failed: ${e.message}`);
        }
      }
      this.persistState();
      return all;
    }

    async endAllSessionsForToken(token) {
      const keysToDelete = [];
      await this.withLock(async () => {
        for (const key of this.sessions.keys()) {
          if (key.startsWith(token + ":")) {
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
            logError(
              `Failed to end session ${session.instanceID}: ${e.message}`,
            );
          }
        }
        await this.withLock(async () => {
          this.sessions.delete(key);
        });
      }
      this.persistState();
    }

    async pollUntilReady(token, model, state) {
      for (let i = 0; i < 60; i++) {
        const status = (state.status || "").trim();
        if (status === "active") return state;
        if (status === "queued") {
          const instanceID = (state.instanceId || "").trim();
          if (!instanceID)
            throw new Error("free session queued response missing instanceId");
          const estimatedWaitMs = state.estimatedWaitMs || 0;
          const delay =
            estimatedWaitMs > 0
              ? Math.min(Math.max(estimatedWaitMs, 250), 2000)
              : 250;
          logInfo(
            `Waiting room: position ${state.position || "?"}/${state.queueDepth || "?"}${estimatedWaitMs > 0 ? `, ~${Math.ceil(estimatedWaitMs / 1000)}s` : ""}`,
          );
          await new Promise((r) => setTimeout(r, delay));
          state = await this.client.getSession(token, instanceID);
        } else if (
          status === "ended" ||
          status === "superseded" ||
          status === "none"
        ) {
          state = await this.client.createSession(token, model);
        } else if (status === "disabled") {
          return state;
        } else {
          throw new Error(`unexpected free session status: ${status}`);
        }
      }
      throw new Error("free session poll timeout");
    }

    invalidateSession(token, model) {
      const key = this.sessionKey(token, model);
      this.withLock(async () => {
        this.sessions.delete(key);
      }).then(() => this.persistState());
    }

    invalidateAllSessionsForToken(token) {
      this.withLock(async () => {
        for (const key of this.sessions.keys()) {
          if (key.startsWith(token + ":")) this.sessions.delete(key);
        }
      }).then(() => this.persistState());
    }

    getTokenHealth(token) {
      return (
        this.tokenHealth.get(token) || {
          status: "unknown",
          error: null,
          checkedAt: null,
        }
      );
    }

    setTokenHealth(token, result) {
      this.tokenHealth.set(token, {
        status: result.status || "unknown",
        error: result.error || null,
        checkedAt: result.checkedAt || new Date().toISOString(),
      });
      this.persistState();
    }

    getAllTokenHealth() {
      const map = {};
      for (const [token, health] of this.tokenHealth.entries()) {
        map[token] = health;
      }
      return map;
    }

    hasUsableTokens() {
      for (const token of this.tokens) {
        const health = this.tokenHealth.get(token) || { status: "unknown" };
        if (health.status !== "banned" && health.status !== "unauthorized") {
          return true;
        }
      }
      return false;
    }

    getSessionForToken(token, model = null) {
      let fallback = null;
      for (const [key, session] of this.sessions.entries()) {
        if (!key.startsWith(token + ":") || session.status !== "active")
          continue;
        if (
          model &&
          (session.model === model || key === this.sessionKey(token, model))
        )
          return session;
        fallback = fallback || session;
      }
      return fallback;
    }

    hasUsableTokensForModel(model) {
      for (const token of this.tokens) {
        const health = this.tokenHealth.get(token) || { status: "unknown" };
        if (
          health.status !== "banned" &&
          health.status !== "unauthorized" &&
          !this.isQuotaFull(token, model)
        )
          return true;
      }
      return false;
    }

    getAggregatedUsage() {
      let totalUsed = 0;
      let totalLimit = 0;
      let earliestReset = null;
      let windowHours = 24;
      for (const token of this.tokens) {
        const session = this.getSessionForToken(token);
        if (session && session.rateLimit) {
          const quota = quotaSummary(session.rateLimit);
          totalUsed += quota.used;
          totalLimit += quota.limit;
          if (quota.resetAt) {
            const resetTime = new Date(quota.resetAt).getTime();
            if (!earliestReset || resetTime < earliestReset)
              earliestReset = resetTime;
          }
          if (session.rateLimit.windowHours)
            windowHours = Math.min(windowHours, session.rateLimit.windowHours);
        }
      }
      const remaining = totalLimit - totalUsed;
      const burnRate =
        windowHours > 0 && totalUsed > 0 ? totalUsed / windowHours : 0;
      const estimatedDepletionMinutes =
        burnRate > 0 && remaining > 0
          ? Math.round((remaining / burnRate) * 60)
          : null;
      return {
        used: totalUsed,
        limit: totalLimit,
        remaining,
        nextResetAt: earliestReset
          ? new Date(earliestReset).toISOString()
          : null,
        burnRate: Math.round(burnRate * 100) / 100,
        estimatedDepletionMinutes,
      };
    }
  }
  return TokenPool;
}

module.exports = { createTokenPool };
