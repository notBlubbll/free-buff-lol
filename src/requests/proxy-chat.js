function createProxyChatRequest(deps) {
  const { canonicalModelName, FALLBACK_AGENT_IDS, GEMINI_PARENT_AGENT_ID, crypto, markAccountUsed, logModelMismatch, logInfo, logWarn, logError, logDebug, debugLog, pushEvent, isGeminiModel, getGeminiSubagentId, startRunChainGemini, startRunChainNormal, finalizeRunChainGemini, finalizeRunChainNormal, normalizeChatMessages, cloneMap, normalizeToolSchemas, generateClientSessionId, readBodyText, isSessionInvalid, isRunInvalid, stream } = deps;
  const tokenPool = new Proxy({}, { get(_, property) { const value = deps.getTokenPool()?.[property]; return typeof value === 'function' ? value.bind(deps.getTokenPool()) : value; } });
  const modelRegistry = new Proxy({}, { get(_, property) { const value = deps.getModelRegistry()?.[property]; return typeof value === 'function' ? value.bind(deps.getModelRegistry()) : value; } });
  async function proxyChatRequest(res, payload, requestedModel, writeError, writeUpstreamError, writeSuccess) {
  const reqStart = Date.now();

  if (!tokenPool.hasUsableTokensForModel(requestedModel)) {
    const health = tokenPool ? tokenPool.getAllTokenHealth() : {};
    const deadSummary = Object.values(health).reduce((acc, h) => {
      if (h.status === 'banned' || h.status === 'unauthorized') acc[h.status] = (acc[h.status] || 0) + 1;
      return acc;
    }, {});
    let msg = 'No usable authentication tokens';
    if (deadSummary.banned || deadSummary.unauthorized) {
      msg += `: ${deadSummary.banned || 0} banned, ${deadSummary.unauthorized || 0} unauthorized`;
    }
    writeError(res, 503, msg, 'server_error', 'no_usable_tokens');
    return;
  }

  const token = tokenPool.getToken(requestedModel);
  if (!token) { writeError(res, 503, 'no authentication tokens configured', 'server_error', 'no_tokens'); return; }
  markAccountUsed(token);
  const client = tokenPool.client;

  try { await client.validateAgents(token); } catch (_) {}
  try { await client.requestAds(token, 'gravity', payload.messages || []); } catch (_) {}
  try { await client.getStreak(token); } catch (_) {}

  let currentModel = requestedModel;
  let mismatchUnlockAttempted = false;
  let currentToken = token;
  const triedTokens = new Set([token]);
  let lastRateLimitError = null;

  // Phase 1: try all tokens with the requested model
  for (let attempt = 0; attempt < 10; attempt++) {
    let sessionInstanceID;
    let actualModel = currentModel;
    let accessTier = null;
    try {
      const session = await tokenPool.ensureSession(currentToken, currentModel);
      sessionInstanceID = session.instanceID;
      actualModel = session.model;
      accessTier = session.accessTier;
      lastRateLimitError = null;
    } catch (e) {
      const isRateLimited = e.message && (e.message.includes('429') || e.message.includes('rate_limited'));
      if (isRateLimited) {
        lastRateLimitError = e;
        // Reload pool in case hot-reload added new tokens
        const preReloadTried = triedTokens.size;
        if (tokenPool.tokens.length > preReloadTried) {
          logInfo(`[Token Rotate] Pool has ${tokenPool.tokens.length} tokens but only ${preReloadTried} tried, checking for new tokens...`);
        }
        const nextToken = tokenPool.getToken(currentModel, triedTokens);
        if (nextToken && !triedTokens.has(nextToken)) {
          logInfo(`[Token Rotate] ${currentToken.substring(0, 8)}... rate limited on ${currentModel}, trying ${nextToken.substring(0, 8)}...`);
          triedTokens.add(nextToken);
          currentToken = nextToken;
          markAccountUsed(currentToken);
          await new Promise(r => setTimeout(r, 300));
          continue;
        }
        // All known tokens tried — check if pool grew (hot-reload)
        if (tokenPool.tokens.length > triedTokens.size) {
          const hotReloadToken = tokenPool.getToken(currentModel, triedTokens);
          if (hotReloadToken) {
            logInfo(`[Token Rotate] Found new token ${hotReloadToken.substring(0, 8)}... from hot-reload, trying it`);
            triedTokens.add(hotReloadToken);
            currentToken = hotReloadToken;
            markAccountUsed(currentToken);
            await new Promise(r => setTimeout(r, 300));
            continue;
          }
        }
        break;
      }
      writeError(res, 502, `failed to acquire upstream free session: ${e.message}`, 'server_error', '');
      return;
    }

    if (actualModel !== requestedModel) {
      logModelMismatch(requestedModel, actualModel, 'session_created_with_different_model', tokenPool.tokens.indexOf(currentToken));
    }

    const canonicalModel = canonicalModelName(actualModel);
    const agentID = modelRegistry.getAgentForModel(canonicalModel) || FALLBACK_AGENT_IDS[canonicalModel] || 'base2-free';

    const isGemini = isGeminiModel(canonicalModel);
    let geminiSubagent = null;
    let geminiParentAgent = null;

    let run;
    try {
      if (isGemini) {
        geminiSubagent = getGeminiSubagentId(canonicalModel);
        geminiParentAgent = GEMINI_PARENT_AGENT_ID;
        run = await startRunChainGemini(client, currentToken, geminiParentAgent, geminiSubagent);
      } else {
        run = await startRunChainNormal(client, currentToken, agentID);
      }
    } catch (e) {
      writeError(res, 502, `failed to start run chain: ${e.message}`, 'server_error', '');
      return;
    }

    const requestedDisplay = actualModel !== requestedModel ? ` (locked from ${requestedModel})` : '';
    const chatRunId = isGemini ? run.chatRunId : run.runId;
    logInfo(`[Request] model: ${actualModel}${requestedDisplay}, run: ${run.runId}${isGemini ? ` (child: ${chatRunId})` : ''}, tier: ${accessTier || 'normal'}`);
    if (actualModel && actualModel.includes('luna')) {
      debugLog({ event: 'client_payload', model: actualModel, originalPayload: JSON.parse(JSON.stringify(payload)) });
    }
    const userMsg = (payload.messages || []).find(m => m.role === 'user');
    if (userMsg) logDebug(`[Prompt] ${typeof userMsg.content === 'string' ? userMsg.content : JSON.stringify(userMsg.content)}`);

    const normalizedMessages = normalizeChatMessages(payload.messages);
    const cloned = cloneMap(payload);
    cloned.model = actualModel;
    cloned.messages = normalizedMessages;

    if (cloned.tools) normalizeToolSchemas(cloned.tools);

    const clientId = generateClientSessionId();
    const traceSessionId = crypto.randomUUID();
    if (cloned.stream === undefined) cloned.stream = true;
    delete cloned.codebuff;
    delete cloned.codebuff_metadata;
    delete cloned.provider;
    cloned.codebuff_metadata = {
      freebuff_instance_id: sessionInstanceID,
      trace_session_id: traceSessionId,
      run_id: chatRunId,
      client_id: clientId,
      cost_mode: 'free',
    };
    cloned.provider = { data_collection: 'deny' };
    if (!cloned.stop) cloned.stop = ['cb_easp'];

    if (cloned.reasoning_effort !== undefined || cloned.reasoningEffort !== undefined || (cloned.reasoning && cloned.reasoning.effort !== undefined)) {
      logInfo(`[Normalize] reasoning_effort=${JSON.stringify(cloned.reasoning_effort)}, reasoningEffort=${JSON.stringify(cloned.reasoningEffort)}, reasoning.effort=${JSON.stringify(cloned.reasoning && cloned.reasoning.effort)}`);
    }

    // Upstream (luna etc.) only accepts reasoning.effort, not reasoning_effort or reasoningEffort.
    // If client sent any of them, move it into reasoning.effort.
    const effortValue = cloned.reasoning_effort ?? cloned.reasoningEffort ?? (cloned.reasoning && cloned.reasoning.effort);
    if (effortValue !== undefined) {
      if (!cloned.reasoning) cloned.reasoning = {};
      cloned.reasoning.effort = effortValue;
      delete cloned.reasoning_effort;
      delete cloned.reasoningEffort;
    }

    if (actualModel && actualModel.includes('luna')) {
      debugLog({ event: 'upstream_send', model: actualModel, token: currentToken.substring(0, 8), payload: JSON.parse(JSON.stringify(cloned)) });
    }

    let resp;
    try { resp = await client.chatCompletions(currentToken, cloned); } catch (e) {
      if (actualModel && actualModel.includes('luna')) debugLog({ event: 'upstream_error', model: actualModel, error: e.message });
      writeError(res, 502, e.message, 'server_error', '');
      return;
    }

    if (actualModel && actualModel.includes('luna') && resp.status >= 400) {
      const errBody = await readBodyText(resp.body);
      debugLog({ event: 'upstream_response', model: actualModel, status: resp.status, body: errBody.substring(0, 2000) });
      // Reconstruct a new response since we consumed the body
      resp = { status: resp.status, body: require('stream').Readable.from(Buffer.from(errBody)), headers: resp.headers };
    }

    if (resp.status === 429) {
      const errorBodyStr = await readBodyText(resp.body);
      logWarn(`[Rate Limit] 429: ${errorBodyStr.substring(0, 200)}`);
      pushEvent('warn', 'Rate limited (429)', { detail: errorBodyStr.substring(0, 200), model: actualModel });
      for (let retry = 0; retry < 3; retry++) {
        const waitMs = (retry + 1) * 3000;
        logInfo(`[Rate Limit] Waiting ${waitMs / 1000}s before retry ${retry + 1}/3...`);
        await new Promise(r => setTimeout(r, waitMs));
        try { resp = await client.chatCompletions(currentToken, cloned); } catch (e) {
          writeError(res, 502, e.message, 'server_error', '');
          return;
        }
        if (resp.status !== 429) break;
        logWarn(`[Rate Limit] Still 429 on retry ${retry + 1}`);
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
      try { const result = await writeSuccess(res, resp); messageId = result.messageId; actualResponseModel = result.model; } catch (e) { logError(`proxy response copy failed: ${e.message}`); }
      logInfo(`[Response] model: ${actualResponseModel || actualModel}, completed in ${Date.now() - reqStart}ms (status: ${resp.status})`);
      setImmediate(() => isGemini ? finalizeRunChainGemini(client, currentToken, run, messageId) : finalizeRunChainNormal(client, currentToken, run, messageId));
      return;
    }

    const errorBodyStr = await readBodyText(resp.body);
    logError(`[Upstream Error] ${resp.status}: ${errorBodyStr.substring(0, 200)}`);
    pushEvent('error', `[Upstream Error] ${resp.status}`, { detail: errorBodyStr.substring(0, 200), model: actualModel, status: resp.status });

    if (isSessionInvalid(resp.status, errorBodyStr)) {
      let errorType = '';
      let lockedModel = null;
      try {
        const errorData = JSON.parse(errorBodyStr);
        errorType = errorData.error || '';
        if (errorType === 'session_model_mismatch') {
          lockedModel = errorData.lockedModel || null;
          if (!lockedModel && errorData.message) {
            const match = errorData.message.match(/bound to ([a-zA-Z0-9][a-zA-Z0-9._/-]+)/);
            if (match) lockedModel = match[1].replace(/;.*$/, '').replace(/\.$/, '');
          }
          if (!lockedModel) {
            const cached = await tokenPool.getLockedModel(currentToken);
            if (cached) lockedModel = cached;
          }
          if (!lockedModel) {
            try { const parsed = JSON.parse(errorBodyStr); if (parsed.body && parsed.body.currentModel) lockedModel = parsed.body.currentModel; } catch (_) {}
          }
        }
      } catch (e) {}
      logWarn(`[Session Invalid] status=${resp.status}, error=${errorType}${lockedModel ? ', lockedModel=' + lockedModel : ''}`);
      pushEvent('warn', `Session invalid: ${errorType}`, { detail: `status=${resp.status}${lockedModel ? ', lockedModel=' + lockedModel : ''}`, model: actualModel, requestedModel, errorType });
      
      if (errorType === 'session_superseded') {
        logModelMismatch(requestedModel, actualModel, 'session_superseded', tokenPool.tokens.indexOf(currentToken));
        tokenPool.invalidateAllSessionsForToken(currentToken);
      }

      if (errorType === 'freebuff_update_required' || resp.status === 426) {
        logWarn(`[Version] Server requires update, invalidating session and retrying...`);
        pushEvent('warn', 'Server requires update', { detail: 'freebuff_update_required', model: actualModel });
      }
      tokenPool.invalidateSession(currentToken, actualModel);
      if (requestedModel !== actualModel) tokenPool.invalidateSession(currentToken, requestedModel);

      if (errorType === 'session_model_mismatch' && lockedModel && lockedModel !== requestedModel && !mismatchUnlockAttempted) {
        mismatchUnlockAttempted = true;
        logModelMismatch(requestedModel, lockedModel, 'session_model_mismatch_unlock_retry', tokenPool.tokens.indexOf(currentToken));
        logInfo(`[Model Lock] Mismatch: session bound to ${lockedModel}. Ending session to unlock and retrying requested model ${requestedModel}`);
        pushEvent('model_switch', `Unlocking session to retry requested model`, { from: lockedModel, to: requestedModel, reason: 'session_model_mismatch_unlock_retry', token: currentToken.substring(0, 8) + '...' });
        await tokenPool.clearLockedModel(currentToken);
        currentModel = requestedModel;
        continue;
      }
      if (lockedModel) {
        logModelMismatch(currentModel, lockedModel, 'model_locked_fallback', tokenPool.tokens.indexOf(currentToken));
        logInfo(`[Model Lock] Switching from ${currentModel} to ${lockedModel}`);
        pushEvent('model_switch', `Switched to locked model`, { from: currentModel, to: lockedModel, reason: 'model_locked_fallback', token: currentToken.substring(0, 8) + '...' });
        await tokenPool.setLockedModel(currentToken, lockedModel);
        tokenPool.invalidateSession(currentToken, lockedModel);
        currentModel = lockedModel;
      }
      continue;
    }

    if (isRunInvalid(resp.status, errorBodyStr)) {
      logWarn(`run ${run.runId} invalid, retrying`);
      continue;
    }

    logError(`upstream error response: ${errorBodyStr}`);
    writeUpstreamError(res, resp.status, errorBodyStr);
    return;
  }

  // Phase 2: all tokens exhausted for requested model, try fallback models
  if (lastRateLimitError) {
    const allModels = modelRegistry.getModels();
    const fallbackCandidates = allModels
      .filter(m => m !== requestedModel && !m.includes('gemini'))
      .slice(0, 5);
    const fallbackToken = token;
    for (const candidate of fallbackCandidates) {
      try {
        logInfo(`[Fallback] All tokens rate limited on ${requestedModel}, trying model ${candidate}`);
        const session = await tokenPool.ensureSession(fallbackToken, candidate);
        logModelMismatch(requestedModel, candidate, 'rate_limit_fallback', tokenPool.tokens.indexOf(fallbackToken));
        currentModel = candidate;
        currentToken = fallbackToken;
        markAccountUsed(currentToken);
        mismatchUnlockAttempted = false;
        // Re-enter the main flow with the fallback model
        const canonicalModel = canonicalModelName(candidate);
        const agentID = modelRegistry.getAgentForModel(canonicalModel) || FALLBACK_AGENT_IDS[canonicalModel] || 'base2-free';
        const isGemini = isGeminiModel(canonicalModel);
        let run;
        try {
          if (isGemini) {
            const geminiSubagent = getGeminiSubagentId(canonicalModel);
            const geminiParentAgent = GEMINI_PARENT_AGENT_ID;
            run = await startRunChainGemini(client, currentToken, geminiParentAgent, geminiSubagent);
          } else {
            run = await startRunChainNormal(client, currentToken, agentID);
          }
        } catch (e) {
          logWarn(`[Fallback] run chain failed for ${candidate}: ${e.message}`);
          continue;
        }
        const normalizedMessages = normalizeChatMessages(payload.messages);
        const cloned = cloneMap(payload);
        cloned.model = candidate;
        cloned.messages = normalizedMessages;
        if (cloned.tools) normalizeToolSchemas(cloned.tools);
        const clientId = generateClientSessionId();
        const traceSessionId = crypto.randomUUID();
        if (cloned.stream === undefined) cloned.stream = true;
        delete cloned.codebuff;
        delete cloned.codebuff_metadata;
        delete cloned.provider;
        cloned.codebuff_metadata = {
          freebuff_instance_id: session.instanceID,
          trace_session_id: traceSessionId,
          run_id: isGemini ? run.chatRunId : run.runId,
          client_id: clientId,
          cost_mode: 'free',
        };
        cloned.provider = { data_collection: 'deny' };
        if (!cloned.stop) cloned.stop = ['cb_easp'];
        const fbEffort = cloned.reasoning_effort ?? cloned.reasoningEffort ?? (cloned.reasoning && cloned.reasoning.effort);
        if (fbEffort !== undefined) {
          if (!cloned.reasoning) cloned.reasoning = {};
          cloned.reasoning.effort = fbEffort;
          delete cloned.reasoning_effort;
          delete cloned.reasoningEffort;
        }
        let resp;
        try { resp = await client.chatCompletions(currentToken, cloned); } catch (e) {
          logWarn(`[Fallback] chat request failed for ${candidate}: ${e.message}`);
          continue;
        }
        if (resp.status >= 200 && resp.status < 300) {
          let messageId = null;
          let actualResponseModel = null;
          try { const result = await writeSuccess(res, resp); messageId = result.messageId; actualResponseModel = result.model; } catch (e) { logError(`proxy response copy failed: ${e.message}`); }
          logInfo(`[Response] model: ${actualResponseModel || candidate}, completed in ${Date.now() - reqStart}ms (status: ${resp.status}) [fallback]`);
          setImmediate(() => isGemini ? finalizeRunChainGemini(client, currentToken, run, messageId) : finalizeRunChainNormal(client, currentToken, run, messageId));
          return;
        }
        logWarn(`[Fallback] ${candidate} returned ${resp.status}`);
      } catch (fbErr) {
        if (fbErr.message.includes('429')) continue;
        break;
      }
    }
    logModelMismatch(requestedModel, requestedModel, 'rate_limit_all_exhausted', tokenPool.tokens.indexOf(token));
    const finalBody = lastRateLimitError.message || 'rate limited';
    writeUpstreamError(res, 429, finalBody);
    return;
  }

  writeError(res, 502, 'upstream run expired twice in a row', 'server_error', '');
}
  return proxyChatRequest;
}

module.exports = { createProxyChatRequest };
