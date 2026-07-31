const crypto = require("crypto");

function generateClientSessionId() {
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
  const buf = crypto.randomBytes(10);
  let out = "";
  for (let i = 0; i < 13; i++) out += alphabet[buf[i % buf.length] % 36];
  return out;
}

function cloneMap(input) {
  const output = {};
  for (const [key, value] of Object.entries(input)) {
    if (value && typeof value === "object" && !Array.isArray(value))
      output[key] = cloneMap(value);
    else if (Array.isArray(value)) output[key] = cloneSlice(value);
    else output[key] = value;
  }
  return output;
}

function cloneSlice(input) {
  return input.map((value) => {
    if (value && typeof value === "object" && !Array.isArray(value))
      return cloneMap(value);
    if (Array.isArray(value)) return cloneSlice(value);
    return value;
  });
}

function isNodeStream(body) {
  return (
    body && typeof body.pipe === "function" && typeof body.on === "function"
  );
}

function readBodyText(body) {
  if (isNodeStream(body)) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      body.on("data", (chunk) => chunks.push(chunk));
      body.on("end", () => resolve(Buffer.concat(chunks).toString()));
      body.on("error", reject);
    });
  }
  if (body && typeof body.getReader === "function") {
    const reader = body.getReader();
    const chunks = [];
    return new Promise((resolve, reject) => {
      function pump() {
        reader
          .read()
          .then(({ done, value }) => {
            if (done) {
              resolve(Buffer.concat(chunks).toString());
              return;
            }
            chunks.push(Buffer.from(value));
            pump();
          })
          .catch(reject);
      }
      pump();
    });
  }
  if (body && typeof body[Symbol.asyncIterator] === "function") {
    return (async () => {
      const chunks = [];
      for await (const chunk of body) chunks.push(Buffer.from(chunk));
      return Buffer.concat(chunks).toString();
    })();
  }
  return String(body);
}

function pipeBodyToResponse(body, res) {
  if (isNodeStream(body)) {
    return new Promise((resolve, reject) => {
      body.on("data", (chunk) => res.write(chunk));
      body.on("end", () => {
        res.end();
        resolve();
      });
      body.on("error", reject);
    });
  }
  return new Promise((resolve, reject) => {
    const reader = body.getReader();
    function pump() {
      reader
        .read()
        .then(({ done, value }) => {
          if (done) {
            res.end();
            resolve();
            return;
          }
          res.write(value);
          pump();
        })
        .catch(reject);
    }
    pump();
  });
}

function countOpenAIPayloadTokens(model, payload) {
  const segments = [];
  if (Array.isArray(payload.messages)) {
    for (const message of payload.messages) {
      if (!message || typeof message !== "object") continue;
      if (message.role) segments.push(message.role);
      if (typeof message.content === "string") segments.push(message.content);
      else if (Array.isArray(message.content)) {
        for (const part of message.content) {
          if (
            part &&
            typeof part === "object" &&
            part.type === "text" &&
            part.text
          )
            segments.push(part.text);
        }
      }
    }
  }
  return Math.ceil(segments.join("\n").length / 4);
}

module.exports = {
  generateClientSessionId,
  cloneMap,
  cloneSlice,
  isNodeStream,
  readBodyText,
  pipeBodyToResponse,
  countOpenAIPayloadTokens,
};
