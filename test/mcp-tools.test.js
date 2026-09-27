import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { GoogleGenerativeAILanguageModel } from "@ai-sdk/google/internal";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  findProviderIncompatibleLiterals,
  projectToolInputSchema,
  schemaDepth
} from "../src/tool-schema.js";

const manifest = JSON.parse(await readFile(new URL("../generated/tools.json", import.meta.url), "utf8"));
const publicContract = JSON.parse(await readFile(new URL("../generated/public-contract.json", import.meta.url), "utf8"));

async function startMockApi(t, respond = () => ({ ok: true })) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks);
    const contentType = request.headers["content-type"] || "";
    const body = rawBody.length > 0 && contentType.startsWith("application/json")
      ? JSON.parse(rawBody.toString("utf8"))
      : undefined;
    const received = {
      method: request.method,
      url: request.url,
      headers: request.headers,
      authorization: request.headers.authorization,
      contentType,
      body,
      rawBody
    };
    requests.push(received);

    const result = await respond(received);
    const status = typeof result?.status === "number" ? result.status : 200;
    if (Buffer.isBuffer(result?.rawBody)) {
      response.writeHead(status, result.headers || { "Content-Type": "application/octet-stream" });
      response.end(result.rawBody);
      return;
    }
    response.writeHead(status, { "Content-Type": "application/json", ...(result?.headers || {}) });
    response.end(JSON.stringify(result?.json ?? result));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, requests };
}

async function startMcpClient(t, env = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/index.js"],
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stderr: "pipe"
  });
  const client = new Client({ name: "tokenlab-mcp-test", version: "0.0.0" });

  await client.connect(transport);
  t.after(() => client.close());
  return client;
}

function parseTextResult(result) {
  assert.equal(result.isError, undefined);
  assert.equal(result.content[0].type, "text");
  const parsed = JSON.parse(result.content[0].text);
  assert.deepEqual(result.structuredContent, parsed);
  return parsed;
}

test("advertises exactly the generated profile plus composite discovery tools", async (t) => {
  for (const profile of manifest.profiles) {
    await t.test(profile, async (t) => {
      const client = await startMcpClient(t, { TOKENLAB_MCP_TOOL_PROFILE: profile });
      const listed = await client.listTools();
      const { tools } = listed;
      const actual = tools.map((tool) => tool.name).sort();
      const expected = manifest.tools
        .filter((tool) => tool.profiles.includes(profile))
        .map((tool) => tool.name)
        .concat("compare_models", "get_api_overview")
        .sort();
      assert.deepEqual(actual, expected);

      const schemaMode = manifest.profile_config[profile].schema_mode;
      const generatedByName = new Map(
        manifest.tools
          .filter((tool) => tool.profiles.includes(profile))
          .map((tool) => [tool.name, tool])
      );
      for (const tool of tools) {
        assert.equal(typeof tool.title, "string", `${tool.name} must expose a title`);
        assert.equal(typeof tool.annotations?.readOnlyHint, "boolean", `${tool.name} must expose risk annotations`);
        assert.match(tool.name, /^[A-Za-z][A-Za-z0-9_]{0,63}$/, `${tool.name} must work across provider name limits`);
        assert.deepEqual(
          findProviderIncompatibleLiterals(tool.inputSchema),
          [],
          `${tool.name} must not expose booleans or numbers through enum/const`
        );
        const generated = generatedByName.get(tool.name);
        if (generated) {
          assert.deepEqual(
            tool.inputSchema,
            projectToolInputSchema(generated.input_schema, schemaMode),
            `${tool.name} must expose the generated ${schemaMode} schema without runtime conversion drift`
          );
        }
      }
      assert.ok(
        Buffer.byteLength(JSON.stringify(listed))
          <= manifest.profile_config[profile].compatibility_budget.max_tools_list_bytes,
        `${profile} tools/list must remain inside its compatibility byte budget`
      );
      assert.ok(
        Math.max(...tools.map((tool) => schemaDepth(tool.inputSchema)))
          <= manifest.profile_config[profile].compatibility_budget.max_input_schema_depth,
        `${profile} tools/list must remain inside its compatibility depth budget`
      );
    });
  }

  assert.deepEqual(publicContract.profiles.catalog.tool_names, [
    "compare_models",
    "get_api_overview",
    "get_model",
    "get_model_pricing",
    "get_pricing",
    "list_models"
  ]);

  const requiredCoreFamilies = [
    "create_chat_completion",
    "create_response",
    "create_anthropic_message",
    "create_gemini_content",
    "create_image",
    "edit_image_file",
    "create_video",
    "create_music",
    "create_3d_model",
    "create_speech",
    "transcribe_audio",
    "create_embedding",
    "rerank_documents",
    "upload_file",
    "get_task_status"
  ];
  const core = new Set(manifest.tools.filter((tool) => tool.profiles.includes("core")).map((tool) => tool.name));
  for (const tool of requiredCoreFamilies) assert.equal(core.has(tool), true, `${tool} must remain in core`);

  const byName = Object.fromEntries(manifest.tools.map((tool) => [tool.name, tool]));
  assert.equal(byName.list_models.input_schema.properties.view.default, "compact");
  assert.deepEqual(byName.list_models.default_arguments, { view: "compact" });
  assert.deepEqual(byName.list_models.bindings.query, ["provider", "tag", "category", "recommended_for", "view"]);
  for (const oldTool of [
    "create_seedance_visual_validation_session",
    "bind_seedance_visual_validation_result",
    "list_seedance_visual_validation_history"
  ]) {
    assert.equal(byName[oldTool], undefined, `${oldTool} must be removed with the retired v1 contract`);
  }
  assert.deepEqual(byName.create_visual_validate_session.default_arguments, {
    Action: "CreateVisualValidateSession",
    Version: "2024-01-01"
  });
  assert.deepEqual(byName.create_visual_validate_session.bindings, {
    path: [],
    query: ["Action", "Version"],
    header: ["X-TokenLab-Delivery-Policy"],
    body: ["CallbackURL", "ProjectName"],
    files: []
  });
  assert.deepEqual(Object.keys(byName.create_visual_validate_session.input_schema.properties), ["X-TokenLab-Delivery-Policy", "CallbackURL", "ProjectName"]);
  assert.deepEqual(byName.create_visual_validate_session.input_schema.required, ["CallbackURL"]);
  assert.deepEqual(byName.get_visual_validate_result.default_arguments, {
    Action: "GetVisualValidateResult",
    Version: "2024-01-01"
  });
  assert.deepEqual(Object.keys(byName.get_visual_validate_result.input_schema.properties), ["X-TokenLab-Delivery-Policy", "BytedToken", "ProjectName"]);
  assert.deepEqual(byName.get_visual_validate_result.input_schema.required, ["BytedToken"]);
  assert.equal(byName.get_visual_validate_result.annotations.idempotentHint, true);
  assert.equal(byName.create_gemini_content.input_schema.properties.key, undefined);
  for (const name of [
    "compact_response",
    "create_chat_completion",
    "create_response",
    "create_anthropic_message",
    "create_image",
    "create_image_file",
    "edit_image",
    "edit_image_file",
    "retrieve_response"
  ]) {
    assert.equal(byName[name].input_schema.properties.stream, undefined, `${name} must not expose stream to providers`);
    assert.equal(byName[name].default_arguments.stream, false, `${name} must remain non-streaming at execution`);
  }
  for (const name of ["create_image", "create_image_file", "edit_image", "edit_image_file"]) {
    assert.equal(byName[name].input_schema.properties.partial_images, undefined, `${name} must not expose partial_images`);
    assert.equal(byName[name].input_schema.properties.input_fidelity, undefined, `${name} must not expose input_fidelity`);
  }
  for (const tool of manifest.tools) {
    const exposedSecret = Object.keys(tool.input_schema.properties).find((name) => /api.?key|authorization|password|secret/i.test(name));
    assert.equal(exposedSecret, undefined, `${tool.name} must not expose credential arguments`);
  }
  for (const toolName of publicContract.profiles.catalog.tool_names) {
    assert.equal(publicContract.profiles.core.tool_names.includes(toolName), true, `core must include catalog tool ${toolName}`);
  }
  for (const toolName of publicContract.profiles.core.tool_names) {
    assert.equal(publicContract.profiles.full.tool_names.includes(toolName), true, `full must include core tool ${toolName}`);
  }

  assert.deepEqual(publicContract.features.live_model_contract, {
    tool: "get_model",
    endpoint: "/v1/models/{model}",
    fields: [
      "supported_operations",
      "supported_parameters",
      "request_endpoint",
      "request_endpoint_by_operation",
      "request_shape_mode",
      "operation_constraints",
      "recommended_request"
    ]
  });
});

