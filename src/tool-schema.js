const DRAFT_07_SCHEMA = "http://json-schema.org/draft-07/schema#";
const PORTABLE_PROPERTY_DEPTH = 3;
const MAX_DESCRIPTION_LENGTH = 500;
const MAX_STRICT_DESCRIPTION_LENGTH = 160;

export const TOOL_SCHEMA_MODES = ["exact", "portable", "strict"];

function compactDescription(value, maxLength = MAX_DESCRIPTION_LENGTH) {
  if (typeof value !== "string") return undefined;
  return value.length <= maxLength
    ? value
    : `${value.slice(0, maxLength - 1)}…`;
}

function portableScalarSchema(schema) {
  const projected = {};
  for (const key of [
    "type",
    "format",
    "enum",
    "const",
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "multipleOf",
    "minLength",
    "maxLength",
    "pattern"
  ]) {
    if (Object.hasOwn(schema, key)) projected[key] = structuredClone(schema[key]);
  }
  const description = compactDescription(schema.description);
  if (description) projected.description = description;
  return Object.keys(projected).length > 0 ? projected : {};
}

function portableSchemaNode(schema, propertyDepth) {
  if (Array.isArray(schema)) {
    return schema.map((entry) => portableSchemaNode(entry, propertyDepth));
  }
  if (!schema || typeof schema !== "object") return schema;

  const description = compactDescription(schema.description);
  if (propertyDepth >= PORTABLE_PROPERTY_DEPTH) {
    const types = Array.isArray(schema.type)
      ? schema.type
      : schema.type ? [schema.type] : [];
    if (types.includes("object") || schema.properties || schema.additionalProperties) {
      return {
        type: "object",
        ...(description ? { description } : {})
      };
    }
    if (types.includes("array") || schema.items) {
      return {
        type: "array",
        items: {},
        ...(description ? { description } : {})
      };
    }
    return portableScalarSchema(schema);
  }

  const projected = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "$schema") {
      continue;
    }
    if (key === "description") {
      if (description) projected.description = description;
      continue;
    }
    if (key === "properties") {
      projected.properties = Object.fromEntries(
        Object.entries(value).map(([name, property]) => [
          name,
          portableSchemaNode(property, propertyDepth + 1)
        ])
      );
      continue;
    }
    if (key === "items") {
      projected.items = portableSchemaNode(value, propertyDepth + 1);
      continue;
    }
    if (["oneOf", "anyOf", "allOf"].includes(key)) {
      projected[key] = value.map((entry) => portableSchemaNode(entry, propertyDepth + 1));
      continue;
    }
    projected[key] = structuredClone(value);
  }
  return projected;
}

function isSimpleScalarSchema(schema) {
  return Boolean(
    schema
    && typeof schema === "object"
    && !Array.isArray(schema)
    && ["string", "number", "integer", "boolean"].includes(schema.type)
    && !schema.oneOf
    && !schema.anyOf
    && !schema.allOf
  );
}

function strictScalarSchema(schema) {
  const projected = portableScalarSchema(schema);
  const description = compactDescription(schema.description, MAX_STRICT_DESCRIPTION_LENGTH);
  if (description) projected.description = description;
  else delete projected.description;
  delete projected.default;
  return projected;
}

function strictPropertySchema(schema, optional) {
  const description = compactDescription(schema?.description, MAX_STRICT_DESCRIPTION_LENGTH);
  const valueSchema = isSimpleScalarSchema(schema)
    ? strictScalarSchema(schema)
    : {
        type: "string",
        description: [
          "JSON-encoded value.",
          description
        ].filter(Boolean).join(" ")
      };
  if (!optional) return valueSchema;
  return {
    anyOf: [
      valueSchema,
      { type: "null" }
    ]
  };
}

function strictToolSchema(schema) {
  const properties = schema?.properties || {};
  const originallyRequired = new Set(schema?.required || []);
  return {
    type: "object",
    properties: Object.fromEntries(
      Object.entries(properties).map(([name, property]) => [
        name,
        strictPropertySchema(property, !originallyRequired.has(name))
      ])
    ),
    required: Object.keys(properties),
    additionalProperties: false
  };
}

export function withDraft07(schema) {
  return {
    $schema: DRAFT_07_SCHEMA,
    ...schema
  };
}

export function projectToolInputSchema(schema, mode) {
  if (!TOOL_SCHEMA_MODES.includes(mode)) {
    throw new Error(`Unknown MCP tool schema mode '${mode}'. Expected ${TOOL_SCHEMA_MODES.join(" or ")}.`);
  }
  if (mode === "exact") return structuredClone(schema);
  if (mode === "strict") return strictToolSchema(schema);
  return portableSchemaNode(schema, 0);
}

export function normalizeToolInputForSchemaMode(input, schema, mode) {
  if (mode !== "strict") return { ...input };
  const normalized = { ...input };
  const required = new Set(schema.required || []);
  for (const [name, property] of Object.entries(schema.properties || {})) {
    if (!Object.hasOwn(normalized, name)) continue;
    if (normalized[name] === null && !required.has(name)) {
      delete normalized[name];
      continue;
    }
    if (isSimpleScalarSchema(property) || typeof normalized[name] !== "string") continue;
    try {
      normalized[name] = JSON.parse(normalized[name]);
    } catch {
      // A canonical union may accept a plain string as-is.
    }
  }
  return normalized;
}

export function schemaDepth(value, depth = 0) {
  if (!value || typeof value !== "object") return depth;
  return Object.values(value).reduce(
    (maximum, entry) => Math.max(maximum, schemaDepth(entry, depth + 1)),
    depth
  );
}

export function schemaBytes(schema) {
  return Buffer.byteLength(JSON.stringify(schema));
}

export function findProviderIncompatibleLiterals(schema, path = "$", findings = []) {
  if (!schema || typeof schema !== "object") return findings;
  if (Object.hasOwn(schema, "const") && typeof schema.const !== "string") {
    findings.push({ path, keyword: "const", value: schema.const });
  }
  if (Array.isArray(schema.enum) && schema.enum.some((entry) => typeof entry !== "string")) {
    findings.push({ path, keyword: "enum", value: schema.enum });
  }
  for (const [key, value] of Object.entries(schema)) {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => findProviderIncompatibleLiterals(entry, `${path}.${key}[${index}]`, findings));
    } else {
      findProviderIncompatibleLiterals(value, `${path}.${key}`, findings);
    }
  }
  return findings;
}
