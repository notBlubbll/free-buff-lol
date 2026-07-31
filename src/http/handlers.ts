function createHttpHandlers(deps) {
  const {
    getConfig,
    getTokenPool,
    getModelRegistry,
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
    proxyChatRequest,
    setupOpencodeConfig,
    saveConfig,
    reloadTokenPool,
    probeNewModels,
    resolveAndReconcileToken,
    UpstreamClient,
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
    accountForToken,
    accountCheckInfo,
    mergeQuotaSources,
    errorWriters,
    requestUtilities,
    responseWriters,
    anthropicRequests,
    IS_BUN,
    RUNTIME_VERSION,
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
  const modelRegistry = new Proxy(
    {},
    {
      get: (_, key) => {
        const value = getModelRegistry()?.[key];
        return typeof value === "function"
          ? value.bind(getModelRegistry())
          : value;
      },
    },
  );
  // --- HTTP Handlers ---
  function authorized(req) {
    if (!config.apiKeys || config.apiKeys.length === 0) return true;
    const xApiKey = (req.headers["x-api-key"] || "").trim();
    if (xApiKey && config.apiKeys.includes(xApiKey)) return true;
    const authorization = (req.headers["authorization"] || "").trim();
    if (!authorization.startsWith("Bearer ")) return false;
    return config.apiKeys.includes(authorization.substring(7).trim());
  }

  function isClaudeRequestPath(pathname) {
    return pathname.startsWith("/v1/messages");
  }

  function writeJSON(res, statusCode, payload) {
    return errorWriters.writeJSON(res, statusCode, payload);
  }

  function writeOpenAIError(res, statusCode, message, errorType, code) {
    return errorWriters.writeOpenAIError(
      res,
      statusCode,
      message,
      errorType,
      code,
    );
  }

  function writeClaudeError(res, statusCode, message, errorType) {
    return errorWriters.writeClaudeError(res, statusCode, message, errorType);
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });
  }

  async function handleHealthz(req, res) {
    if (req.method !== "GET") {
      writeOpenAIError(
        res,
        405,
        "method not allowed",
        "invalid_request_error",
        "",
      );
      return;
    }
    const tokenState = tokenPool.tokens.map((token, idx) => {
      const maskedToken =
        token.substring(0, 8) + "..." + token.substring(token.length - 4);
      const allSessions = [];
      for (const [key, session] of tokenPool.sessions.entries()) {
        if (key.startsWith(token + ":")) allSessions.push(session);
      }
      const bestSession =
        allSessions.find((s) => s.status === "active") ||
        allSessions[0] ||
        null;
      const lockedModel = tokenPool.lockedModels.get(token) || null;
      const health = tokenPool.getTokenHealth(token);
      const rl = bestSession?.rateLimit || tokenPool.getUsageForToken(token);
      const mergedQuota = mergeQuotaSources(accountForToken(token).quota, rl);
      const effectiveStatus = tokenPool.getEffectiveTokenStatus(
        token,
        rl?.model || null,
      );
      return {
        name: `token-${idx + 1}`,
        token: maskedToken,
        email: config.tokenEmails?.[token] || null,
        account_id: accountForToken(token).accountId,
        temporary_account: Boolean(accountForToken(token).temporary),
        ...accountCheckInfo(token),
        health_status: effectiveStatus,
        health_error: health.error,
        health_checked_at: health.checkedAt,
        session_status:
          effectiveStatus === "rate_limited"
            ? "rate_limited"
            : bestSession?.status || "none",
        session_instance_id: bestSession?.instanceID || null,
        session_expires_at: bestSession?.expiresAt || null,
        country_code:
          bestSession?.countryCode || runtime.detectedCountry || null,
        access_tier: bestSession?.accessTier || null,
        country_block_reason: bestSession?.countryBlockReason || null,
        remaining_ms: bestSession?.remainingMs || null,
        locked_model: lockedModel,
        runs: [],
        rate_limit: rl
          ? {
              model: rl.model,
              recentCount: rl.recentCount,
              limit: rl.limit,
              resetAt: rl.resetAt,
              windowHours: rl.windowHours,
              entitlement: rl.entitlement,
            }
          : null,
        quota: mergedQuota,
      };
    });
    const usableCount = tokenPool.tokens.filter((t) => {
      const h = tokenPool.getTokenHealth(t);
      return (
        h.status !== "banned" &&
        h.status !== "unauthorized" &&
        !tokenPool.isQuotaFull(t)
      );
    }).length;
    const usage = tokenPool.getAggregatedUsage();
    writeJSON(res, 200, {
      ok: true,
      started_at: startTime.toISOString(),
      uptime_sec: Math.floor((Date.now() - startTime.getTime()) / 1000),
      token_state: tokenState,
      models_count: modelRegistry.getModels().length,
      usage,
      total_tokens: tokenPool.tokens.length,
      usable_tokens: usableCount,
      dead_tokens: tokenPool.tokens.length - usableCount,
      locked_tokens: tokenState.filter((t) => t.locked_model).length,
      model_mismatches: MODEL_MISMATCH_LOG.slice(0, 10),
      recent_events: EVENT_LOG.slice(0, 30),
      runtime: IS_BUN ? "bun" : "node",
      runtime_version: RUNTIME_VERSION,
    });
  }

  async function handleModels(req, res) {
    if (req.method !== "GET") {
      writeOpenAIError(
        res,
        405,
        "method not allowed",
        "invalid_request_error",
        "",
      );
      return;
    }
    const created = Math.floor(startTime.getTime() / 1000);
    writeJSON(res, 200, {
      object: "list",
      data: modelRegistry.getModels().map((m) => {
        const metadata = modelRegistry.getModelMetadata(m) || {};
        return {
          id: m,
          object: "model",
          created,
          owned_by: "Freebuff2Opencode",
          root: m,
          permission: [],
          ...metadata,
        };
      }),
    });
  }

  async function handleChatCompletions(req, res) {
    if (req.method !== "POST") {
      writeOpenAIError(
        res,
        405,
        "method not allowed",
        "invalid_request_error",
        "",
      );
      return;
    }
    let requestBody;
    try {
      requestBody = await readBody(req);
    } catch (e) {
      writeOpenAIError(
        res,
        400,
        "failed to read request body",
        "invalid_request_error",
        "",
      );
      return;
    }
    let payload;
    try {
      payload = JSON.parse(requestBody);
    } catch (e) {
      writeOpenAIError(
        res,
        400,
        "request body must be valid JSON",
        "invalid_request_error",
        "",
      );
      return;
    }
    const requestedModel = (payload.model || "").trim();
    if (!requestedModel) {
      writeOpenAIError(
        res,
        400,
        "model is required",
        "invalid_request_error",
        "",
      );
      return;
    }
    await proxyChatRequest(
      res,
      payload,
      requestedModel,
      writeOpenAIError,
      writePassthroughError,
      writeOpenAISuccessResponse,
    );
  }

  async function handleClaudeMessages(req, res) {
    if (req.method !== "POST") {
      writeClaudeError(res, 405, "method not allowed", "invalid_request_error");
      return;
    }
    let requestBody;
    try {
      requestBody = await readBody(req);
    } catch (e) {
      writeClaudeError(
        res,
        400,
        "failed to read request body",
        "invalid_request_error",
      );
      return;
    }
    let payload, requestedModel, stream;
    try {
      ({
        payload,
        modelName: requestedModel,
        stream,
      } = convertClaudeMessagesRequestToOpenAI(requestBody));
    } catch (e) {
      writeClaudeError(res, 400, e.message, "invalid_request_error");
      return;
    }
    await proxyChatRequest(
      res,
      payload,
      requestedModel,
      (r, s, m, t, _) => writeClaudeError(r, s, m, t),
      writeClaudePassthroughError,
      (r, resp) => writeClaudeSuccessResponse(r, resp, requestedModel, stream),
    );
  }

  async function handleClaudeCountTokens(req, res) {
    if (req.method !== "POST") {
      writeClaudeError(res, 405, "method not allowed", "invalid_request_error");
      return;
    }
    let requestBody;
    try {
      requestBody = await readBody(req);
    } catch (e) {
      writeClaudeError(
        res,
        400,
        "failed to read request body",
        "invalid_request_error",
      );
      return;
    }
    let payload, requestedModel;
    try {
      ({ payload, modelName: requestedModel } =
        convertClaudeMessagesRequestToOpenAI(requestBody));
    } catch (e) {
      writeClaudeError(res, 400, e.message, "invalid_request_error");
      return;
    }
    writeJSON(res, 200, {
      input_tokens: countOpenAIPayloadTokens(requestedModel, payload),
    });
  }

  function countOpenAIPayloadTokens(model, payload) {
    return requestUtilities.countOpenAIPayloadTokens(model, payload);
  }

  function isNodeStream(body) {
    return requestUtilities.isNodeStream(body);
  }

  function readBodyText(body) {
    return requestUtilities.readBodyText(body);
  }

  function pipeBodyToResponse(body, res) {
    return requestUtilities.pipeBodyToResponse(body, res);
  }

  async function writeOpenAISuccessResponse(res, resp) {
    return responseWriters.writeOpenAISuccessResponse(res, resp);
  }

  async function pipeBodyToResponseAndCaptureModel(body, res) {
    return responseWriters.pipeBodyToResponseAndCaptureModel(body, res);
  }

  async function writeClaudeSuccessResponse(res, resp, requestedModel, stream) {
    return responseWriters.writeClaudeSuccessResponse(
      res,
      resp,
      requestedModel,
      stream,
    );
  }

  // --- Anthropic Conversion ---
  function convertClaudeMessagesRequestToOpenAI(body) {
    return anthropicRequests.convertClaudeMessagesRequestToOpenAI(body);
  }

  function convertOpenAINonStreamResponseToClaude(body) {
    return anthropicRequests.convertOpenAINonStreamResponseToClaude(body);
  }

  function writePassthroughError(res, statusCode, body) {
    return errorWriters.writePassthroughError(res, statusCode, body);
  }

  function writeClaudePassthroughError(res, statusCode, body) {
    return errorWriters.writeClaudePassthroughError(res, statusCode, body);
  }

  async function handleRequest(req, res) {
    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;

    if (config.apiKeys && config.apiKeys.length > 0 && !authorized(req)) {
      if (isClaudeRequestPath(pathname))
        writeClaudeError(
          res,
          401,
          "invalid proxy api key",
          "authentication_error",
        );
      else
        writeOpenAIError(
          res,
          401,
          "invalid proxy api key",
          "authentication_error",
          "",
        );
      return;
    }

    if (pathname === "/dashboard" || pathname === "/") {
      const dashboardPath = path.join(
        path.resolve(__dirname, "../.."),
        "dashboard.html",
      );
      if (fs.existsSync(dashboardPath)) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(fs.readFileSync(dashboardPath));
        return;
      }
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Dashboard not found");
      return;
    }

    if (pathname === "/api/config") {
      if (req.method === "GET") {
        writeJSON(res, 200, config);
        return;
      }
      if (req.method === "POST") {
        try {
          const body = await readBody(req);
          const newConfig = JSON.parse(body);
          const oldEnabled = config.enabledModels || [];
          Object.assign(config, newConfig);
          saveConfig(config);
          await setupOpencodeConfig(true);
          const newEnabled = config.enabledModels || [];
          const added = newEnabled.filter((m) => !oldEnabled.includes(m));
          if (added.length > 0 && getTokenPool()) {
            probeNewModels(added).catch((e) =>
              logWarn(`[Probe] model probe error: ${e.message}`),
            );
          }
          writeJSON(res, 200, { success: true, config });
        } catch (e) {
          writeJSON(res, 400, { error: e.message });
        }
        return;
      }
    }

    if (pathname === "/api/tokens" && req.method === "GET") {
      const maskedTokens = (config.authTokens || []).map((t) => ({
        token: t.substring(0, 8) + "..." + t.substring(t.length - 4),
        fullLength: t.length,
      }));
      writeJSON(res, 200, { tokens: maskedTokens, count: maskedTokens.length });
      return;
    }

    if (pathname === "/api/auth/start" && req.method === "POST") {
      try {
        const resp = await fetch("https://freebuff.llm.pm/api/code", {
          method: "POST",
        });
        if (!resp.ok) throw new Error("OAuth server error: " + resp.status);
        writeJSON(res, 200, await resp.json());
      } catch (e) {
        writeJSON(res, 500, { error: e.message });
      }
      return;
    }

    if (pathname === "/api/auth/status" && req.method === "POST") {
      try {
        const body = await readBody(req);
        const { fingerprintId, fingerprintHash, expiresAt } = JSON.parse(body);
        const resp = await fetch("https://freebuff.llm.pm/api/status", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fingerprintId, fingerprintHash, expiresAt }),
        });
        if (!resp.ok) throw new Error("OAuth status error: " + resp.status);
        const data = await resp.json();
        if (data.user && data.user.authToken) {
          if (!config.authTokens) config.authTokens = [];
          if (!config.tokenEmails) config.tokenEmails = {};
          const email = data.user.email || data.user.name || null;
          if (config.authTokens.includes(data.user.authToken)) {
            data.tokenAdded = false;
            data.duplicateReason = "Token already configured";
          } else {
            config.authTokens.push(data.user.authToken);
            await resolveAndReconcileToken(
              data.user.authToken,
              {
                email,
                accountId:
                  data.user.id ||
                  data.user.userId ||
                  data.user.accountId ||
                  null,
                source: "oauth",
              },
              new UpstreamClient(config),
            );
            saveConfig(config);
            await reloadTokenPool();
            logInfo(
              "New auth token added via OAuth" +
                (email ? " (" + email + ")" : ""),
            );
            data.tokenAdded = true;
          }
        }
        writeJSON(res, 200, data);
      } catch (e) {
        writeJSON(res, 500, { error: e.message });
      }
      return;
    }

    if (pathname === "/api/models" && req.method === "GET") {
      const modelReg = getModelRegistry();
      writeJSON(res, 200, {
        models: modelReg.getModels(),
        model_metadata: modelReg.getAllModelMetadata(),
        registry: {
          source: "GitHub CodebuffAI/codebuff main/common/src/constants",
          sources: {
            catalog: FREEBUFF_MODELS_SOURCE_URL,
            stable_ids: FREEBUFF_MODEL_IDS_SOURCE_URL,
            agent_mapping: FREE_AGENTS_SOURCE_URL,
            model_constants: MODEL_CONFIG_SOURCE_URL,
          },
          refresh_interval_ms: MODEL_REFRESH_INTERVAL,
          last_ok: modelReg.lastOK,
        },
      });
      return;
    }

    if (pathname === "/api/bg" && req.method === "GET") {
      try {
        const response = await fetch("https://peapix.com/bing/feed");
        const data = await response.json();
        const item = Array.isArray(data) ? data[0] : data;
        const imgUrl = item.fullUrl || item.imageUrl || item.url || "";
        if (imgUrl) writeJSON(res, 200, { url: imgUrl });
        else writeJSON(res, 404, { error: "not found" });
      } catch (e) {
        writeJSON(res, 500, { error: e.message });
      }
      return;
    }

    if (pathname === "/api/ads" && req.method === "GET") {
      const token = (config.authTokens || [])[0];
      if (!token) {
        writeJSON(res, 200, []);
        return;
      }
      try {
        const sessionId = crypto.randomUUID();
        const body = {
          provider: "gravity",
          messages: [],
          sessionId,
          device: {
            os: "windows",
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
            locale: "en-US",
          },
          surface: "waiting_room",
          userAgent:
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        };
        const resp = await fetch(config.upstreamBaseURL + "/api/v1/ads", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "User-Agent": getAdsUserAgent(),
            Accept: "application/json",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(15000),
        });
        if (!resp.ok) {
          writeJSON(res, 200, []);
          return;
        }
        const data = await resp.json();
        logDebug("[Ads] Response:", JSON.stringify(data).substring(0, 500));
        writeJSON(res, 200, data);
      } catch (e) {
        logError("[Ads] Error:", e.message);
        writeJSON(res, 200, []);
      }
      return;
    }

    if (pathname === "/api/ads/impression" && req.method === "POST") {
      const token = (config.authTokens || [])[0];
      if (!token) {
        writeJSON(res, 200, { success: false });
        return;
      }
      try {
        const body = await readBody(req);
        const { impUrl, mode } = JSON.parse(body);
        const resp = await fetch(
          config.upstreamBaseURL + "/api/v1/ads/impression",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
              "User-Agent": getAdsUserAgent(),
              Accept: "application/json",
            },
            body: JSON.stringify({ impUrl, mode: mode || "LITE" }),
            signal: AbortSignal.timeout(10000),
          },
        );
        const data = await resp.json();
        writeJSON(res, 200, data);
      } catch (e) {
        writeJSON(res, 200, { success: false, error: e.message });
      }
      return;
    }

    if (pathname === "/api/events" && req.method === "GET") {
      const limit = Math.min(parseInt(parsedUrl.query.limit) || 50, 200);
      const since = parsedUrl.query.since || null;
      let events = EVENT_LOG;
      if (since) events = events.filter((e) => e.at > since);
      writeJSON(res, 200, {
        events: events.slice(0, limit),
        total: EVENT_LOG.length,
      });
      return;
    }

    if (pathname === "/api/usage" && req.method === "GET") {
      const tp = getTokenPool();
      if (!tp) {
        writeJSON(res, 503, { ok: false, error: "token pool not ready" });
        return;
      }
      const tokens = tp.tokens.map((token, idx) => {
        const session = tp.getSessionForToken(token);
        const rl = session?.rateLimit;
        return {
          name: `token-${idx + 1}`,
          token:
            token.substring(0, 8) + "..." + token.substring(token.length - 4),
          account_id: accountForToken(token).accountId,
          email: accountForToken(token).email || null,
          temporary_account: Boolean(accountForToken(token).temporary),
          ...accountCheckInfo(token),
          model: rl?.model || null,
          recentCount: rl?.recentCount || 0,
          limit: rl?.limit || 0,
          resetAt: rl?.resetAt || null,
          entitlement: rl?.entitlement || null,
          health: tp.getTokenHealth(token),
          account: accountForToken(token),
        };
      });
      writeJSON(res, 200, { tokens, summary: tp.getAggregatedUsage() });
      return;
    }

    if (pathname === "/api/session/unlock" && req.method === "POST") {
      const tp = getTokenPool();
      if (!tp) {
        writeJSON(res, 503, { ok: false, error: "token pool not ready" });
        return;
      }
      try {
        const unlocked = await tp.clearAllLockedModels();
        logInfo(
          `[Unlock] Cleared locked models for ${unlocked.length} token(s)`,
        );
        writeJSON(res, 200, { ok: true, unlocked_count: unlocked.length });
      } catch (e) {
        writeJSON(res, 500, { ok: false, error: e.message });
      }
      return;
    }

    if (pathname === "/healthz") {
      await handleHealthz(req, res);
      return;
    }
    if (pathname === "/v1/models") {
      await handleModels(req, res);
      return;
    }
    if (pathname === "/v1/chat/completions") {
      await debounceRequest();
      await handleChatCompletions(req, res);
      return;
    }
    if (pathname === "/v1/messages") {
      await debounceRequest();
      await handleClaudeMessages(req, res);
      return;
    }
    if (pathname === "/v1/messages/count_tokens") {
      await handleClaudeCountTokens(req, res);
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  }

  return {
    handleRequest,
    handleHealthz,
    handleModels,
    handleChatCompletions,
    handleClaudeMessages,
    handleClaudeCountTokens,
  };
}

module.exports = { createHttpHandlers };
