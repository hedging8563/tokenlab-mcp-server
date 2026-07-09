#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API_BASE = (process.env.TOKENLAB_API_BASE || "https://api.tokenlab.sh").replace(/\/$/, "");

const scenes = [
  "image",
  "video",
  "music",
  "3d",
  "tts",
  "stt",
  "embedding",
  "rerank",
  "translation"
];

const server = new McpServer({
  name: "tokenlab-model-catalog",
  version: "0.1.0"
});

async function fetchJson(path) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: {
      Accept: "application/json",
      "User-Agent": "tokenlab-mcp-server/0.1.0"
    }
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`TokenLab request failed: ${response.status} ${response.statusText}\n${text}`);
  }

  return JSON.parse(text);
}

function textResult(value) {
  return {
    content: [
      {
        type: "text",
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2)
      }
    ]
  };
}

server.tool(
  "list_models",
  "List public TokenLab models, optionally filtered by recommended task.",
  {
    recommended_for: z.enum(scenes).optional().describe("Optional task filter such as image, video, embedding, or rerank."),
    limit: z.number().int().min(1).max(100).default(25).describe("Maximum number of models to return.")
  },
  async ({ recommended_for, limit }) => {
    const query = recommended_for ? `?recommended_for=${encodeURIComponent(recommended_for)}` : "";
    const data = await fetchJson(`/v1/models${query}`);
    const models = Array.isArray(data.data) ? data.data.slice(0, limit) : [];

    return textResult({
      object: data.object,
      count: Array.isArray(data.data) ? data.data.length : 0,
      returned: models.length,
      models
    });
  }
);

server.tool(
  "get_model",
  "Fetch public TokenLab model contract details for one model ID.",
  {
    model: z.string().min(1).describe("Public TokenLab model ID, for example gpt-5.5 or gemini-3.5-flash.")
  },
  async ({ model }) => {
    return textResult(await fetchJson(`/v1/models/${encodeURIComponent(model)}`));
  }
);

server.tool(
  "get_model_pricing",
  "Fetch public TokenLab pricing details for one model ID.",
  {
    model: z.string().min(1).describe("Public TokenLab model ID.")
  },
  async ({ model }) => {
    return textResult(await fetchJson(`/v1/models/${encodeURIComponent(model)}/pricing`));
  }
);

server.tool(
  "get_api_overview",
  "Fetch TokenLab's agent-readable API overview.",
  {},
  async () => {
    const response = await fetch(`${API_BASE}/llms.txt`, {
      headers: {
        Accept: "text/plain",
        "User-Agent": "tokenlab-mcp-server/0.1.0"
      }
    });

    if (!response.ok) {
      throw new Error(`TokenLab overview request failed: ${response.status} ${response.statusText}`);
    }

    return textResult(await response.text());
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
