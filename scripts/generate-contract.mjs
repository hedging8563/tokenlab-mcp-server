#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const args = new Map();
for (let index = 0; index < argv.length; index += 1) {
  if (!argv[index].startsWith("--") || argv[index] === "--check") continue;
  args.set(argv[index], argv[index + 1]);
  index += 1;
}

const sourcePath = resolve(root, args.get("--source") || "contract/openapi.json");
const overlayPath = resolve(root, args.get("--overlay") || "contract/mcp-overlay.json");
const outputPath = resolve(root, args.get("--output") || "generated/tools.json");
const check = argv.includes("--check");

const [sourceText, overlayText] = await Promise.all([
  readFile(sourcePath, "utf8"),
  readFile(overlayPath, "utf8")
]);
const spec = JSON.parse(sourceText);
const overlay = JSON.parse(overlayText);

function snakeCase(value) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Za-z])(\d+)/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function getByPointer(pointer) {
  return pointer
    .replace(/^#\//, "")
    .split("/")
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"))
    .reduce((value, key) => value?.[key], spec);
}

function normalizeSchema(value, stack = []) {
  if (Array.isArray(value)) return value.map((entry) => normalizeSchema(entry, stack));
  if (!value || typeof value !== "object") return value;

  if (value.$ref) {
    if (stack.includes(value.$ref)) {
      return { type: "object", additionalProperties: true };
    }
    const target = getByPointer(value.$ref);
    if (!target) throw new Error(`Unresolved OpenAPI reference: ${value.$ref}`);
    const { $ref, ...rest } = value;
    return {
      ...normalizeSchema(target, [...stack, value.$ref]),
      ...normalizeSchema(rest, stack)
    };
  }

  const normalized = {};
  for (const [key, entry] of Object.entries(value)) {
    if (["example", "examples", "xml", "discriminator", "deprecated", "readOnly", "writeOnly"].includes(key)) continue;
    normalized[key] = normalizeSchema(entry, stack);
  }

  if (normalized.nullable === true) {
    delete normalized.nullable;
    return { anyOf: [normalized, { type: "null" }] };
  }

  return normalized;
}

function operationIndex() {
  const operations = new Map();
  for (const [path, pathItem] of Object.entries(spec.paths || {})) {
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
      if (!operation.operationId) throw new Error(`${method.toUpperCase()} ${path} has no operationId`);
      if (operations.has(operation.operationId)) throw new Error(`Duplicate operationId: ${operation.operationId}`);
      operations.set(operation.operationId, { path, pathItem, method: method.toUpperCase(), operation });
    }
  }
  return operations;
}

const operations = operationIndex();
const coreOperations = new Set(overlay.profiles.core.operations);
const fullTags = new Set(overlay.profiles.full.include_tags);
const fullExclusions = new Set(overlay.profiles.full.exclude_operations || []);
const publicAuth = new Set(overlay.public_auth_operations || []);

for (const operationId of coreOperations) {
  if (!operations.has(operationId)) throw new Error(`Core MCP operation is missing from OpenAPI: ${operationId}`);
}

function chooseContentTypes(operationId, operation, override) {
  const available = Object.keys(operation.requestBody?.content || {});
  if (available.length === 0) return [null];
  if (override.all_content_types) return available;
  if (override.content_type) {
    if (!available.includes(override.content_type)) {
      throw new Error(`${operationId} does not declare ${override.content_type}`);
    }
    return [override.content_type];
  }
  return [available.includes("application/json") ? "application/json" : available[0]];
}

function buildInputSchema(pathItem, operation, contentType) {
  const properties = {};
  const required = [];
  const bindings = { path: [], query: [], header: [], body: [], files: [] };
  const parameters = [...(pathItem.parameters || []), ...(operation.parameters || [])]
    .map((parameter) => normalizeSchema(parameter));

  for (const parameter of parameters) {
    if (!["path", "query", "header"].includes(parameter.in)) continue;
    if (properties[parameter.name]) throw new Error(`Duplicate MCP argument: ${parameter.name}`);
    properties[parameter.name] = {
      ...normalizeSchema(parameter.schema || { type: "string" }),
      ...(parameter.description ? { description: parameter.description } : {})
    };
    bindings[parameter.in].push(parameter.name);
    if (parameter.required) required.push(parameter.name);
  }

  if (contentType) {
    const media = operation.requestBody.content[contentType];
    const bodySchema = normalizeSchema(media.schema || { type: "object", additionalProperties: true });
    if (bodySchema.type === "object" || bodySchema.properties) {
      for (const [name, schema] of Object.entries(bodySchema.properties || {})) {
        if (properties[name]) throw new Error(`MCP argument collision for ${operation.operationId}: ${name}`);
        const property = structuredClone(schema);
        const binaryNodes = [];
        const visit = (value) => {
          if (Array.isArray(value)) {
            value.forEach(visit);
            return;
          }
          if (!value || typeof value !== "object") return;
          if (value.format === "binary") {
            delete value.format;
            value.type = "string";
            binaryNodes.push(value);
          }
          Object.values(value).forEach(visit);
        };
        visit(property);
        if (binaryNodes.length > 0) {
          property.description = `${property.description ? `${property.description} ` : ""}Pass local file path${binaryNodes.length > 1 || property.type === "array" ? "s" : ""}.`;
          bindings.files.push(name);
        }
        properties[name] = property;
        bindings.body.push(name);
      }
      for (const name of bodySchema.required || []) required.push(name);
    } else {
      properties.body = bodySchema;
      bindings.body.push("body");
      if (operation.requestBody.required) required.push("body");
    }
  }

  return {
    schema: {
      type: "object",
      properties,
      ...(required.length > 0 ? { required: [...new Set(required)] } : {}),
      additionalProperties: false
    },
    bindings
  };
}

