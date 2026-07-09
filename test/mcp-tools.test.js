import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import test from "node:test";

function startServer() {
  const child = spawn(process.execPath, ["src/index.js"], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"]
  });
  let nextId = 1;
  let buffer = "";
  const pending = new Map();

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop();

    for (const line of lines) {
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      const resolve = pending.get(message.id);
      if (resolve) {
        pending.delete(message.id);
        resolve(message);
      }
    }
  });

  function request(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}`));
      }, 5_000);
      pending.set(id, (message) => {
        clearTimeout(timeout);
        resolve(message);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  function notify(method, params) {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  return { child, notify, request };
}

test("advertises an OpenAI-compatible Chat Completions tool", async (t) => {
  const server = startServer();
  t.after(() => server.child.kill());

  const initialized = await server.request("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "tokenlab-mcp-test", version: "0.0.0" }
  });
  assert.equal(initialized.error, undefined);

  server.notify("notifications/initialized");
  const listed = await server.request("tools/list", {});
  const tool = listed.result.tools.find(({ name }) => name === "create_chat_completion");

  assert.ok(tool);
  assert.equal(tool.inputSchema.properties.model.type, "string");
  assert.equal(tool.inputSchema.properties.messages.type, "array");
  assert.equal(tool.inputSchema.properties.stream, undefined);
});

test("ships an executable npm binary", async () => {
  const { mode } = await stat(new URL("../src/index.js", import.meta.url));
  assert.notEqual(mode & 0o111, 0);
});
