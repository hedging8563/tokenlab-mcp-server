import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

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
      const { tools } = await client.listTools();
      const actual = tools.map((tool) => tool.name).sort();
      const expected = manifest.tools
        .filter((tool) => tool.profiles.includes(profile))
        .map((tool) => tool.name)
        .concat("compare_models", "get_api_overview")
        .sort();
      assert.deepEqual(actual, expected);

      for (const tool of tools) {
        assert.equal(typeof tool.title, "string", `${tool.name} must expose a title`);
        assert.equal(typeof tool.annotations?.readOnlyHint, "boolean", `${tool.name} must expose risk annotations`);
      }
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
  assert.equal(byName.create_gemini_content.input_schema.properties.key, undefined);
  for (const name of ["create_chat_completion", "create_response", "create_anthropic_message", "create_image", "edit_image"]) {
    assert.equal(byName[name].input_schema.properties.stream.const, false, `${name} must remain non-streaming in MCP`);
  }
  for (const name of ["create_image", "create_image_file", "edit_image", "edit_image_file"]) {
    assert.equal(byName[name].input_schema.properties.partial_images, undefined, `${name} must not expose partial_images`);
    assert.equal(byName[name].input_schema.properties.input_fidelity, undefined, `${name} must not expose input_fidelity`);
  }
  for (const tool of manifest.tools) {
    const exposedSecret = Object.keys(tool.input_schema.properties).find((name) => /api.?key|authorization|password|secret/i.test(name));
    assert.equal(exposedSecret, undefined, `${tool.name} must not expose credential arguments`);
  }
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
    ["create_response", { model: "gpt-5.5", input: "Hello", stream: false }],
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
    arguments: { model: "gpt-5.5", input: "Hello", stream: false }
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
  const protectedResult = await client.callTool({
    name: "create_response",
    arguments: { model: "gpt-5.5", input: "Hello" }
  });
  assert.equal(protectedResult.isError, true);
  assert.match(protectedResult.content[0].text, /TOKENLAB_API_KEY is required/);
  assert.equal(api.requests.length, 1);
});

test("ships an executable npm binary", async () => {
  const { mode } = await stat(new URL("../src/index.js", import.meta.url));
  assert.notEqual(mode & 0o111, 0);
});
