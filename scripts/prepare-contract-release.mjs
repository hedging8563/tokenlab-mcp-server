#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const prepare = process.argv.includes("--prepare");
const contractOutputs = [
  "generated/public-contract.json",
  "generated/tools.json"
];
const commitPaths = [
  "README.md",
  "contract/openapi.json",
  "generated/public-contract.json",
  "generated/tools.json",
  "llms-install.md",
  "package-lock.json",
  "package.json",
  "server.json"
];

function hasDiff(paths) {
  try {
    execFileSync("git", ["diff", "--quiet", "--", ...paths], { cwd: root });
    return false;
  } catch (error) {
    if (error?.status === 1) return true;
    throw error;
  }
}

function parseVersion(value) {
  const match = String(value || "").match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) throw new Error(`Invalid semantic version: ${value}`);
  return match.slice(1).map(Number);
}

function compareVersions(left, right) {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "tokenlab-mcp-contract-release" },
    signal: AbortSignal.timeout(30_000)
  });
  if (!response.ok) throw new Error(`Release state fetch failed: ${response.status} ${url}`);
  return response.json();
}

async function publishedVersions(packageName, registryName) {
  const encodedPackage = encodeURIComponent(packageName);
  const [npmPackage, registry] = await Promise.all([
    fetchJson(`https://registry.npmjs.org/${encodedPackage}/latest`),
    fetchJson(`https://registry.modelcontextprotocol.io/v0.1/servers?search=${encodeURIComponent(registryName)}`)
  ]);
  const matchingServers = (registry.servers || [])
    .filter((entry) => entry?.server?.name === registryName)
    .map((entry) => entry.server.version)
    .filter(Boolean)
    .sort(compareVersions);
  const registryVersion = matchingServers.at(-1);
  if (!npmPackage.version || !registryVersion) throw new Error("Published MCP release state is incomplete");
  return { npmVersion: npmPackage.version, registryVersion };
}

const contractChanged = hasDiff(contractOutputs);
if (prepare && contractChanged) {
  execFileSync("npm", ["version", "patch", "--no-git-tag-version"], {
    cwd: root,
    stdio: "inherit"
  });
}

const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const serverJson = JSON.parse(await readFile(resolve(root, "server.json"), "utf8"));
const { npmVersion, registryVersion } = await publishedVersions(packageJson.name, serverJson.name);

if (compareVersions(packageJson.version, npmVersion) < 0) {
  throw new Error(`Local package ${packageJson.version} is behind npm ${npmVersion}`);
}
if (compareVersions(packageJson.version, registryVersion) < 0) {
  throw new Error(`Local package ${packageJson.version} is behind MCP Registry ${registryVersion}`);
}

const state = {
  version: packageJson.version,
  tag: `v${packageJson.version}`,
  contractChanged,
  needsCommit: hasDiff(commitPaths),
  needsNpmPublish: compareVersions(packageJson.version, npmVersion) > 0,
  needsRegistryPublish: compareVersions(packageJson.version, registryVersion) > 0
};
state.needsRelease = state.needsNpmPublish || state.needsRegistryPublish;

if (process.env.GITHUB_OUTPUT) {
  const output = [
    `version=${state.version}`,
    `tag=${state.tag}`,
    `contract_changed=${state.contractChanged}`,
    `needs_commit=${state.needsCommit}`,
    `needs_release=${state.needsRelease}`,
    `needs_npm_publish=${state.needsNpmPublish}`,
    `needs_registry_publish=${state.needsRegistryPublish}`
  ].join("\n");
  await appendFile(process.env.GITHUB_OUTPUT, `${output}\n`);
}

console.log(JSON.stringify({
  ...state,
  published: { npm: npmVersion, mcpRegistry: registryVersion }
}, null, 2));
