#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const VERSION = "0.3.0";
const API_BASE = (process.env.TOKENLAB_API_BASE || "https://api.tokenlab.sh").replace(/\/+$/, "");
const API_KEY = process.env.TOKENLAB_API_KEY || "";
const configuredTimeoutMs = Number.parseInt(process.env.TOKENLAB_REQUEST_TIMEOUT_MS || "30000", 10);
const REQUEST_TIMEOUT_MS = Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs > 0
  ? configuredTimeoutMs
  : 30_000;

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

const chatMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "function", "tool", "developer"])
    .describe("OpenAI Chat Completions message role."),
  content: z.union([
    z.string(),
    z.array(z.object({}).passthrough()),
    z.null()
  ]).optional().describe("Text, OpenAI-compatible multimodal content parts, or null for tool/function messages."),
  name: z.string().optional().describe("Optional name for a function or tool message."),
  tool_calls: z.array(z.object({}).passthrough()).optional().describe("Tool calls made by an assistant message."),
  tool_call_id: z.string().optional().describe("Tool call ID answered by a tool message.")
}).passthrough();

const chatCompletionToolSchema = z.object({
  type: z.literal("function"),
  function: z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    parameters: z.object({}).passthrough().optional()
  }).passthrough()
}).passthrough();

const openObjectSchema = z.object({}).passthrough();

const anthropicMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.union([
    z.string(),
    z.array(openObjectSchema).min(1)
  ])
});

const geminiContentSchema = z.object({
  role: z.enum(["user", "model"]).optional(),
  parts: z.array(openObjectSchema).min(1)
}).passthrough();

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
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });

  const text = await response.text();

  if (!response.ok) {
    const detail = text.length > 2_000 ? `${text.slice(0, 2_000)}...` : text;
    throw new Error(`TokenLab request failed: ${response.status} ${response.statusText}\n${detail}`);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error("TokenLab returned a successful response that was not valid JSON.");
  }
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
  "create_chat_completion",
  "Create a non-streaming TokenLab OpenAI-compatible Chat Completions call. Requires TOKENLAB_API_KEY.",
  {
    model: z.string().min(1).describe("Public TokenLab model ID."),
    messages: z.array(chatMessageSchema).min(1).describe("OpenAI-compatible conversation messages, including text, image, tool, and function messages."),
    temperature: z.number().min(0).max(2).optional().describe("Optional sampling temperature."),
    top_p: z.number().min(0).max(1).optional().describe("Optional nucleus sampling probability."),
    n: z.number().int().min(1).max(128).optional().describe("Optional number of non-streaming completions."),
    stop: z.union([z.string(), z.array(z.string()).min(1).max(4)]).optional().describe("Optional stop sequence or up to four stop sequences."),
    max_tokens: z.number().int().min(1).optional().describe("Optional maximum generated tokens."),
    max_completion_tokens: z.number().int().min(1).optional().describe("Optional completion-token cap for compatible reasoning models."),
    presence_penalty: z.number().min(-2).max(2).optional().describe("Optional presence penalty."),
    frequency_penalty: z.number().min(-2).max(2).optional().describe("Optional frequency penalty."),
    tools: z.array(chatCompletionToolSchema).optional().describe("Optional OpenAI function tools available to the model."),
    tool_choice: z.union([
      z.enum(["none", "auto", "required"]),
      z.object({
        type: z.literal("function"),
        function: z.object({ name: z.string().min(1) })
      })
    ]).optional().describe("Optional OpenAI tool-choice setting."),
    response_format: z.object({
      type: z.enum(["text", "json_object"])
    }).optional().describe("Optional response format."),
    seed: z.number().int().optional().describe("Optional deterministic seed for compatible models."),
    user: z.string().optional().describe("Optional end-user identifier."),
    parallel_tool_calls: z.boolean().optional().describe("Whether compatible models may make parallel tool calls."),
    reasoning_effort: z.string().optional().describe("Optional reasoning-effort hint for compatible models."),
    logprobs: z.boolean().optional().describe("Whether to return output-token log probabilities."),
    top_logprobs: z.number().int().min(0).max(20).optional().describe("Optional number of likely tokens to include with log probabilities."),
    top_k: z.number().int().min(1).optional().describe("Optional top-k sampling cutoff for compatible models."),
    logit_bias: z.record(z.string(), z.number()).optional().describe("Optional per-token logit-bias map."),
    modalities: z.array(z.string()).min(1).optional().describe("Optional requested output modalities, such as text or audio."),
    audio: z.object({}).passthrough().optional().describe("Optional audio output configuration."),
    prediction: z.object({}).passthrough().optional().describe("Optional prediction hint for compatible models."),
    service_tier: z.string().nullable().optional().describe("Optional service-tier hint for compatible models.")
  },
  async (input) => {
    const body = Object.fromEntries(
      Object.entries({
        ...input,
        stream: false
      }).filter(([, value]) => value !== undefined)
    );

    return textResult(await fetchJson("/v1/chat/completions", {
      method: "POST",
      auth: true,
      body
    }));
  }
);

