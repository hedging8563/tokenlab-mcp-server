#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const manifest = JSON.parse(await readFile(join(root, "generated/tools.json"), "utf8"));
const VERSION = packageJson.version;
const API_BASE = (process.env.TOKENLAB_API_BASE || "https://api.tokenlab.sh").replace(/\/+$/, "");
const API_KEY = process.env.TOKENLAB_API_KEY || "";
const TOOL_PROFILE = process.env.TOKENLAB_MCP_TOOL_PROFILE || manifest.default_profile;
const REQUEST_TIMEOUT_MS = positiveInteger(process.env.TOKENLAB_REQUEST_TIMEOUT_MS, 120_000);
const MAX_FILE_BYTES = positiveInteger(process.env.TOKENLAB_MCP_MAX_FILE_BYTES, 100 * 1024 * 1024);
const INLINE_BYTES = positiveInteger(process.env.TOKENLAB_MCP_INLINE_BYTES, 2 * 1024 * 1024);
const ARTIFACT_DIR = resolve(process.env.TOKENLAB_ARTIFACT_DIR || join(tmpdir(), "tokenlab-mcp"));

if (!manifest.profiles.includes(TOOL_PROFILE)) {
  throw new Error(`Unknown TOKENLAB_MCP_TOOL_PROFILE '${TOOL_PROFILE}'. Expected ${manifest.profiles.join(" or ")}.`);
}

const server = new McpServer({ name: "tokenlab", version: VERSION });

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function definedValues(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function textResult(value) {
  return {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }]
  };
}

function requireApiKey(tool) {
  if (tool.auth === "required" && !API_KEY) {
    throw new Error(`TOKENLAB_API_KEY is required for ${tool.name}.`);
  }
}

function appendQuery(url, name, value) {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) {
    for (const entry of value) appendQuery(url, name, entry);
    return;
  }
  url.searchParams.append(name, typeof value === "object" ? JSON.stringify(value) : String(value));
}

async function appendMultipart(form, name, value, isFile) {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) {
    for (const entry of value) await appendMultipart(form, name, entry, isFile);
    return;
  }
  if (!isFile) {
    form.append(name, typeof value === "object" ? JSON.stringify(value) : String(value));
    return;
  }

  const path = resolve(String(value));
  const details = await stat(path);
  if (!details.isFile()) throw new Error(`${name} must point to a local file.`);
  if (details.size > MAX_FILE_BYTES) {
    throw new Error(`${name} exceeds TOKENLAB_MCP_MAX_FILE_BYTES (${MAX_FILE_BYTES}).`);
  }
  const bytes = await readFile(path);
  form.append(name, new Blob([bytes]), basename(path));
}

function collectArguments(tool, input) {
  const pathArguments = Object.fromEntries(tool.bindings.path.map((name) => [name, input[name]]));
  const queryArguments = Object.fromEntries(tool.bindings.query.map((name) => [name, input[name]]));
  const headerArguments = Object.fromEntries(tool.bindings.header.map((name) => [name, input[name]]));
  const bodyArguments = tool.bindings.body.includes("body")
    ? input.body
    : Object.fromEntries(tool.bindings.body.map((name) => [name, input[name]]));
  return { pathArguments, queryArguments, headerArguments, bodyArguments };
}

function taskAwareResult(tool, response) {
  if (!tool.task || !response || typeof response !== "object") return textResult(response);

  const statusValue = response[tool.task.status_field];
  const status = typeof statusValue === "string" ? statusValue.toLowerCase() : undefined;
  const taskId = tool.task.id_fields.map((field) => response[field]).find((value) => typeof value === "string" && value);
  const pollUrlValue = response[tool.task.poll_url_field];
  const pollUrl = typeof pollUrlValue === "string" && pollUrlValue
    ? pollUrlValue
    : taskId ? `/v1/tasks/${encodeURIComponent(taskId)}` : undefined;
  const terminal = Boolean(status && tool.task.terminal_statuses.includes(status));
  const asyncDelivery = tool.task.mode !== "hybrid" || Boolean(taskId || pollUrl || status);

  return textResult({
    delivery: asyncDelivery
      ? definedValues({
          mode: "async",
          task_id: taskId,
          status,
          poll_url: pollUrl,
          terminal,
          next_tool: terminal ? undefined : "get_task_status"
        })
      : { mode: "complete", terminal: true },
    response
  });
}

function extensionFor(mimeType) {
  const known = {
    "audio/mpeg": ".mp3",
    "audio/wav": ".wav",
    "audio/ogg": ".ogg",
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "video/mp4": ".mp4",
    "application/json": ".json"
  };
  return known[mimeType] || ".bin";
}

