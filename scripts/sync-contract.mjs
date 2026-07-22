#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const executeFile = promisify(execFile);
const check = process.argv.includes("--check");
const GENERATED_CONTRACT_PATHS = [
  "README.md",
  "contract/openapi.json",
  "generated/public-contract.json",
  "generated/tools.json",
  "llms-install.md"
];

async function git(args) {
  return executeFile("git", args, { cwd: root, encoding: "utf8" });
}

async function assertContractSyncReady() {
  const { stdout: status } = await git(["status", "--porcelain", "--", ...GENERATED_CONTRACT_PATHS]);
  if (status.trim()) {
    throw new Error(
      `Refusing to overwrite dirty contract snapshots:\n${status.trim()}\nCommit or restore them before npm run contract:sync.`
    );
  }

  await git(["fetch", "--quiet", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
  const { stdout } = await git(["rev-list", "--left-right", "--count", "HEAD...origin/main"]);
  const [ahead, behind] = stdout.trim().split(/\s+/).map(Number);
  if (behind > 0) {
    throw new Error(
      `Refusing contract sync because local HEAD is ${behind} commit(s) behind origin/main${ahead > 0 ? ` and ${ahead} commit(s) ahead` : ""}. Run git pull --ff-only, then retry.`
    );
  }
}

if (!check) await assertContractSyncReady();

const overlay = JSON.parse(await readFile(resolve(root, "contract/mcp-overlay.json"), "utf8"));
const response = await fetch(overlay.openapi_url, {
  headers: { Accept: "application/json", "User-Agent": "tokenlab-mcp-contract-sync" }
});
if (!response.ok) throw new Error(`OpenAPI fetch failed: ${response.status} ${response.statusText}`);

const source = `${JSON.stringify(await response.json(), null, 2)}\n`;
const sourcePath = resolve(root, "contract/openapi.json");
if (check) {
  const existing = await readFile(sourcePath, "utf8");
  if (existing !== source) {
    throw new Error("Checked-in OpenAPI snapshot differs from the canonical source. Pull origin/main or run npm run contract:sync from an up-to-date clean branch.");
  }
  console.log(`[contract] source PASS (${overlay.openapi_url})`);
} else {
  const tempDirectory = await mkdtemp(resolve(root, ".contract-sync-"));
  const tempSourcePath = resolve(tempDirectory, "openapi.json");
  const tempToolsPath = resolve(tempDirectory, "tools.json");
  const tempPublicPath = resolve(tempDirectory, "public-contract.json");
  const tempReadmePath = resolve(tempDirectory, "README.md");
  const tempInstallPath = resolve(tempDirectory, "llms-install.md");
  try {
    const [readme, install] = await Promise.all([
      readFile(resolve(root, "README.md"), "utf8"),
      readFile(resolve(root, "llms-install.md"), "utf8")
    ]);
    await Promise.all([
      writeFile(tempSourcePath, source),
      writeFile(tempReadmePath, readme),
      writeFile(tempInstallPath, install)
    ]);
    await new Promise((resolvePromise, reject) => {
      const child = spawn(process.execPath, [
        "scripts/generate-contract.mjs",
        "--source", tempSourcePath,
        "--output", tempToolsPath,
        "--public-output", tempPublicPath,
        "--readme", tempReadmePath,
        "--install", tempInstallPath
      ], {
        cwd: root,
        stdio: "inherit"
      });
      child.once("error", reject);
      child.once("exit", (code) => code === 0 ? resolvePromise() : reject(new Error(`Generator exited ${code}`)));
    });

    const [tools, publicContract, synchronizedReadme, synchronizedInstall] = await Promise.all([
      readFile(tempToolsPath, "utf8"),
      readFile(tempPublicPath, "utf8"),
      readFile(tempReadmePath, "utf8"),
      readFile(tempInstallPath, "utf8")
    ]);
    await Promise.all([
      writeFile(sourcePath, source),
      writeFile(resolve(root, "generated/tools.json"), tools),
      writeFile(resolve(root, "generated/public-contract.json"), publicContract),
      writeFile(resolve(root, "README.md"), synchronizedReadme),
      writeFile(resolve(root, "llms-install.md"), synchronizedInstall)
    ]);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }

  console.log(`[contract] synchronized ${overlay.openapi_url}`);
}
