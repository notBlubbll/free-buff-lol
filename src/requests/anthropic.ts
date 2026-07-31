function convertClaudeMessagesRequestToOpenAI(body) {
  const root = JSON.parse(body);
  const modelName = (root.model || "").trim();
  if (!modelName) throw new Error("model is required");
  const stream = root.stream || false;
  const out = { model: modelName, messages: [], stream };
  if (root.max_tokens && root.max_tokens > 0) out.max_tokens = root.max_tokens;
  if (root.temperature !== undefined) out.temperature = root.temperature;
  else if (root.top_p !== undefined) out.top_p = root.top_p;

  const messages = [];
  if (root.system) {
    const systemText =
      typeof root.system === "string"
        ? root.system
        : Array.isArray(root.system)
          ? root.system
              .filter((part) => part && part.type === "text")
              .map((part) => part.text)
              .join("\n")
          : "";
    if (systemText.trim())
      messages.push({ role: "system", content: systemText.trim() });
  }
  if (!Array.isArray(root.messages))
    throw new Error("messages must be an array");
  for (const rawMessage of root.messages) {
    if (!rawMessage || typeof rawMessage !== "object") continue;
    const role = (rawMessage.role || "").trim();
    if (!role) continue;
    const content = rawMessage.content;
    let text = "";
    if (typeof content === "string") text = content;
    else if (Array.isArray(content)) {
      const parts = content
        .map((part) => {
          if (!part || typeof part !== "object") return part;
          if (part.type === "text")
            return { type: "text", text: part.text || "" };
          if (part.type === "image") {
            const source = part.source || {};
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
          if (part.type === "image_url" || part.type === "video_url")
            return part;
          return null;
        })
        .filter(Boolean);
      if (parts.length > 0) messages.push({ role, content: parts });
      continue;
    }
    if (text.trim()) messages.push({ role, content: text.trim() });
  }
  out.messages = messages;
  return { payload: out, modelName, stream };
}

function parseJSONObject(raw) {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : {};
  } catch (_) {
    return {};
  }
}

function mapOpenAIFinishReasonToClaude(reason) {
  const value = (reason || "").toLowerCase().trim();
  if (value === "tool_calls" || value === "function_call") return "tool_use";
  if (value === "length") return "max_tokens";
  return "end_turn";
}

function convertOpenAINonStreamResponseToClaude(body) {
  const response = JSON.parse(body);
  const message = {
    id: response.id || "",
    type: "message",
    role: "assistant",
    model: response.model || "",
    content: [],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
  let hasToolCall = false;
  if (response.choices && response.choices.length > 0) {
    const choice = response.choices[0];
    const text = choice.message && choice.message.content;
    if (text && typeof text === "string" && text.trim())
      message.content.push({ type: "text", text: text.trim() });
    if (choice.message && choice.message.tool_calls) {
      for (const toolCall of choice.message.tool_calls) {
        hasToolCall = true;
        message.content.push({
          type: "tool_use",
          id: toolCall.id || "",
          name: (toolCall.function || {}).name || "",
          input: parseJSONObject((toolCall.function || {}).arguments),
        });
      }
    }
    if (choice.finish_reason)
      message.stop_reason = mapOpenAIFinishReasonToClaude(choice.finish_reason);
  }
  if (response.usage) {
    message.usage.input_tokens = response.usage.prompt_tokens || 0;
    message.usage.output_tokens = response.usage.completion_tokens || 0;
  }
  if (message.stop_reason === "end_turn" && hasToolCall)
    message.stop_reason = "tool_use";
  return JSON.stringify(message);
}

module.exports = {
  convertClaudeMessagesRequestToOpenAI,
  convertOpenAINonStreamResponseToClaude,
};
