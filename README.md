# TokenLab MCP Server

[![CI](https://github.com/hedging8563/tokenlab-mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/hedging8563/tokenlab-mcp-server/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40tokenlabai%2Fmcp-server)](https://www.npmjs.com/package/@tokenlabai/mcp-server)
[![npm downloads](https://img.shields.io/npm/dm/%40tokenlabai%2Fmcp-server)](https://www.npmjs.com/package/@tokenlabai/mcp-server)

OpenAPI-generated Model Context Protocol server for TokenLab public model discovery, pricing, native LLM endpoints, multimodal generation, async tasks, files, embeddings, rerank, translation, resources, prompts, and the broader developer API.

It exposes public catalog tools for agents that need to choose models, inspect supported request formats, or compare pricing before calling TokenLab APIs. Credentialed tools cover text inference, image generation and editing, video, music, 3D, async task polling, embeddings, rerank, and text translation.

## Generated Tool Profiles

The checked-in `generated/tools.json` manifest is generated from TokenLab's public OpenAPI document plus the small MCP-only overlay in `contract/mcp-overlay.json`. Version 0.6.5 generates 76 endpoint tools; two composite discovery tools are registered at runtime.

| Profile | Endpoint tools | Coverage |
| --- | ---: | --- |
| `catalog` | 4 | Public model discovery and pricing only; no API key required |
| `core` (default) | 29 | Catalog and pricing; Chat Completions, Responses, Anthropic Messages, Gemini generateContent; images, video, music, 3D, speech and transcription; async tasks; files; embeddings, rerank, and translation |
| `full` | 76 | Every allowlisted developer API operation in the checked-in OpenAPI snapshot, including core plus response lifecycle, batches, worlds, and native model discovery |

All profiles also include `compare_models` and `get_api_overview`, producing totals of 6, 31, and 78 tools. Realtime and streaming-only operations are excluded because stdio MCP tool calls return one final result. API operations that accept `stream` constrain it to `false` in the MCP overlay, and the Gemini query-string API key is intentionally hidden from tool arguments.

Set `TOKENLAB_MCP_TOOL_PROFILE=catalog` for the smallest public-only tool list or `TOKENLAB_MCP_TOOL_PROFILE=full` for the broad developer API. Tool names, descriptions, input JSON Schemas, HTTP bindings, content types, auth requirements, and task behavior can be inspected in [`generated/tools.json`](./generated/tools.json).

The smaller [`generated/public-contract.json`](./generated/public-contract.json) is the machine-readable projection used by TokenLab's website and other public consumers. It contains package identity, profile counts, core tool layers, resources, prompts, and source hashes without copying all endpoint schemas.

## Native MCP Features

- JSON tool responses include `structuredContent` while retaining serialized text for older clients.
- Generated tools expose human-readable titles, standard read-only/destructive/idempotent/open-world annotations, auth/profile metadata, and response request IDs when available.
- Three resources expose the live API overview, the package's OpenAPI snapshot, and the compact MCP public contract.
- `choose_tokenlab_model` and `build_tokenlab_request` prompts guide agents to use live model truth and preserve native endpoint shapes.
- Server instructions tell clients to confirm billable or destructive operations and treat external model/API output as untrusted content.

## Run

```bash
npm install
npm start
```

Install from npm:

```bash
npx -y @tokenlabai/mcp-server
```

Agent-assisted installers can follow [`llms-install.md`](./llms-install.md) for a credential-safe setup and verification flow.

Run in Docker:

```bash
docker build -t tokenlab-mcp-server .
docker run --rm -i tokenlab-mcp-server
```

Add `-e TOKENLAB_API_KEY` when using credentialed API tools. Public catalog tools do not require a key.

Claude Desktop style config:

```json
{
  "mcpServers": {
    "tokenlab-model-catalog": {
      "command": "npx",
      "args": ["-y", "@tokenlabai/mcp-server"],
      "env": {
        "TOKENLAB_API_BASE": "https://api.tokenlab.sh"
      }
    }
  }
}
```

No TokenLab API key is required for public catalog and pricing operations. Set `TOKENLAB_API_KEY` when credentialed tools should call TokenLab APIs. Generated tools preserve the OpenAPI request shape for OpenAI-compatible and native endpoints instead of flattening them into a shared prompt format.

Multipart operations accept local file paths. Small image and audio responses are returned as native MCP content; larger or other binary responses are written to `TOKENLAB_ARTIFACT_DIR` and returned as a path with MIME type and byte count.

## Sync and Async Media Results

Video, music, and 3D creation tools always return an async task. Image generation and editing may return a completed result or an async task depending on the selected model and request.

Media tools preserve the complete TokenLab API response under `response` and add a normalized `delivery` summary:

```json
{
  "delivery": {
    "mode": "async",
    "task_id": "ldtask_...",
    "status": "pending",
    "poll_url": "/v1/tasks/ldtask_...",
    "terminal": false,
    "next_tool": "get_task_status"
  },
  "response": {}
}
```

Use `delivery.mode` instead of assuming all image requests are synchronous. For async tasks, call `get_task_status` with `{ "id": delivery.task_id }` until `delivery.terminal` is `true`. Completion is determined from `status`, not from an optional progress field.

## Environment

- `TOKENLAB_API_BASE`: optional, defaults to `https://api.tokenlab.sh`
- `TOKENLAB_API_KEY`: optional; required for text inference, multimodal generation, async task, embedding, rerank, and translation tools
- `TOKENLAB_MCP_TOOL_PROFILE`: optional, `catalog`, `core` (default), or `full`
- `TOKENLAB_REQUEST_TIMEOUT_MS`: optional request timeout in milliseconds, defaults to `120000`
- `TOKENLAB_MCP_MAX_FILE_BYTES`: optional maximum local upload size per file, defaults to `104857600` (100 MiB)
- `TOKENLAB_MCP_INLINE_BYTES`: optional maximum binary/JSON response size returned inline, defaults to `2097152` (2 MiB)
- `TOKENLAB_ARTIFACT_DIR`: optional output directory for non-inline response artifacts, defaults to the OS temp directory under `tokenlab-mcp`

## Contract Sync

The public OpenAPI document is the API contract source. The overlay contains only MCP-specific choices: profile exposure, stable tool aliases, secret omission, non-streaming constraints, content-type variants, async task semantics, and the compact public projection consumed by the website and docs gates.

```bash
npm run contract:sync      # fetch OpenAPI and regenerate the manifest
npm run contract:check     # fail when generated output is stale
npm test                   # compile both profiles and test routing, tasks, files, and binary output
```

The scheduled `Sync TokenLab OpenAPI contract` workflow runs this full sequence and commits only the verified OpenAPI snapshot and generated manifest to `main`. A failed fetch, generation, schema compilation, or test leaves `main` unchanged.

## MCP Registry Metadata

This repository includes `server.json` for the official MCP Registry.

Release metadata:

- npm package: `@tokenlabai/mcp-server@0.6.5`
- MCP registry name: `io.github.hedging8563/tokenlab`
- `package.json.mcpName`: `io.github.hedging8563/tokenlab`

For a new release:

1. Bump the matching versions in `package.json`, `package-lock.json`, and `server.json`.
2. Push a matching tag such as `v0.6.0`.
3. The publish workflow tests and publishes npm through trusted publishing, then publishes the MCP Registry entry through GitHub Actions OIDC.

The same workflow can be run manually from `main` to republish only the current MCP Registry metadata. No npm or MCP Registry token is stored in GitHub.

## Security

Use the `catalog` profile when no credentialed tools are needed. Keep `TOKENLAB_API_KEY` in the local MCP client's secret environment, enable human confirmation for billable and destructive calls, and review tool annotations before granting persistent approval. Do not send a TokenLab API key to an untrusted hosted MCP server.

## Links

- Website: https://tokenlab.sh/mcp
- Docs: https://docs.tokenlab.sh
- OpenAPI: https://docs.tokenlab.sh/openapi.json
- Model catalog: https://api.tokenlab.sh/v1/models
- Skills: https://github.com/hedging8563/tokenlab-skills