test("exact schema mode publishes canonical JSON Schema without a Zod round trip", async (t) => {
  const client = await startMcpClient(t, {
    TOKENLAB_MCP_TOOL_PROFILE: "full",
    TOKENLAB_MCP_SCHEMA_MODE: "exact"
  });
  const { tools } = await client.listTools();
  const actualByName = new Map(tools.map((tool) => [tool.name, tool.inputSchema]));

  for (const generated of manifest.tools.filter((tool) => tool.profiles.includes("full"))) {
    assert.deepEqual(
      actualByName.get(generated.name),
      generated.input_schema,
      `${generated.name} exact schema must equal the generated canonical schema`
    );
  }
  assert.equal(
    actualByName.get("create_anthropic_message").properties.metadata.additionalProperties,
    true,
    "open objects must remain open"
  );
  assert.equal(
    actualByName.get("create_chat_completion").properties.max_tokens.maximum,
    undefined,
    "unbounded integers must not acquire JavaScript safe-integer bounds"
  );
});

test("strict schema mode remains provider-valid and decodes canonical arguments", async (t) => {
  const api = await startMockApi(t, ({ method, url }) => {
    if (method === "GET" && url.endsWith("/pricing")) {
      return { model: url.split("/").at(-2), pricing_unit: "per_token" };
    }
    if (method === "GET" && url.startsWith("/v1/models/")) {
      return { id: url.split("/").at(-1), tokenlab: {} };
    }
    return { ok: true };
  });
  const client = await startMcpClient(t, {
    TOKENLAB_API_BASE: api.baseUrl,
    TOKENLAB_API_KEY: "test-key",
    TOKENLAB_MCP_TOOL_PROFILE: "full",
    TOKENLAB_MCP_SCHEMA_MODE: "strict"
  });
  const listed = await client.listTools();
  const { tools } = listed;

  assert.equal(tools.length, 89);
  assert.ok(
    Buffer.byteLength(JSON.stringify(listed)) <= manifest.profile_config.full.compatibility_budget.max_tools_list_bytes,
    "full strict tools/list must remain inside its compatibility byte budget"
  );
  for (const tool of tools) {
    const schema = tool.inputSchema;
    assert.equal(schema.type, "object", `${tool.name} must have an object input`);
    assert.equal(schema.additionalProperties, false, `${tool.name} must be closed in strict mode`);
    assert.deepEqual(
      [...schema.required].sort(),
      Object.keys(schema.properties).sort(),
      `${tool.name} must mark every strict-mode property as required`
    );
    assert.equal("$schema" in schema, false, `${tool.name} must not send an unsupported dialect annotation`);
    assert.doesNotMatch(JSON.stringify(schema), /"oneOf"|"allOf"/, `${tool.name} must use the strict subset`);
    assert.deepEqual(
      findProviderIncompatibleLiterals(schema),
      [],
      `${tool.name} must not expose non-string enum or const values`
    );
    assert.ok(schemaDepth(schema) <= 6, `${tool.name} strict schema must remain shallow`);
  }

  const anthropic = manifest.tools.find((tool) => tool.name === "create_anthropic_message");
  const strictArguments = Object.fromEntries(
    Object.keys(anthropic.input_schema.properties).map((name) => [name, null])
  );
  Object.assign(strictArguments, {
    model: "claude-sonnet-5",
    max_tokens: 128,
    messages: JSON.stringify([{ role: "user", content: "Hello" }])
  });
  const generatedResult = await client.callTool({
    name: anthropic.name,
    arguments: strictArguments
  });
  assert.equal(generatedResult.isError, undefined, generatedResult.content?.[0]?.text);
  assert.deepEqual(api.requests[0].body, {
    model: "claude-sonnet-5",
    max_tokens: 128,
    messages: [{ role: "user", content: "Hello" }],
    stream: false
  });

  const compared = parseTextResult(await client.callTool({
    name: "compare_models",
    arguments: {
      models: JSON.stringify(["model-a", "model-b"]),
      include_raw: null
    }
  }));
  assert.deepEqual(compared.compared.map((entry) => entry.id), ["model-a", "model-b"]);
});

