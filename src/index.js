#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const VERSION = "0.2.0";
const API_BASE = (process.env.TOKENLAB_API_BASE || "https://api.tokenlab.sh").replace(/\/$/, "");
const API_KEY = process.env.TOKENLAB_API_KEY || "";

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
  name: "tokenlab",
  version: VERSION
});

async function fetchJson(path, options = {}) {
  const headers = {
    Accept: "application/json",
    "User-Agent": `tokenlab-mcp-server/${VERSION}`
  };
  if (options.body) {
    headers["Content-Type"] = "application/json";
  }
  if (options.auth) {
    if (!API_KEY) {
      throw new Error("TOKENLAB_API_KEY is required for TokenLab inference tools.");
    }
    headers.Authorization = `Bearer ${API_KEY}`;
  }

  const response = await fetch(`${API_BASE}${path}`, {
    method: options.method || "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
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

function compactModelDetails(details, pricing) {
  return {
    id: details.id || details.model || details.name,
    object: details.object,
    owned_by: details.owned_by,
    request_endpoint: details.request_endpoint,
    request_shape_mode: details.request_shape_mode,
    supported_operations: details.supported_operations,
    supported_parameters: details.supported_parameters,
    recommended_request: details.recommended_request,
    pricing
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
  "Fetch public TokenLab model details for one model ID.",
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
  "compare_models",
  "Compare public TokenLab model details and pricing for several model IDs.",
  {
    models: z.array(z.string().min(1)).min(2).max(8).describe("Public TokenLab model IDs to compare."),
    include_raw: z.boolean().default(false).describe("Return raw details and pricing payloads instead of compact summaries.")
  },
  async ({ models, include_raw }) => {
    const compared = await Promise.all(models.map(async (model) => {
      const encoded = encodeURIComponent(model);
      const [details, pricing] = await Promise.all([
        fetchJson(`/v1/models/${encoded}`),
        fetchJson(`/v1/models/${encoded}/pricing`).catch((error) => ({
          error: error.message
        }))
      ]);

      return include_raw ? { model, details, pricing } : compactModelDetails(details, pricing);
    }));

    return textResult({ compared });
  }
);

server.tool(
  "create_response",
  "Create a TokenLab Responses API call. Requires TOKENLAB_API_KEY.",
  {
    model: z.string().min(1).describe("Public TokenLab model ID."),
    input: z.string().min(1).describe("Responses API input text."),
    instructions: z.string().optional().describe("Optional system/developer instructions."),
    max_output_tokens: z.number().int().min(1).max(8192).optional().describe("Optional output token cap.")
  },
  async ({ model, input, instructions, max_output_tokens }) => {
    return textResult(await fetchJson("/v1/responses", {
      method: "POST",
      auth: true,
      body: {
        model,
        input,
        ...(instructions ? { instructions } : {}),
        ...(max_output_tokens ? { max_output_tokens } : {})
      }
    }));
  }
);

server.tool(
  "create_anthropic_message",
  "Create a TokenLab Anthropic Messages call. Requires TOKENLAB_API_KEY.",
  {
    model: z.string().min(1).describe("Public TokenLab Claude-compatible model ID."),
    prompt: z.string().min(1).describe("User prompt text."),
    system: z.string().optional().describe("Optional system prompt."),
    max_tokens: z.number().int().min(1).max(8192).default(512).describe("Maximum output tokens.")
  },
  async ({ model, prompt, system, max_tokens }) => {
    return textResult(await fetchJson("/v1/messages", {
      method: "POST",
      auth: true,
      body: {
        model,
        max_tokens,
        ...(system ? { system } : {}),
        messages: [
          {
            role: "user",
            content: prompt
          }
        ]
      }
    }));
  }
);

server.tool(
  "create_gemini_content",
  "Create a TokenLab Gemini generateContent call. Requires TOKENLAB_API_KEY.",
  {
    model: z.string().min(1).describe("Public TokenLab Gemini-compatible model ID."),
    prompt: z.string().min(1).describe("User prompt text."),
    temperature: z.number().min(0).max(2).optional().describe("Optional Gemini generation temperature.")
  },
  async ({ model, prompt, temperature }) => {
    return textResult(await fetchJson(`/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      auth: true,
      body: {
        contents: [
          {
            role: "user",
            parts: [
              {
                text: prompt
              }
            ]
          }
        ],
        ...(temperature === undefined ? {} : {
          generationConfig: {
            temperature
          }
        })
      }
    }));
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
        "User-Agent": `tokenlab-mcp-server/${VERSION}`
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
