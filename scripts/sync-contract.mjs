#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const overlay = JSON.parse(await readFile(resolve(root, "contract/mcp-overlay.json"), "utf8"));
const response = await fetch(overlay.openapi_url, {
  headers: { Accept: "application/json", "User-Agent": "tokenlab-mcp-contract-sync" }
});
if (!response.ok) throw new Error(`OpenAPI fetch failed: ${response.status} ${response.statusText}`);

const source = `${JSON.stringify(await response.json(), null, 2)}\n`;
await writeFile(resolve(root, "contract/openapi.json"), source);

await new Promise((resolvePromise, reject) => {
  const child = spawn(process.execPath, ["scripts/generate-contract.mjs"], {
    cwd: root,
    stdio: "inherit"
  });
  child.once("error", reject);
  child.once("exit", (code) => code === 0 ? resolvePromise() : reject(new Error(`Generator exited ${code}`)));
});

console.log(`[contract] synchronized ${overlay.openapi_url}`);