test("survives the OpenCode Google AI SDK tool conversion used by Gemini", async (t) => {
  const client = await startMcpClient(t, { TOKENLAB_MCP_TOOL_PROFILE: "full" });
  const listed = await client.listTools();
  let requestBody;
  const model = new GoogleGenerativeAILanguageModel("gemini-3-flash-preview", {
    provider: "google.generative-ai",
    baseURL: "https://example.test/v1beta",
    headers: () => ({ "x-goog-api-key": "test" }),
    generateId: () => "test-id",
    fetch: async (_url, init) => {
      requestBody = JSON.parse(init.body);
      return new Response(JSON.stringify({
        candidates: [{
          content: { role: "model", parts: [{ text: "ok" }] },
          finishReason: "STOP"
        }],
        usageMetadata: {
          promptTokenCount: 1,
          candidatesTokenCount: 1,
          totalTokenCount: 2
        }
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });

  await model.doGenerate({
    prompt: [{ role: "user", content: [{ type: "text", text: "test" }] }],
    tools: listed.tools.map((tool) => ({
      type: "function",
      name: `tokenlab_${tool.name}`,
      description: tool.description,
      inputSchema: tool.inputSchema
    })),
    toolChoice: { type: "auto" }
  });

  const declarations = requestBody.tools[0].functionDeclarations;
  assert.equal(declarations.length, 89);
  assert.ok(
    Buffer.byteLength(JSON.stringify(requestBody.tools)) <= 85_000,
    "Gemini function declarations must remain inside the tested portable payload budget"
  );
  assert.ok(
    Math.max(...declarations.map((tool) => schemaDepth(tool.parameters))) <= 8,
    "Gemini-converted schemas must remain shallow"
  );
  for (const declaration of declarations) {
    assert.ok(declaration.name.length <= 64, `${declaration.name} must remain portable to 64-character providers`);
    assert.deepEqual(
      findProviderIncompatibleLiterals(declaration.parameters),
      [],
      `${declaration.name} must not contain the boolean enum shape rejected by Gemini`
    );
    assert.equal(
      declaration.parameters?.properties?.stream,
      undefined,
      `${declaration.name} must not expose the fixed stream argument`
    );
  }
});

test("compare_models reads the live nested model request contract", async (t) => {
  const api = await startMockApi(t, ({ url }) => {
    if (url === "/v1/models/pixverse-v6") {
      return {
        id: "pixverse-v6",
        tokenlab: {
          supported_operations: ["text-to-video", "image-to-video"],
          request_format_details: {
            request_endpoint: "/v1/videos/generations",
            request_endpoint_by_operation: {
              "text-to-video": "/v1/videos/generations",
              "image-to-video": "/v1/videos/generations"
            },
            request_shape_mode: "json_url",
            supported_parameters: ["prompt", "image_url", "operation"],
            operation_constraints: [{ operation: "image-to-video", allowed_resolutions: ["720p"] }],
            recommended_request: { operation: "text-to-video", resolution: "720p" }
          }
        }
      };
    }
    if (url === "/v1/models/happyhorse-1.0") {
      return {
        id: "happyhorse-1.0",
        tokenlab: {
          request_format_summary: {
            public_operations: ["video-to-video"],
            request_endpoint: "/v1/videos/generations",
            supported_parameters: ["video_url", "operation"]
          }
        }
      };
    }
    if (url.endsWith("/pricing")) return { model: url.split("/").at(-2), pricing_unit: "per_second" };
    return { status: 404 };
  });
  const client = await startMcpClient(t, { TOKENLAB_API_BASE: api.baseUrl });

  const compared = parseTextResult(await client.callTool({
    name: "compare_models",
    arguments: { models: ["pixverse-v6", "happyhorse-1.0"] }
  }));

  assert.deepEqual(compared.compared[0], {
    id: "pixverse-v6",
    request_endpoint: "/v1/videos/generations",
    request_endpoint_by_operation: {
      "text-to-video": "/v1/videos/generations",
      "image-to-video": "/v1/videos/generations"
    },
    request_shape_mode: "json_url",
    supported_operations: ["text-to-video", "image-to-video"],
    supported_parameters: ["prompt", "image_url", "operation"],
    operation_constraints: [{ operation: "image-to-video", allowed_resolutions: ["720p"] }],
    recommended_request: { operation: "text-to-video", resolution: "720p" },
    pricing: { model: "pixverse-v6", pricing_unit: "per_second" }
  });
  assert.deepEqual(compared.compared[1].supported_operations, ["video-to-video"]);
  assert.deepEqual(compared.compared[1].supported_parameters, ["video_url", "operation"]);
});

test("publishes resources, prompts, and a self-consistent public contract", async (t) => {
  const client = await startMcpClient(t, { TOKENLAB_MCP_TOOL_PROFILE: "catalog" });
  const { resources } = await client.listResources();
  const { prompts } = await client.listPrompts();

  assert.deepEqual(
    resources.map((resource) => resource.name).sort(),
    publicContract.features.resources.map((resource) => resource.name).sort()
  );
  assert.deepEqual(
    prompts.map((prompt) => prompt.name).sort(),
    publicContract.features.prompts.map((prompt) => prompt.name).sort()
  );

  const contractResource = await client.readResource({ uri: "tokenlab://contract/mcp" });
  assert.equal(contractResource.contents[0].mimeType, "application/json");
  assert.deepEqual(JSON.parse(contractResource.contents[0].text), publicContract);

  const openApiResource = await client.readResource({ uri: "tokenlab://contract/openapi" });
  const openApi = JSON.parse(openApiResource.contents[0].text);
  assert.equal(openApi.openapi, manifest.source.openapi);
  assert.doesNotMatch(
    JSON.stringify({ openApi, manifest, publicContract }),
    /lemondata/i,
    "published MCP contracts must not expose the retired LemonData compatibility surface"
  );

  const prompt = await client.getPrompt({
    name: "choose_tokenlab_model",
    arguments: { task: "Generate a product image", priorities: "quality and price" }
  });
  assert.match(prompt.messages[0].content.text, /live MCP catalog tools/);
  assert.match(prompt.messages[0].content.text, /quality and price/);

  for (const [profile, summary] of Object.entries(publicContract.profiles)) {
    const endpointCount = manifest.tools.filter((tool) => tool.profiles.includes(profile)).length;
    assert.equal(summary.endpoint_tools, endpointCount);
    assert.equal(summary.total_tools, summary.endpoint_tools + summary.composite_tools);
  }
});

test("forwards generated JSON tools to their canonical public endpoints", async (t) => {
  const api = await startMockApi(t);
  const client = await startMcpClient(t, {
    TOKENLAB_API_BASE: api.baseUrl,
    TOKENLAB_API_KEY: "test-key"
  });

  const calls = [
    ["create_response", { model: "gpt-5.5", input: "Hello" }],
    ["create_anthropic_message", {
      model: "claude-sonnet-5",
      max_tokens: 128,
      messages: [{ role: "user", content: "Hello" }]
    }],
    ["create_gemini_content", {
      model: "gemini-3.5-flash",
      contents: [{ role: "user", parts: [{ text: "Hello" }] }]
    }],
    ["create_video", { model: "video-model", prompt: "Orbit a cube" }],
    ["create_music", { model: "music-model", prompt: "Ambient synth" }],
    ["create_3d_model", { model: "3d-model", prompt: "A red cube" }],
    ["create_embedding", { model: "embedding-model", input: ["red", "blue"] }],
    ["rerank_documents", { model: "rerank-model", query: "cube", documents: ["sphere", "cube"] }],
    ["translate_text", { model: "translation-model", text: "Hello", target_language: "zh" }]
  ];
  for (const [name, arguments_] of calls) {
    const result = await client.callTool({ name, arguments: arguments_ });
    assert.equal(result.isError, undefined, `${name}: ${result.content?.[0]?.text}`);
  }

  assert.deepEqual(api.requests.map((request) => [request.method, request.url]), [
    ["POST", "/v1/responses"],
    ["POST", "/v1/messages"],
    ["POST", "/v1beta/models/gemini-3.5-flash:generateContent"],
    ["POST", "/v1/videos/generations"],
    ["POST", "/v1/music/generations"],
    ["POST", "/v1/3d/generations"],
    ["POST", "/v1/embeddings"],
    ["POST", "/v1/rerank"],
    ["POST", "/v1/translations"]
  ]);
  assert.equal(api.requests.every((request) => request.authorization === "Bearer test-key"), true);
  assert.equal(api.requests[0].body.stream, false);
  assert.equal(api.requests[1].body.messages[0].content, "Hello");
  assert.equal(api.requests[2].body.contents[0].parts[0].text, "Hello");
});

test("keeps hidden stream false backward-compatible and rejects stream true locally", async (t) => {
  const api = await startMockApi(t);
  const client = await startMcpClient(t, {
    TOKENLAB_API_BASE: api.baseUrl,
    TOKENLAB_API_KEY: "test-key"
  });

  const compatible = await client.callTool({
    name: "create_response",
    arguments: { model: "gpt-5.5", input: "Hello", stream: false }
  });
  const invalid = await client.callTool({
    name: "create_response",
    arguments: { model: "gpt-5.5", input: "Hello", stream: true }
  });

  assert.equal(compatible.isError, undefined);
  assert.equal(api.requests[0].body.stream, false);
  assert.equal(invalid.isError, true);
  assert.match(invalid.content[0].text, /additional properties/);
  assert.equal(api.requests.length, 1);
});

test("normalizes byte-provable generic image data URLs before chat forwarding", async (t) => {
  const api = await startMockApi(t);
  const client = await startMcpClient(t, {
    TOKENLAB_API_BASE: api.baseUrl,
    TOKENLAB_API_KEY: "test-key"
  });
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64");
  const originalUrl = `data:application/octet-stream;base64,${png}`;
  const arguments_ = {
    model: "gemini-3.5-flash",
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "Describe this image" },
        { type: "image_url", image_url: { url: originalUrl } }
      ]
    }]
  };

  const result = await client.callTool({ name: "create_chat_completion", arguments: arguments_ });

  assert.equal(result.isError, undefined, result.content?.[0]?.text);
  assert.equal(api.requests.length, 1);
  assert.equal(
    api.requests[0].body.messages[0].content[1].image_url.url,
    `data:image/png;base64,${png}`
  );
  assert.equal(arguments_.messages[0].content[1].image_url.url, originalUrl, "normalization must not mutate caller input");
});

