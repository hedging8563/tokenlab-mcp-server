#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const serverPath = resolve(root, "server.json");
const readmePath = resolve(root, "README.md");
const serverJson = JSON.parse(await readFile(serverPath, "utf8"));

serverJson.version = packageJson.version;
for (const registryPackage of serverJson.packages || []) {
  if (registryPackage.identifier === packageJson.name) {
    registryPackage.version = packageJson.version;
  }
}

const readme = await readFile(readmePath, "utf8");
const synchronizedReadme = readme
  .replace(/Version \d+\.\d+\.\d+ generates/, `Version ${packageJson.version} generates`)
  .replace(/@tokenlabai\/mcp-server@\d+\.\d+\.\d+/g, `${packageJson.name}@${packageJson.version}`);

await Promise.all([
  writeFile(serverPath, `${JSON.stringify(serverJson, null, 2)}\n`, "utf8"),
  writeFile(readmePath, synchronizedReadme, "utf8"),
]);

console.log(`[version] synchronized package, Registry metadata, and README at ${packageJson.version}`);
