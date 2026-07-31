const { cloneMap } = require("./utilities");

function normalizeToolSchemas(tools) {
  for (const tool of tools || []) {
    if (!tool || typeof tool !== "object") continue;
    const fn = tool.function;
    if (!fn || typeof fn !== "object") continue;
    const params = fn.parameters;
    if (!params || typeof params !== "object") continue;
    fn.parameters = normalizeSchemaMap(params, extractDefinitions(params), 12);
  }
}

function extractDefinitions(schema) {
  const merged = {};
  if (schema.definitions && typeof schema.definitions === "object")
    Object.assign(merged, schema.definitions);
  if (schema.$defs && typeof schema.$defs === "object")
    Object.assign(merged, schema.$defs);
  return Object.keys(merged).length > 0 ? merged : null;
}

function normalizeSchemaMap(node, defs, maxDepth) {
  if (maxDepth <= 0) return cloneMap(node);
  defs = mergeDefinitions(defs, extractDefinitions(node));
  const replaced = tryResolveRef(node, defs);
  if (replaced && typeof replaced === "object" && !Array.isArray(replaced))
    return normalizeSchemaMap(replaced, defs, maxDepth - 1);
  const normalized = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "definitions" || key === "$defs" || key === "nullable")
      continue;
    normalized[key] = normalizeSchemaValue(value, defs, maxDepth - 1);
  }
  simplifyNullableCombinator(normalized, "anyOf");
  simplifyNullableCombinator(normalized, "oneOf");
  normalizeTypeField(normalized);
  normalizeEnumField(normalized);
  if (normalized.const === null) delete normalized.const;
  return normalized;
}

function normalizeSchemaValue(value, defs, maxDepth) {
  if (value && typeof value === "object" && !Array.isArray(value))
    return normalizeSchemaMap(value, defs, maxDepth);
  if (Array.isArray(value))
    return value.map((item) => normalizeSchemaValue(item, defs, maxDepth));
  return value;
}

function mergeDefinitions(parent, local) {
  if (!parent) return local;
  if (!local) return parent;
  return { ...parent, ...local };
}

function tryResolveRef(node, defs) {
  if (!defs || typeof node.$ref !== "string" || Object.keys(node).length !== 1)
    return null;
  const prefix = node.$ref.startsWith("#/definitions/")
    ? "#/definitions/"
    : "#/$defs/";
  const name = node.$ref.startsWith(prefix)
    ? node.$ref.slice(prefix.length)
    : "";
  if (!name || !defs[name]) return null;
  const definition = defs[name];
  return typeof definition === "object" && !Array.isArray(definition)
    ? cloneMap(definition)
    : definition;
}

function simplifyNullableCombinator(schema, key) {
  const options = schema[key];
  if (!Array.isArray(options)) return;
  const filtered = options.filter((option) => !isNullSchema(option));
  if (filtered.length === 0) {
    delete schema[key];
    return;
  }
  if (
    filtered.length === 1 &&
    filtered[0] &&
    typeof filtered[0] === "object" &&
    !Array.isArray(filtered[0])
  ) {
    delete schema[key];
    Object.assign(schema, filtered[0]);
    return;
  }
  schema[key] = filtered;
}

function isNullSchema(schema) {
  return Boolean(
    schema &&
      typeof schema === "object" &&
      (schema.type === "null" ||
        schema.const === null ||
        (Array.isArray(schema.enum) &&
          schema.enum.length === 1 &&
          schema.enum[0] === null)),
  );
}

function normalizeTypeField(schema) {
  if (!Array.isArray(schema.type)) return;
  const nonNull = schema.type.filter(
    (type) => typeof type === "string" && type !== "null" && type.trim(),
  );
  if (nonNull.length === 0) delete schema.type;
  else schema.type = nonNull[0];
}

function normalizeEnumField(schema) {
  if (!Array.isArray(schema.enum)) return;
  const seen = new Set();
  schema.enum = schema.enum.filter((value) => {
    if (value === null) return false;
    const key = `${typeof value}:${JSON.stringify(value)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (schema.enum.length === 0) delete schema.enum;
}

module.exports = { normalizeToolSchemas };
