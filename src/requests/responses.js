function createResponseWriters({ isNodeStream, readBodyText, convertOpenAINonStreamResponseToClaude }) {
  async function writeOpenAISuccessResponse(res, resp) {
    for (const [key, values] of Object.entries(resp.headers)) {
      const lowerKey = key.toLowerCase();
      if (lowerKey === 'content-length' || lowerKey === 'content-encoding') continue;
      res.setHeader(key, values);
    }
    res.writeHead(resp.status);
    let messageId = null;
    let model = null;
    if (resp.headers['content-type']?.includes('text/event-stream')) {
      model = await pipeBodyToResponseAndCaptureModel(resp.body, res);
    } else {
      const buffer = await readBodyText(resp.body);
      try {
        const parsed = JSON.parse(buffer);
        if (parsed.id) messageId = parsed.id;
        if (parsed.model) model = parsed.model;
        if (parsed.choices) {
          for (const choice of parsed.choices) {
            if (choice.delta?.reasoning_details) delete choice.delta.reasoning_details;
            if (choice.message?.reasoning_details) delete choice.message.reasoning_details;
          }
        }
        res.end(JSON.stringify(parsed));
      } catch (_) { res.end(buffer); }
    }
    return { messageId, model };
  }

  async function writeClaudeSuccessResponse(res, resp, requestedModel, stream) {
    if (stream) {
      res.writeHead(resp.status, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      const model = await pipeBodyToResponseAndCaptureModel(resp.body, res);
      return { messageId: null, model };
    }
    const body = await readBodyText(resp.body);
    const converted = convertOpenAINonStreamResponseToClaude(body);
    res.writeHead(resp.status, { 'Content-Type': 'application/json' });
    res.end(converted);
    let messageId = null;
    let model = null;
    try {
      const parsed = JSON.parse(body);
      if (parsed.id) messageId = parsed.id;
      if (parsed.model) model = parsed.model;
    } catch (_) {}
    return { messageId, model };
  }

  function pipeBodyToResponseAndCaptureModel(body, res) {
    let model = null;
    let lineBuffer = '';
    function processChunk(chunk) {
      const text = chunk instanceof Buffer ? chunk.toString() : typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
      lineBuffer += text;
      let separator;
      while ((separator = lineBuffer.indexOf('\n\n')) !== -1) {
        const event = lineBuffer.substring(0, separator + 2);
        lineBuffer = lineBuffer.substring(separator + 2);
        let output = '';
        for (const line of event.split('\n')) {
          if (!line.startsWith('data: ') || line.length <= 6) {
            output += line + '\n';
            continue;
          }
          const json = line.substring(6);
          if (json === '[DONE]') { output += line + '\n'; continue; }
          try {
            const parsed = JSON.parse(json);
            if (!model && parsed.model) model = parsed.model;
            if (parsed.choices) {
              for (const choice of parsed.choices) if (choice.delta?.reasoning_details) delete choice.delta.reasoning_details;
            }
            output += `data: ${JSON.stringify(parsed)}\n`;
          } catch (_) { output += line + '\n'; }
        }
        res.write(Buffer.from(output));
      }
    }
    if (isNodeStream(body)) {
      return new Promise((resolve, reject) => {
        body.on('data', processChunk);
        body.on('end', () => { if (lineBuffer) res.write(Buffer.from(lineBuffer)); res.end(); resolve(model); });
        body.on('error', reject);
      });
    }
    return new Promise((resolve, reject) => {
      const reader = body.getReader();
      function pump() {
        reader.read().then(({ done, value }) => {
          if (done) { if (lineBuffer) res.write(Buffer.from(lineBuffer)); res.end(); resolve(model); return; }
          processChunk(value);
          pump();
        }).catch(reject);
      }
      pump();
    });
  }

  return { writeOpenAISuccessResponse, writeClaudeSuccessResponse, pipeBodyToResponseAndCaptureModel };
}

module.exports = { createResponseWriters };
