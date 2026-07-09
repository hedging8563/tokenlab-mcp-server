import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function startMockApi(t) {
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;

    requests.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      body: body ? JSON.parse(body) : undefined
    });

    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests
  };
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

test("advertises all catalog, OpenAI-compatible, and native endpoint tools", async (t) => {
  const client = await startMcpClient(t);
  const { tools } = await client.listTools();
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

  assert.deepEqual(Object.keys(byName).sort(), [
    "compare_models",
    "create_anthropic_message",
    "create_chat_completion",
    "create_gemini_content",
    "create_response",
    "get_api_overview",
    "get_model",
    "get_model_pricing",
    "list_models"
  ]);
  assert.equal(byName.create_chat_completion.inputSchema.properties.messages.type, "array");
  assert.equal(byName.create_chat_completion.inputSchema.properties.stream, undefined);
  assert.ok(byName.create_response.inputSchema.properties.input.anyOf);
  assert.equal(byName.create_anthropic_message.inputSchema.properties.messages.type, "array");
  assert.equal(byName.create_gemini_content.inputSchema.properties.contents.type, "array");
});

test("forwards native endpoint payloads without flattening their semantics", async (t) => {
  const api = await startMockApi(t);
  const client = await startMcpClient(t, {
    TOKENLAB_API_BASE: api.baseUrl,
    TOKENLAB_API_KEY: "test-key"
  });

  await client.callTool({
    name: "create_response",
    arguments: {
      model: "gpt-5.5",
      input: [{ role: "user", content: [{ type: "input_text", text: "Hello" }] }],
      tools: [{ type: "function", name: "lookup" }]
    }
  });
  await client.callTool({
    name: "create_anthropic_message",
    arguments: {
      model: "claude-sonnet-5",
      max_tokens: 1024,
      messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
      tools: [{ name: "lookup", input_schema: { type: "object" } }]
    }
  });
  await client.callTool({
    name: "create_gemini_content",
    arguments: {
      model: "gemini-3.5-flash",
      contents: [{ role: "user", parts: [{ text: "Hello" }] }],
      generationConfig: { responseMimeType: "application/json" },
      tools: [{ functionDeclarations: [{ name: "lookup" }] }]
    }
  });

  assert.equal(api.requests.length, 3);
  for (const request of api.requests) {
    assert.equal(request.method, "POST");
    assert.equal(request.authorization, "Bearer test-key");
  }

  assert.equal(api.requests[0].url, "/v1/responses");
  assert.equal(api.requests[0].body.stream, false);
  assert.deepEqual(api.requests[0].body.input[0].content[0], { type: "input_text", text: "Hello" });
  assert.equal(api.requests[1].url, "/v1/messages");
  assert.equal(api.requests[1].body.stream, false);
  assert.equal(api.requests[1].body.messages[0].content[0].type, "text");
  assert.equal(api.requests[2].url, "/v1beta/models/gemini-3.5-flash:generateContent");
  assert.equal(api.requests[2].body.generationConfig.responseMimeType, "application/json");
  assert.equal(api.requests[2].body.tools[0].functionDeclarations[0].name, "lookup");
});

test("keeps simple prompt shortcuts and requires auth for inference", async (t) => {
  const api = await startMockApi(t);
  const authenticated = await startMcpClient(t, {
    TOKENLAB_API_BASE: api.baseUrl,
    TOKENLAB_API_KEY: "test-key"
  });

  await authenticated.callTool({
    name: "create_anthropic_message",
    arguments: { model: "claude-sonnet-5", prompt: "Hello", max_tokens: 32 }
  });
  await authenticated.callTool({
    name: "create_gemini_content",
    arguments: { model: "gemini-3.5-flash", prompt: "Hello", temperature: 0.2 }
  });

  assert.equal(api.requests[0].body.messages[0].content, "Hello");
  assert.equal(api.requests[1].body.contents[0].parts[0].text, "Hello");
  assert.equal(api.requests[1].body.generationConfig.temperature, 0.2);

  const unauthenticated = await startMcpClient(t, { TOKENLAB_API_BASE: api.baseUrl });
  const result = await unauthenticated.callTool({
    name: "create_response",
    arguments: { model: "gpt-5.5", input: "Hello" }
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /TOKENLAB_API_KEY is required/);
});

test("ships an executable npm binary", async () => {
  const { mode } = await stat(new URL("../src/index.js", import.meta.url));
  assert.notEqual(mode & 0o111, 0);
});