async function artifactResult(bytes, mimeType, toolName) {
  if (bytes.byteLength <= INLINE_BYTES && mimeType.startsWith("image/")) {
    return { content: [{ type: "image", data: Buffer.from(bytes).toString("base64"), mimeType }] };
  }
  if (bytes.byteLength <= INLINE_BYTES && mimeType.startsWith("audio/")) {
    return { content: [{ type: "audio", data: Buffer.from(bytes).toString("base64"), mimeType }] };
  }

  await mkdir(ARTIFACT_DIR, { recursive: true });
  const digest = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  const path = join(ARTIFACT_DIR, `${toolName}-${digest}${extensionFor(mimeType)}`);
  await writeFile(path, bytes);
  return textResult({ artifact_path: path, mime_type: mimeType, bytes: bytes.byteLength });
}

async function executeGeneratedTool(tool, input) {
  requireApiKey(tool);
  const { pathArguments, queryArguments, headerArguments, bodyArguments } = collectArguments(tool, input);
  let path = tool.path;
  for (const [name, value] of Object.entries(pathArguments)) {
    path = path.replace(`{${name}}`, encodeURIComponent(String(value)));
  }

  const url = new URL(`${API_BASE}${path}`);
  for (const [name, value] of Object.entries(queryArguments)) appendQuery(url, name, value);

  const headers = {
    Accept: "application/json, audio/*, image/*, video/*, application/octet-stream",
    "User-Agent": `tokenlab-mcp-server/${VERSION}`
  };
  for (const [name, value] of Object.entries(headerArguments)) {
    if (value !== undefined) headers[name] = String(value);
  }
  if (API_KEY && tool.auth !== "none") headers.Authorization = `Bearer ${API_KEY}`;

  let body;
  if (tool.content_type === "application/json") {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(bodyArguments);
  } else if (tool.content_type === "multipart/form-data") {
    const form = new FormData();
    for (const [name, value] of Object.entries(bodyArguments || {})) {
      await appendMultipart(form, name, value, tool.bindings.files.includes(name));
    }
    body = form;
  }

  const response = await fetch(url, {
    method: tool.method,
    headers,
    body,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  const mimeType = (response.headers.get("content-type") || "application/octet-stream").split(";")[0].trim();

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 4_000);
    throw new Error(`TokenLab request failed: ${response.status} ${response.statusText}\n${detail}`);
  }

  if (mimeType === "application/json" || mimeType.endsWith("+json")) {
    const result = await response.json();
    const serialized = JSON.stringify(result);
    if (Buffer.byteLength(serialized) > INLINE_BYTES) {
      return artifactResult(Buffer.from(serialized), "application/json", tool.name);
    }
    return taskAwareResult(tool, result);
  }
  if (mimeType.startsWith("text/")) return textResult(await response.text());
  return artifactResult(Buffer.from(await response.arrayBuffer()), mimeType, tool.name);
}

const activeTools = manifest.tools.filter((tool) => tool.profiles.includes(TOOL_PROFILE));
for (const tool of activeTools) {
  const inputSchema = z.fromJSONSchema(tool.input_schema);
  server.registerTool(
    tool.name,
    {
      description: tool.description,
      inputSchema,
      annotations: tool.annotations,
      _meta: {
        "tokenlab/operationId": tool.operation_id,
        "tokenlab/method": tool.method,
        "tokenlab/path": tool.path,
        "tokenlab/contentType": tool.content_type,
        "tokenlab/contractSha256": manifest.source.sha256
      }
    },
    async (input) => executeGeneratedTool(tool, input)
  );
}

server.registerTool(
  "compare_models",
  {
    description: "Compare public TokenLab model details and pricing for several model IDs.",
    inputSchema: z.object({
      models: z.array(z.string().min(1)).min(2).max(8),
      include_raw: z.boolean().default(false)
    })
  },
  async ({ models, include_raw }) => {
    const compared = await Promise.all(models.map(async (model) => {
      const encoded = encodeURIComponent(model);
      const [details, pricing] = await Promise.all([
        executePublicJson(`/v1/models/${encoded}`),
        executePublicJson(`/v1/models/${encoded}/pricing`).catch((error) => ({ error: error.message }))
      ]);
      if (include_raw) return { model, details, pricing };
      return {
        id: details.id || details.model || model,
        request_endpoint: details.request_endpoint,
        request_shape_mode: details.request_shape_mode,
        supported_operations: details.supported_operations,
        supported_parameters: details.supported_parameters,
        recommended_request: details.recommended_request,
        pricing
      };
    }));
    return textResult({ compared });
  }
);

server.registerTool(
  "get_api_overview",
  {
    description: "Fetch TokenLab's agent-readable API overview.",
    inputSchema: z.object({})
  },
  async () => {
    const response = await fetch(`${API_BASE}/llms.txt`, {
      headers: { Accept: "text/plain", "User-Agent": `tokenlab-mcp-server/${VERSION}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    if (!response.ok) throw new Error(`TokenLab overview request failed: ${response.status} ${response.statusText}`);
    return textResult(await response.text());
  }
);

async function executePublicJson(path) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { Accept: "application/json", "User-Agent": `tokenlab-mcp-server/${VERSION}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`TokenLab request failed: ${response.status} ${response.statusText}\n${text.slice(0, 2_000)}`);
  return JSON.parse(text);
}

const transport = new StdioServerTransport();
await server.connect(transport);