server.tool(
  "create_response",
  "Create a non-streaming TokenLab Responses API call with text or native structured input. Requires TOKENLAB_API_KEY.",
  {
    model: z.string().min(1).describe("Public TokenLab model ID."),
    input: z.union([
      z.string().min(1),
      z.array(openObjectSchema).min(1)
    ]).describe("Responses API input as text or native structured input items."),
    instructions: z.string().optional().describe("Optional system/developer instructions."),
    max_output_tokens: z.number().int().min(1).optional().describe("Optional output token cap."),
    temperature: z.number().optional().describe("Optional sampling temperature."),
    tools: z.array(openObjectSchema).optional().describe("Native Responses API tool definitions."),
    tool_choice: z.union([z.string(), openObjectSchema]).optional().describe("Tool choice policy or explicit tool selection."),
    reasoning_effort: z.string().optional().describe("Reasoning-effort hint for compatible models."),
    include: z.array(z.string()).optional().describe("Additional response sections to include."),
    service_tier: z.string().nullable().optional().describe("Optional service-tier hint."),
    truncation_strategy: z.string().optional().describe("Optional truncation strategy."),
    seed: z.number().int().optional().describe("Optional deterministic seed."),
    user: z.string().optional().describe("Optional end-user identifier."),
    parallel_tool_calls: z.boolean().optional().describe("Whether the model may issue parallel tool calls."),
    metadata: openObjectSchema.optional().describe("Optional request metadata."),
    text: openObjectSchema.optional().describe("Optional native text formatting configuration.")
  },
  async (input) => {
    return textResult(await fetchJson("/v1/responses", {
      method: "POST",
      auth: true,
      body: Object.fromEntries(
        Object.entries({ ...input, stream: false }).filter(([, value]) => value !== undefined)
      )
    }));
  }
);

server.tool(
  "create_anthropic_message",
  "Create a non-streaming TokenLab Anthropic Messages call with native messages, multimodal blocks, and tools. A prompt shortcut remains available for simple calls. Requires TOKENLAB_API_KEY.",
  {
    model: z.string().min(1).describe("Public TokenLab Claude-compatible model ID."),
    messages: z.array(anthropicMessageSchema).min(1).optional().describe("Native Anthropic conversation messages."),
    prompt: z.string().min(1).optional().describe("Convenience shortcut for one user text message; do not combine with messages."),
    system: z.string().optional().describe("Optional system prompt."),
    max_tokens: z.number().int().min(1).default(512).describe("Maximum output tokens."),
    temperature: z.number().min(0).max(1).optional().describe("Optional sampling temperature."),
    top_p: z.number().min(0).max(1).optional().describe("Optional nucleus sampling probability."),
    top_k: z.number().int().min(1).optional().describe("Optional top-k sampling cutoff."),
    stop_sequences: z.array(z.string()).optional().describe("Optional stop sequences."),
    tools: z.array(openObjectSchema).optional().describe("Native Anthropic tool definitions."),
    tool_choice: z.union([z.string(), openObjectSchema]).optional().describe("Tool choice policy or explicit tool selection."),
    metadata: openObjectSchema.optional().describe("Optional request metadata."),
    thinking: openObjectSchema.optional().describe("Thinking configuration for compatible models."),
    service_tier: z.string().optional().describe("Optional service-tier hint.")
  },
  async ({ prompt, messages, ...input }) => {
    if (prompt && messages) {
      throw new Error("Provide either prompt or messages, not both.");
    }
    if (!prompt && !messages) {
      throw new Error("Provide prompt or at least one native Anthropic message.");
    }

    return textResult(await fetchJson("/v1/messages", {
      method: "POST",
      auth: true,
      body: {
        ...input,
        messages: messages || [{ role: "user", content: prompt }],
        stream: false
      }
    }));
  }
);

server.tool(
  "create_gemini_content",
  "Create a TokenLab Gemini generateContent call with native contents, multimodal parts, generation config, and tools. A prompt shortcut remains available for simple calls. Requires TOKENLAB_API_KEY.",
  {
    model: z.string().min(1).describe("Public TokenLab Gemini-compatible model ID."),
    contents: z.array(geminiContentSchema).min(1).optional().describe("Native Gemini conversation contents."),
    prompt: z.string().min(1).optional().describe("Convenience shortcut for one user text part; do not combine with contents."),
    temperature: z.number().min(0).optional().describe("Convenience temperature setting; do not combine with generationConfig.temperature."),
    systemInstruction: openObjectSchema.optional().describe("Native Gemini system instruction."),
    generationConfig: openObjectSchema.optional().describe("Native Gemini generation configuration."),
    safetySettings: z.array(openObjectSchema).optional().describe("Native Gemini safety settings."),
    tools: z.array(openObjectSchema).optional().describe("Native Gemini tools."),
    toolConfig: openObjectSchema.optional().describe("Native Gemini tool configuration."),
    cachedContent: z.string().optional().describe("Optional cached content resource name.")
  },
  async ({ model, prompt, contents, temperature, generationConfig, ...input }) => {
    if (prompt && contents) {
      throw new Error("Provide either prompt or contents, not both.");
    }
    if (!prompt && !contents) {
      throw new Error("Provide prompt or at least one native Gemini content item.");
    }
    if (temperature !== undefined && generationConfig?.temperature !== undefined) {
      throw new Error("Set temperature either directly or in generationConfig, not both.");
    }

    return textResult(await fetchJson(`/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      auth: true,
      body: {
        ...input,
        contents: contents || [{ role: "user", parts: [{ text: prompt }] }],
        ...(generationConfig || temperature !== undefined ? {
          generationConfig: {
            ...generationConfig,
            ...(temperature === undefined ? {} : { temperature })
          }
        } : {})
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
