function createRunChains({
  contextPrunerAgentId,
  geminiParentAgentId,
  getGeminiSubagentId,
  isGeminiModel,
  logError,
}) {
  async function startNormal(client, token, agentId) {
    const startedAt = new Date().toISOString();
    const runId = await client.startRun(token, agentId, []);
    const childStartedAt = new Date().toISOString();
    const childRunId = await client.startRun(token, contextPrunerAgentId, [
      runId,
    ]);
    await client.recordRunStep(token, childRunId, 1, [], null, childStartedAt);
    await client.finishRun(token, childRunId, 2);
    await client.recordRunStep(token, runId, 1, [childRunId], null, startedAt);
    return { runId, agentId, startedAt, childRunId };
  }

  async function startGemini(client, token, parentAgentId, chatAgentId) {
    const startedAt = new Date().toISOString();
    const parentRunId = await client.startRun(token, parentAgentId, []);
    const chatStartedAt = new Date().toISOString();
    const chatRunId = await client.startRun(token, chatAgentId, [parentRunId]);
    return {
      runId: parentRunId,
      agentId: parentAgentId,
      startedAt,
      chatRunId,
      chatStartedAt,
    };
  }

  async function finalizeNormal(client, token, run, messageId) {
    try {
      await client.recordRunStep(
        token,
        run.runId,
        2,
        [],
        messageId,
        run.startedAt,
      );
      await client.finishRun(token, run.runId, 3);
    } catch (error) {
      logError(`finalize run failed: ${error.message}`);
    }
  }

  async function finalizeGemini(client, token, run, messageId) {
    try {
      await client.recordRunStep(
        token,
        run.chatRunId,
        1,
        [],
        messageId,
        run.chatStartedAt,
      );
      await client.finishRun(token, run.chatRunId, 2);
      await client.recordRunStep(
        token,
        run.runId,
        1,
        [run.chatRunId],
        null,
        run.startedAt,
      );
      await client.finishRun(token, run.runId, 2);
    } catch (error) {
      logError(`finalize gemini run failed: ${error.message}`);
    }
  }

  async function startSimple(client, token, agentId) {
    const startedAt = new Date().toISOString();
    const runId = await client.startRun(token, agentId, []);
    return { runId, agentId, startedAt };
  }

  async function finalizeSimple(client, token, run, messageId) {
    try {
      await client.recordRunStep(
        token,
        run.runId,
        1,
        [],
        messageId,
        run.startedAt,
      );
      await client.finishRun(token, run.runId, 2);
    } catch (error) {
      logError(`finalize simple run failed: ${error.message}`);
    }
  }

  return {
    startNormal,
    startGemini,
    finalizeNormal,
    finalizeGemini,
    startSimple,
    finalizeSimple,
  };
}

module.exports = { createRunChains };
