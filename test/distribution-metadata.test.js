import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const dockerfile = await readFile(new URL("../Dockerfile", import.meta.url), "utf8");
const glama = JSON.parse(await readFile(new URL("../glama.json", import.meta.url), "utf8"));
const publicContract = JSON.parse(
  await readFile(new URL("../generated/public-contract.json", import.meta.url), "utf8")
);
const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");

test("distribution container includes every runtime contract asset", () => {
  for (const runtimePath of ["contract", "generated", "src"]) {
    assert.match(
      dockerfile,
      new RegExp(`^COPY(?: --chown=[^ ]+)? ${runtimePath} \\./${runtimePath}$`, "m"),
      `Dockerfile must copy ${runtimePath}/ for MCP startup`
    );
  }
});

test("Glama ownership metadata names the repository maintainer", () => {
  assert.equal(glama.$schema, "https://glama.ai/mcp/schemas/server.json");
  assert.deepEqual(glama.maintainers, ["hedging8563"]);
});

test("README distinguishes endpoint tools from registered tools", () => {
  for (const [profileName, label] of [
    ["catalog", "`catalog`"],
    ["core", "`core` \\(default\\)"],
    ["full", "`full`"]
  ]) {
    const profile = publicContract.profiles[profileName];
    assert.match(
      readme,
      new RegExp(
        `^\\| ${label} \\| ${profile.endpoint_tools} \\| ${profile.total_tools} \\|`,
        "m"
      )
    );
  }
});
