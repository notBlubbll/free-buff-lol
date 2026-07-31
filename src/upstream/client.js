function createUpstreamClient(deps) {
  const { CODEBUFF_ACCEPT_ENCODING, CODEBUFF_JSON_USER_AGENT, FREEBUFF_CLI_USER_AGENT, getChatUserAgent, logDebug, logInfo, logWarn, logError, debugLog, buildAgentValidationPayload, normalizeAdMessages, nodeFetch } = deps;
  const fetch = deps.fetch || globalThis.fetch;
  class UpstreamClient {
  constructor(cfg) {
    this.baseURL = cfg.upstreamBaseURL;
    this.timeout = cfg.requestTimeout;
  }

  _hostHeader() {
    try { return new URL(this.baseURL).host; } catch (_) { return 'www.codebuff.com'; }
  }

  apiHeaders(authToken, extra = {}) {
    return {
      'Accept': '*/*',
      'Accept-Encoding': CODEBUFF_ACCEPT_ENCODING,
      'Connection': 'keep-alive',
      'Host': this._hostHeader(),
      'User-Agent': CODEBUFF_JSON_USER_AGENT,
      'Authorization': `Bearer ${authToken}`,
      ...extra
    };
  }

  chatHeaders(authToken, stream = false) {
    return {
      'Accept': '*/*',
      'Accept-Encoding': CODEBUFF_ACCEPT_ENCODING,
      'Connection': 'keep-alive',
      'Host': this._hostHeader(),
      'Content-Type': 'application/json',
      'User-Agent': getChatUserAgent(),
      'Authorization': `Bearer ${authToken}`,
    };
  }

  cliHeaders(authToken, extra = {}) {
    return {
      'Accept': '*/*',
      'Accept-Encoding': CODEBUFF_ACCEPT_ENCODING,
      'Connection': 'keep-alive',
      'Host': this._hostHeader(),
      'User-Agent': FREEBUFF_CLI_USER_AGENT,
      'Authorization': `Bearer ${authToken}`,
      ...extra
    };
  }

  async doJSON(authToken, pth, body, method = 'POST', extraHeaders = {}) {
    const requestURL = this.baseURL + pth;
    const headers = this.apiHeaders(authToken, {
      'Content-Type': 'application/json',
      ...extraHeaders
    });
    logDebug(`[API] ${method} ${pth}`);
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

  chatCompletions(authToken, body) {
    const requestURL = this.baseURL + '/api/v1/chat/completions';
    if (body && body.model && body.model.includes('luna')) {
      debugLog({ event: 'fetch_send', url: requestURL, bodyKeys: Object.keys(body), reasoning_effort: body.reasoning_effort, reasoningEffort: body.reasoningEffort, reasoning: body.reasoning });
    }
    const isStream = body && body.stream === true;
    const headers = this.chatHeaders(authToken, isStream);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    const fetchOpts = {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
      compress: true,
    };
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

  createSession(authToken, model = '', countryCode) {
    const extraHeaders = {};
    if (model) extraHeaders['x-freebuff-model'] = model;
    return this.doSessionRequest('POST', authToken, '', extraHeaders, countryCode);
  }

  getSession(authToken, instanceID) {
    return this.doSessionRequest('GET', authToken, instanceID, {});
  }

  endSession(authToken, instanceID = '') {
    return this.doSessionRequest('DELETE', authToken, instanceID);
  }

  async doSessionRequest(method, authToken, instanceID, extraHeaders = {}, countryCode) {
    const headers = this.cliHeaders(authToken, extraHeaders);
    if (instanceID && (method === 'GET' || method === 'DELETE')) headers['x-freebuff-instance-id'] = instanceID;
    if (method === 'POST') headers['Content-Type'] = 'application/json';
    const body = method === 'POST' ? (countryCode ? JSON.stringify({ countryCode }) : '{}') : null;
    const requestURL = this.baseURL + '/api/v1/freebuff/session';
    logDebug(`Session ${method} sending to ${requestURL}`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      const fetchOpts = { method, headers, body: body || undefined, signal: controller.signal };
      const resp = await fetch(requestURL, fetchOpts);
      clearTimeout(timer);
      const data = await resp.text();
      logDebug(`Session ${method} response (${resp.status}): ${data.substring(0, 300)}`);
      if (resp.status === 404) return { status: 'disabled' };
      if (resp.status < 200 || resp.status >= 300) {
        if (resp.status === 426 || data.includes('freebuff_update_required')) throw new Error('freebuff_update_required');
        if (data.includes('model_locked')) throw new Error(JSON.stringify({ type: 'model_locked', body: JSON.parse(data) }));
        throw new Error(`free session request failed ${resp.status}: ${data}`);
      }
      try { return JSON.parse(data); } catch (e) { throw new Error('decode session: ' + e.message); }
    } catch (e) { clearTimeout(timer); throw e; }
  }

  async validateAgents(authToken) {
    const agentDefs = buildAgentValidationPayload();
    const resp = await this.doJSON(authToken, '/api/agents/validate', agentDefs, 'POST', { 'User-Agent': CODEBUFF_JSON_USER_AGENT });
    if (resp.status >= 200 && resp.status < 300) {
      logInfo('[Agents] Validation completed');
    } else {
      logWarn(`[Agents] Validation failed (${resp.status}), continuing with server configs`);
    }
  }

  async requestAds(authToken, provider, messages = [], sessionId = '') {
    const body = {
      provider,
      messages: normalizeAdMessages(messages),
      sessionId,
      device: { os: 'windows', timezone: 'Asia/Shanghai', locale: 'zh-CN' },
      userAgent: CODEBUFF_JSON_USER_AGENT,
    };
    return await this.doJSON(authToken, '/api/v1/ads', body, 'POST', { 'User-Agent': FREEBUFF_CLI_USER_AGENT });
  }

  async getStreak(authToken) {
    return await this.doJSON(authToken, '/api/v1/freebuff/streak', null, 'GET');
  }

  async getAccountIdentity(authToken) {
    for (const pth of ['/api/v1/user', '/api/user', '/api/v1/me', '/api/me']) {
      const response = await this.doJSON(authToken, pth, null, 'GET');
      if (response.status === 404) continue;
      if (response.status === 401 || response.status === 403) return { status: 'unauthorized', error: `identity lookup failed ${response.status}` };
      if (response.status >= 500) throw new Error(`identity lookup failed ${response.status}`);
      if (response.status < 200 || response.status >= 300) continue;
      let body;
      try { body = JSON.parse(response.body); } catch (_) { continue; }
      const user = body.user || body.account || body.profile || body.data || body;
      const accountId = user.id || user.userId || user.accountId || user.uuid || body.userId || body.accountId || null;
      const email = user.email || user.mail || body.email || null;
      if (accountId || email) return { status: 'resolved', accountId: accountId ? String(accountId) : null, email: email ? String(email).trim().toLowerCase() : null, endpoint: pth };
    }
    return { status: 'temporary', error: 'upstream returned no account identity' };
  }

  async reportZeroclickImpression(authToken, ids) {
    if (!ids || ids.length === 0) return;
    const headers = {
      'Content-Type': 'application/json',
      'Accept': '*/*',
      'Host': 'zeroclick.dev',
      'User-Agent': CODEBUFF_JSON_USER_AGENT,
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      const resp = await fetch('https://zeroclick.dev/api/v2/impressions', {
        method: 'POST',
        headers,
        body: JSON.stringify({ ids }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      const data = await resp.text();
      if (resp.status >= 400) logWarn(`[Ads] Zeroclick impression failed: ${resp.status}`);
      return { status: resp.status, body: data };
    } catch (e) { clearTimeout(timer); logError(`[Ads] Zeroclick error: ${e.message}`); }
  }

  async reportCodebuffImpression(authToken, impUrl) {
    if (!impUrl) return;
    return await this.doJSON(authToken, '/api/v1/ads/impression', { impUrl, mode: 'LITE' }, 'POST', { 'User-Agent': FREEBUFF_CLI_USER_AGENT });
  }
}
  return UpstreamClient;
}

module.exports = { createUpstreamClient };
