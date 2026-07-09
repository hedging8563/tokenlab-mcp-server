# TokenLab MCP Server

Model Context Protocol server for TokenLab public model discovery, pricing, OpenAI-compatible Chat Completions, native endpoint guidance, and optional inference helpers.

It exposes public catalog tools for agents that need to choose models, inspect supported request formats, or compare pricing before calling TokenLab APIs. Optional inference tools require `TOKENLAB_API_KEY`.

## Tools

- `list_models` - List public TokenLab models, optionally filtered by `recommended_for`.
- `get_model` - Fetch public model details for one model ID.
- `get_model_pricing` - Fetch pricing details for one model ID.
- `compare_models` - Compare details and pricing for several model IDs.
- `get_api_overview` - Fetch the agent-readable `llms.txt` overview.
- `create_chat_completion` - Call TokenLab's OpenAI-compatible non-streaming Chat Completions API. Requires `TOKENLAB_API_KEY`.
- `create_response` - Call TokenLab Responses API. Requires `TOKENLAB_API_KEY`.
- `create_anthropic_message` - Call TokenLab Anthropic Messages API. Requires `TOKENLAB_API_KEY`.
- `create_gemini_content` - Call TokenLab Gemini generateContent API. Requires `TOKENLAB_API_KEY`.

## Run

```bash
npm install
npm start
```

Install from npm:

```bash
npx -y @tokenlabai/mcp-server
```

Claude Desktop style config:

```json
{
  "mcpServers": {
    "tokenlab-model-catalog": {
      "command": "node",
      "args": ["/absolute/path/to/tokenlab-mcp-server/src/index.js"],
      "env": {
        "TOKENLAB_API_BASE": "https://api.tokenlab.sh"
      }
    }
  }
}
```

No TokenLab API key is required for the public catalog tools. Set `TOKENLAB_API_KEY` only when you want the inference helper tools to call paid TokenLab APIs. `create_chat_completion` supports OpenAI-compatible messages, multimodal content parts, function calling, and common generation controls. MCP tools return a normal JSON result, so streaming is intentionally disabled.

## Environment

- `TOKENLAB_API_BASE`: optional, defaults to `https://api.tokenlab.sh`
- `TOKENLAB_API_KEY`: optional; required only for `create_chat_completion`, `create_response`, `create_anthropic_message`, and `create_gemini_content`

## MCP Registry Metadata

This repository includes `server.json` for the official MCP Registry.

Current publication:

- npm package: `@tokenlabai/mcp-server@0.2.2`
- MCP registry name: `io.github.hedging8563/tokenlab`
- Official MCP Registry status: active
- `package.json.mcpName`: `io.github.hedging8563/tokenlab`

For a new release:

1. Bump the matching versions in `package.json`, `package-lock.json`, and `server.json`.
2. Push a matching tag such as `v0.3.0`.
3. The publish workflow tests and publishes npm through trusted publishing, then publishes the MCP Registry entry through GitHub Actions OIDC.

The same workflow can be run manually from `main` to republish only the current MCP Registry metadata. No npm or MCP Registry token is stored in GitHub.

## Links

- Docs: https://docs.tokenlab.sh
- OpenAPI: https://docs.tokenlab.sh/openapi.json
- Model catalog: https://api.tokenlab.sh/v1/models
- Skills: https://github.com/hedging8563/tokenlab-skills
