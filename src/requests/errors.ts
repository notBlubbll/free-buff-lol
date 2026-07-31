function createErrorWriters({ http }) {
  function writeJSON(res, statusCode, payload) {
    if (res.headersSent || res.destroyed) return;
    try {
      res.writeHead(statusCode, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(JSON.stringify(payload));
    } catch (_) {
      if (!res.headersSent && !res.destroyed) {
        res.writeHead(500, {
          "Content-Type": "application/json; charset=utf-8",
        });
        res.end('{"error":{"message":"encode failed","type":"server_error"}}');
      }
    }
  }

  function writeOpenAIError(res, statusCode, message, errorType, code) {
    if (!message) message = http.STATUS_CODES[statusCode] || "Unknown error";
    const payload = { error: { message, type: errorType } };
    if (code) payload.error.code = code;
    writeJSON(res, statusCode, payload);
  }

  function writeClaudeError(res, statusCode, message, errorType) {
    if (!message) message = http.STATUS_CODES[statusCode] || "Unknown error";
    writeJSON(res, statusCode, {
      type: "error",
      error: { type: errorType || "api_error", message },
    });
  }

  function writePassthroughError(res, statusCode, body) {
    const trimmed = String(body || "").trim();
    try {
      const payload = JSON.parse(trimmed);
      writeOpenAIError(
        res,
        statusCode,
        payload.error?.message || payload.message || trimmed,
        payload.error?.type || "upstream_error",
        payload.error?.code || "",
      );
    } catch (_) {
      writeOpenAIError(res, statusCode, trimmed, "upstream_error", "");
    }
  }

  function writeClaudePassthroughError(res, statusCode, body) {
    const trimmed = String(body || "").trim();
    try {
      const payload = JSON.parse(trimmed);
      writeClaudeError(
        res,
        statusCode,
        payload.error?.message || payload.message || trimmed,
        "api_error",
      );
    } catch (_) {
      writeClaudeError(res, statusCode, trimmed, "api_error");
    }
  }

  return {
    writeJSON,
    writeOpenAIError,
    writeClaudeError,
    writePassthroughError,
    writeClaudePassthroughError,
  };
}

module.exports = { createErrorWriters };