function applyInputOverrides(schema, bindings, override) {
  for (const name of override.omit_arguments || []) {
    if (!schema.properties[name]) throw new Error(`Cannot omit unknown MCP argument: ${name}`);
    delete schema.properties[name];
    if (schema.required) schema.required = schema.required.filter((entry) => entry !== name);
    for (const binding of Object.values(bindings)) {
      const index = binding.indexOf(name);
      if (index >= 0) binding.splice(index, 1);
    }
  }
  for (const [name, patch] of Object.entries(override.input_property_overrides || {})) {
    if (!schema.properties[name]) throw new Error(`Cannot override unknown MCP argument: ${name}`);
    schema.properties[name] = { ...schema.properties[name], ...patch };
  }
}

function annotations(method) {
  return {
    readOnlyHint: method === "GET",
    destructiveHint: method === "DELETE",
    idempotentHint: ["GET", "PUT", "DELETE"].includes(method),
    openWorldHint: true
  };
}

const tools = [];
for (const [operationId, indexed] of operations) {
  const tags = indexed.operation.tags || [];
  const inCore = coreOperations.has(operationId);
  const inFull = !fullExclusions.has(operationId) && tags.some((tag) => fullTags.has(tag));
  if (!inCore && !inFull) continue;

  const override = overlay.operation_overrides[operationId] || {};
  const contentTypes = chooseContentTypes(operationId, indexed.operation, override);
  for (const contentType of contentTypes) {
    const suffix = contentTypes.length > 1 && contentType !== "application/json"
      ? `_${contentType.split("/").at(-1).replace(/[^A-Za-z0-9]+/g, "_")}`
      : "";
    const toolName = override.tool_names_by_content_type?.[contentType]
      || `${override.tool_name || snakeCase(operationId)}${suffix}`;
    const { schema, bindings } = buildInputSchema(indexed.pathItem, indexed.operation, contentType);
    applyInputOverrides(schema, bindings, override);
    const description = [indexed.operation.summary, indexed.operation.description]
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

    tools.push({
      name: toolName,
      operation_id: operationId,
      method: indexed.method,
      path: indexed.path,
      content_type: contentType,
      auth: publicAuth.has(operationId) ? "optional" : "required",
      tags,
      profiles: [...(inCore ? ["core"] : []), ...(inFull ? ["full"] : [])],
      description,
      input_schema: schema,
      bindings,
      annotations: annotations(indexed.method),
      ...(override.task ? { task: override.task } : {})
    });
  }
}

tools.sort((left, right) => left.name.localeCompare(right.name));
const duplicateNames = tools.filter((tool, index) => tools.findIndex((candidate) => candidate.name === tool.name) !== index);
if (duplicateNames.length > 0) throw new Error(`Duplicate MCP tool names: ${duplicateNames.map((tool) => tool.name).join(", ")}`);

const manifest = {
  schema_version: 1,
  generated_at: null,
  source: {
    url: overlay.openapi_url,
    openapi: spec.openapi,
    title: spec.info?.title,
    version: spec.info?.version,
    sha256: createHash("sha256").update(sourceText).digest("hex")
  },
  default_profile: overlay.default_profile,
  profiles: Object.keys(overlay.profiles),
  tool_count: tools.length,
  tools
};
const output = `${JSON.stringify(manifest, null, 2)}\n`;

if (check) {
  const existing = await readFile(outputPath, "utf8");
  if (existing !== output) {
    console.error("Generated MCP contract is stale. Run npm run contract:generate.");
    process.exit(1);
  }
  console.log(`[contract] PASS (${tools.length} generated tools)`);
} else {
  await writeFile(outputPath, output);
  console.log(`[contract] generated ${tools.length} tools at ${outputPath}`);
}