test("rejects unrecognized generic image data URLs before calling TokenLab", async (t) => {
  const api = await startMockApi(t);
  const client = await startMcpClient(t, {
    TOKENLAB_API_BASE: api.baseUrl,
    TOKENLAB_API_KEY: "test-key"
  });
  const opaque = Buffer.from("not an image").toString("base64");

  const result = await client.callTool({
    name: "create_chat_completion",
    arguments: {
      model: "gemini-3.5-flash",
      messages: [{
        role: "user",
        content: [{
          type: "image_url",
          image_url: { url: `data:application/octet-stream;base64,${opaque}` }
        }]
      }]
    }
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /not a recognized PNG, JPEG, WebP, or GIF image/);
  assert.equal(api.requests.length, 0);
});

test("forwards official-shape visual validation Action tools", async (t) => {
  const api = await startMockApi(t);
  const client = await startMcpClient(t, {
    TOKENLAB_API_BASE: api.baseUrl,
    TOKENLAB_API_KEY: "test-key",
    TOKENLAB_MCP_TOOL_PROFILE: "full"
  });

  await client.callTool({
    name: "create_visual_validate_session",
    arguments: {
      CallbackURL: "https://example.com/visual-validation/callback",
      ProjectName: "default"
    }
  });
  await client.callTool({
    name: "get_visual_validate_result",
    arguments: {
      BytedToken: "opaque-byted-token",
      ProjectName: "default"
    }
  });

  assert.deepEqual(api.requests.map((request) => ({
    method: request.method,
    url: request.url,
    body: request.body
  })), [
    {
      method: "POST",
      url: "/api/v3?Action=CreateVisualValidateSession&Version=2024-01-01",
      body: {
        CallbackURL: "https://example.com/visual-validation/callback",
        ProjectName: "default"
      }
    },
    {
      method: "POST",
      url: "/api/v3?Action=GetVisualValidateResult&Version=2024-01-01",
      body: {
        BytedToken: "opaque-byted-token",
        ProjectName: "default"
      }
    }
  ]);
});

test("returns structured JSON and response request metadata", async (t) => {
  const api = await startMockApi(t, () => ({
    json: { id: "resp_1", output_text: "Hello" },
    headers: { "X-Request-ID": "req_mcp_1" }
  }));
  const client = await startMcpClient(t, {
    TOKENLAB_API_BASE: api.baseUrl,
    TOKENLAB_API_KEY: "test-key"
  });

  const result = await client.callTool({
    name: "create_response",
    arguments: { model: "gpt-5.5", input: "Hello" }
  });
  assert.deepEqual(result.structuredContent, { id: "resp_1", output_text: "Hello" });
  assert.equal(result._meta["tokenlab/httpStatus"], 200);
  assert.equal(result._meta["tokenlab/requestId"], "req_mcp_1");
});

test("uses overlay task semantics for hybrid, async, status, and cancellation responses", async (t) => {
  const api = await startMockApi(t, ({ method, url }) => {
    if (url === "/v1/images/generations") {
      return { created: 123, data: [{ url: "https://example.com/image.png" }] };
    }
    if (url === "/v1/videos/generations") {
      return { id: "video-task", status: "pending", poll_url: "/v1/tasks/video-task" };
    }
    if (url === "/v1/tasks/video-task" && method === "GET") {
      return { id: "video-task", status: "completed", video_url: "https://example.com/video.mp4" };
    }
    if (url === "/v1/tasks/video-task" && method === "DELETE") {
      return { id: "video-task", status: "cancelled" };
    }
    return { ok: true };
  });
  const client = await startMcpClient(t, {
    TOKENLAB_API_BASE: api.baseUrl,
    TOKENLAB_API_KEY: "test-key"
  });

  const image = parseTextResult(await client.callTool({
    name: "create_image",
    arguments: { model: "image-model", prompt: "A red cube" }
  }));
  const video = parseTextResult(await client.callTool({
    name: "create_video",
    arguments: { model: "video-model", prompt: "Orbit the cube" }
  }));
  const completed = parseTextResult(await client.callTool({ name: "get_task_status", arguments: { id: "video-task" } }));
  const cancelled = parseTextResult(await client.callTool({ name: "cancel_task", arguments: { id: "video-task" } }));

  assert.deepEqual(image.delivery, { mode: "complete", terminal: true });
  assert.deepEqual(video.delivery, {
    mode: "async",
    task_id: "video-task",
    status: "pending",
    poll_url: "/v1/tasks/video-task",
    terminal: false,
    next_tool: "get_task_status"
  });
  assert.equal(completed.delivery.terminal, true);
  assert.equal(cancelled.delivery.status, "cancelled");
  assert.equal(cancelled.delivery.next_tool, undefined);
});

test("turns OpenAPI binary fields into bounded local-file multipart uploads", async (t) => {
  const temp = await mkdtemp(join(tmpdir(), "tokenlab-mcp-test-"));
  const imagePath = join(temp, "source.png");
  await writeFile(imagePath, Buffer.from("fake-png-content"));

  const api = await startMockApi(t);
  const client = await startMcpClient(t, {
    TOKENLAB_API_BASE: api.baseUrl,
    TOKENLAB_API_KEY: "test-key"
  });
  await client.callTool({
    name: "edit_image_file",
    arguments: { model: "gpt-image-2", prompt: "Make it blue", image: imagePath }
  });

  assert.equal(api.requests.length, 1);
  assert.equal(api.requests[0].url, "/v1/images/edits");
  assert.match(api.requests[0].contentType, /^multipart\/form-data; boundary=/);
  const multipart = api.requests[0].rawBody.toString("utf8");
  assert.match(multipart, /filename="source.png"/);
  assert.match(multipart, /fake-png-content/);
  assert.match(multipart, /name="model"\r\n\r\ngpt-image-2/);
});

test("returns small binary image responses as native MCP image content", async (t) => {
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const api = await startMockApi(t, ({ url }) => url === "/v1/files/file-1/content"
    ? { rawBody: bytes, headers: { "Content-Type": "image/png" } }
    : { ok: true });
  const client = await startMcpClient(t, {
    TOKENLAB_API_BASE: api.baseUrl,
    TOKENLAB_API_KEY: "test-key"
  });

  const result = await client.callTool({ name: "retrieve_file_content", arguments: { file_id: "file-1" } });
  assert.deepEqual(result.content, [{ type: "image", data: bytes.toString("base64"), mimeType: "image/png" }]);
  assert.equal(result._meta["tokenlab/httpStatus"], 200);
});

test("requires auth only for protected generated operations", async (t) => {
  const api = await startMockApi(t, () => ({ data: [] }));
  const client = await startMcpClient(t, { TOKENLAB_API_BASE: api.baseUrl });

  const publicResult = await client.callTool({ name: "list_models", arguments: {} });
  assert.equal(publicResult.isError, undefined);
  assert.equal(api.requests[0].url, "/v1/models?view=compact");
  const protectedResult = await client.callTool({
    name: "create_response",
    arguments: { model: "gpt-5.5", input: "Hello" }
  });
  assert.equal(protectedResult.isError, true);
  assert.match(protectedResult.content[0].text, /TOKENLAB_API_KEY is required/);
  assert.equal(api.requests.length, 1);
});

test("ships an executable npm binary on each platform", async (t) => {
  const binary = new URL("../src/index.js", import.meta.url);
  assert.match(await readFile(binary, "utf8"), /^#!\/usr\/bin\/env node\n/);
  // Windows executes npm's .cmd shim; its filesystem has no POSIX execute bit.
  if (process.platform !== "win32") {
    assert.notEqual((await stat(binary)).mode & 0o111, 0);
  }
  const installDir = await mkdtemp(join(tmpdir(), "tokenlab-mcp-bin-"));
  t.after(() => rm(installDir, { recursive: true, force: true }));
  assert.ok(process.env.npm_execpath, "Run this installation check with npm test");
  execFileSync(process.execPath, [
    process.env.npm_execpath, "install", "--offline", "--ignore-scripts",
    "--no-audit", "--no-fund", "--no-package-lock",
    fileURLToPath(new URL("..", import.meta.url))
  ], { cwd: installDir, timeout: 30_000, stdio: "pipe" });

  const transport = new StdioClientTransport({
    command: join(installDir, "node_modules", ".bin", `tokenlab-mcp-server${process.platform === "win32" ? ".cmd" : ""}`),
    cwd: installDir,
    env: { TOKENLAB_MCP_TOOL_PROFILE: "core" },
    stderr: "pipe"
  });
  const client = new Client({ name: "tokenlab-installed-bin-test", version: "0.0.0" });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.equal(tools.length, 32);
    assert.ok(tools.some((tool) => tool.name === "create_response"));
  } finally {
    await client.close();
  }
});

test("forwards current Delivery, media, and idempotency inputs while retaining canonical validation", async (t) => {
  for (const mode of ["portable", "exact", "strict"]) {
    await t.test(mode, async (t) => {
      const api = await startMockApi(t);
      const client = await startMcpClient(t, {
        TOKENLAB_API_BASE: api.baseUrl,
        TOKENLAB_API_KEY: "test-key",
        TOKENLAB_MCP_TOOL_PROFILE: "full",
        TOKENLAB_MCP_SCHEMA_MODE: mode
      });
      const encoded = (value) => mode === "strict" ? JSON.stringify(value) : value;
      const references = Array.from({ length: 30 }, (_, index) => `https://example.com/${index}.png`);
      const calls = [
        { name: "create_chat_completion", arguments: {
          model: "fixture", messages: encoded([{ role: "user", content: "fixture" }]),
          "X-TokenLab-Delivery-Policy": "official"
        } },
        { name: "create_video", arguments: {
          model: "seedance-2.5", prompt: "fixture", reference_images: encoded(references)
        } },
        { name: "create_volc_compatible_seedance_task", arguments: {
          model: "fixture", content: encoded([{ type: "text", text: "fixture" }]),
          duration: encoded(-1), "Idempotency-Key": "fixture-once"
        } }
      ];
      for (const call of calls) assert.equal((await client.callTool(call)).isError, undefined);
      assert.equal(api.requests.length, 3);
      assert.equal(api.requests[0].headers["x-tokenlab-delivery-policy"], "official");
      assert.equal(api.requests[0].body["X-TokenLab-Delivery-Policy"], undefined);
      assert.deepEqual(api.requests[1].body.reference_images, references);
      assert.equal(api.requests[1].headers["x-tokenlab-delivery-policy"], undefined);
      assert.equal(api.requests[2].headers["idempotency-key"], "fixture-once");
      assert.equal(api.requests[2].body["Idempotency-Key"], undefined);
      assert.equal(api.requests[2].body.duration, -1);

      const invalidCalls = [
        { ...calls[0], arguments: { ...calls[0].arguments, "X-TokenLab-Delivery-Policy": "unknown" } },
        { ...calls[1], arguments: { ...calls[1].arguments, reference_images: encoded([...references, references[0]]) } },
        { ...calls[2], arguments: { ...calls[2].arguments, "Idempotency-Key": "" } },
        { ...calls[2], arguments: { ...calls[2].arguments, duration: encoded(0) } },
        { ...calls[2], arguments: { ...calls[2].arguments, content: encoded([{ type: "image_url", image_url: {} }]) } }
      ];
      for (const call of invalidCalls) {
        const result = await client.callTool(call);
        assert.equal(result.isError, true);
        assert.match(result.content[0].text, /Input validation error/);
      }
      assert.equal(api.requests.length, 3, "invalid nested fields, enum values and limits must not reach HTTP");
    });
  }
});

test("preserves bounded HTTP recovery details without retrying a create", async (t) => {
  const retryDate = new Date(Date.now() + 120_000).toUTCString();
  const fixtures = [
    { status: 429, headers: { "Retry-After": "37", "X-Request-ID": "req_header" },
      json: { error: { code: "rate_limit_exceeded", message: "Slow down", retry_after: 1, request_id: "req_body" } } },
    { status: 503, headers: { "Retry-After": retryDate },
      json: { error: { code: "unavailable", message: "Try later", retryable: false }, request_id: "req_body" } },
    { status: 401, json: { error: { code: "invalid_api_key", message: "Invalid credential" } } },
    { status: 429, headers: { "Retry-After": "invalid" },
      json: { error: { message: "Wait", retry_after: 12 } } },
    { status: 502, headers: { "Content-Type": "text/html", "X-Request-ID": "req_html" },
      rawBody: Buffer.from("upstream unavailable ".repeat(500)) }
  ];
  let index = 0;
  const api = await startMockApi(t, () => fixtures[index]);
  const client = await startMcpClient(t, { TOKENLAB_API_BASE: api.baseUrl, TOKENLAB_API_KEY: "test-key" });
  const results = [];
  for (; index < fixtures.length; index += 1) {
    const result = await client.callTool({ name: "create_chat_completion", arguments: {
      model: "fixture", messages: [{ role: "user", content: "fixture" }]
    } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /^TokenLab request failed:/);
    assert.ok(result.content[0].text.length < 4_400);
    assert.equal(result.structuredContent.status, fixtures[index].status);
    assert.equal(result._meta["tokenlab/httpStatus"], fixtures[index].status);
    assert.ok(Buffer.byteLength(JSON.stringify(result.structuredContent)) < 5_000);
    results.push(result);
    assert.equal(api.requests.length, index + 1, "one call must dispatch at most one create");
  }
  assert.deepEqual(results[0].structuredContent, {
    status: 429, error: { code: "rate_limit_exceeded", message: "Slow down" },
    request_id: "req_header", retryable: true, retry_after: 37
  });
  assert.equal(results[0]._meta["tokenlab/retryAfter"], "37");
  assert.equal(results[0]._meta["tokenlab/retryAfterSeconds"], 37);
  assert.equal(results[1].structuredContent.request_id, "req_body");
  assert.equal(results[1].structuredContent.retryable, false);
  assert.ok(results[1].structuredContent.retry_after > 100 && results[1].structuredContent.retry_after <= 120);
  assert.equal(results[1]._meta["tokenlab/retryAfter"], retryDate);
  assert.equal(results[2].structuredContent.retryable, false);
  assert.equal(results[2].structuredContent.retry_after, undefined);
  assert.equal(results[3].structuredContent.retry_after, 12);
  assert.equal(results[4].structuredContent.request_id, "req_html");
  assert.match(results[4].structuredContent.error.message, /^upstream unavailable/);
});

test("keeps original public error diagnostics on generated and discovery paths without copying headers", async (t) => {
  const diagnostic = {
    error: {
      code: "invalid_request_error", message: "Unsupported request shape",
      hint: "Use the declared endpoint and request fields",
      recommended_request: { model: "fixture", prompt: "example" },
      did_you_mean: ["prompt"]
    },
    request_id: "req_diagnostic"
  };
  const api = await startMockApi(t, () => ({
    status: 400,
    headers: { "Authorization": "Bearer response-secret", "Set-Cookie": "private=cookie-secret", "X-API-Key": "header-secret" },
    json: diagnostic
  }));
  const client = await startMcpClient(t, { TOKENLAB_API_BASE: api.baseUrl, TOKENLAB_API_KEY: "request-secret" });
  const calls = [
    { name: "get_model", arguments: { model: "fixture" } },
    { name: "get_api_overview", arguments: {} },
    { name: "compare_models", arguments: { models: ["model-a", "model-b"] } }
  ];
  for (const call of calls) {
    const result = await client.callTool(call);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /^TokenLab request failed: 400/);
    assert.ok(result.content[0].text.includes(JSON.stringify(diagnostic)));
    assert.equal(result.structuredContent.error.message, diagnostic.error.message);
    assert.equal(result.structuredContent.request_id, "req_diagnostic");
    assert.doesNotMatch(JSON.stringify(result), /request-secret|response-secret|cookie-secret|header-secret/);
  }
});

test("keeps recovery metadata when a composite catalog read has unavailable pricing", async (t) => {
  const api = await startMockApi(t, ({ url }) => url.endsWith("/pricing")
    ? { status: 429, headers: { "Retry-After": "9", "X-Request-ID": "req_pricing", "Set-Cookie": "private=cookie-secret" }, json: { error: { code: "rate_limit_exceeded", message: "Wait", hint: "Poll again after Retry-After" } } }
    : { id: url.split("/").at(-1), tokenlab: {} });
  const client = await startMcpClient(t, { TOKENLAB_API_BASE: api.baseUrl, TOKENLAB_API_KEY: "" });
  const result = parseTextResult(await client.callTool({ name: "compare_models", arguments: { models: ["model-a", "model-b"] } }));
  assert.equal(api.requests.length, 4);
  for (const model of result.compared) {
    assert.equal(model.pricing.status, 429);
    assert.equal(model.pricing.error.code, "rate_limit_exceeded");
    assert.equal(model.pricing.request_id, "req_pricing");
    assert.equal(model.pricing.retry_after, 9);
    assert.match(model.pricing.diagnostic, /Poll again after Retry-After/);
    assert.doesNotMatch(JSON.stringify(model.pricing), /cookie-secret/);
  }
});

test("System One preserves structured questions and all three typed decision answers", async (t) => {
  const expected = {
    model: "jev-1.13",
    answers: {
      refund: { type: "noul", noul: 0.92 },
      team: { type: "choice", choice: "billing", probabilities: { billing: 0.92, other: 0.08 }, confidence: 0.84 },
      urgency: { type: "score", score: 1.25, probabilities: { "0": 0, "1": 0.75, "2": 0.25 }, confidence: 0.5 }
    },
    usage: { input_tokens: 300, output_tokens: 50 }
  };
  const api = await startMockApi(t, () => expected);
  const client = await startMcpClient(t, { TOKENLAB_API_BASE: api.baseUrl, TOKENLAB_API_KEY: "test-decision-key" });
  const body = {
    model: "jev-1.13",
    state: { ticket: { text: "I was charged twice; please refund the duplicate." } },
    questions: {
      refund: { type: "noul", instructions: "Is a refund explicitly requested?" },
      team: { type: "choice", instructions: { task: "Choose the responsible team" }, criteria: { billing: "Payments and refunds", other: null } },
      urgency: { type: "score", instructions: ["Rate urgency"], criteria: ["Routine enquiry", "Money affected", "Safety emergency"] }
    }
  };
  const result = parseTextResult(await client.callTool({ name: "evaluate_decisions", arguments: body }));
  assert.equal(api.requests.length, 1);
  assert.equal(api.requests[0].url, "/v1/systemone");
  assert.equal(api.requests[0].authorization, "Bearer test-decision-key");
  assert.deepEqual(api.requests[0].body, body);
  assert.deepEqual(result, expected);
});

test("discovers decision models through the declared catalog category", async (t) => {
  const api = await startMockApi(t, () => ({ object: "list", data: [] }));
  const client = await startMcpClient(t, { TOKENLAB_API_BASE: api.baseUrl });
  const result = await client.callTool({ name: "list_models", arguments: { category: "decision" } });
  assert.notEqual(result.isError, true);
  assert.equal(api.requests.length, 1);
  assert.equal(api.requests[0].url, "/v1/models?category=decision&view=compact");
});

test('webhook tools use a separate workspace management token', async t => {
  const api = await startMockApi(t);
  const client = await startMcpClient(t, { TOKENLAB_API_BASE: api.baseUrl, TOKENLAB_API_KEY: 'sk-inference', TOKENLAB_MANAGEMENT_TOKEN: 'mt-management', TOKENLAB_MCP_TOOL_PROFILE: 'full' });
  const tools = (await client.listTools()).tools;
  for (const name of ['list_webhooks','create_webhook','get_webhook','update_webhook','delete_webhook','rotate_webhook_secret','test_webhook','list_webhook_deliveries']) {
    assert.ok(tools.some(tool => tool.name === name), name);
  }
  assert.equal(tools.find(tool => tool.name === 'rotate_webhook_secret').annotations.destructiveHint, true);
  parseTextResult(await client.callTool({ name: 'list_webhooks', arguments: {} }));
  assert.equal(api.requests.at(-1).authorization, 'Bearer mt-management');
  assert.equal(api.requests.at(-1).url, '/v1/management/webhooks');
  parseTextResult(await client.callTool({ name: 'get_task_status', arguments: { id: 'ldtask_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } }));
  assert.equal(api.requests.at(-1).authorization, 'Bearer sk-inference');
});

test('inference credentials never substitute for a missing management token', async t => {
  const api = await startMockApi(t);
  const client = await startMcpClient(t, { TOKENLAB_API_BASE: api.baseUrl, TOKENLAB_API_KEY: 'sk-inference', TOKENLAB_MANAGEMENT_TOKEN: '', TOKENLAB_MCP_TOOL_PROFILE: 'full' });
  const result = await client.callTool({ name: 'list_webhooks', arguments: {} });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /TOKENLAB_MANAGEMENT_TOKEN/);
  assert.equal(api.requests.length, 0);
});

test('webhook management works without an inference key', async t => {
  const api = await startMockApi(t);
  const client = await startMcpClient(t, { TOKENLAB_API_BASE: api.baseUrl, TOKENLAB_API_KEY: '', TOKENLAB_MANAGEMENT_TOKEN: 'mt-management', TOKENLAB_MCP_TOOL_PROFILE: 'full' });
  parseTextResult(await client.callTool({ name: 'create_webhook', arguments: { url: 'https://app.example/webhooks', events: ['task.completed'] } }));
  assert.equal(api.requests[0].authorization, 'Bearer mt-management');
  assert.equal(api.requests[0].body.url, 'https://app.example/webhooks');
});
