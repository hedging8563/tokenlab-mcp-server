# Install TokenLab MCP Server

Use the published npm package. Do not clone or build the repository unless the user explicitly asks for a source checkout.

## Requirements

- Node.js 18.17 or newer
- An MCP client that supports stdio servers
- `TOKENLAB_API_KEY` only when the user wants to call credentialed API tools

## MCP Configuration

Add this server entry to the client's MCP configuration:

```json
{
  "mcpServers": {
    "tokenlab": {
      "command": "npx",
      "args": ["-y", "@tokenlabai/mcp-server"],
      "env": {
        "TOKENLAB_API_BASE": "https://api.tokenlab.sh"
      }
    }
  }
}
```

Public model catalog and pricing tools work without credentials. When inference is requested, add the user's TokenLab key without printing or committing it. Do not put API keys in MCP tool arguments:

```json
{
  "TOKENLAB_API_KEY": "<TOKENLAB_API_KEY>"
}
```

Set `TOKENLAB_MCP_TOOL_PROFILE=catalog` when the client should expose only the six public discovery tools. The default `core` profile exposes 31 tools, and `full` exposes 78.

## Verification

Start or reload the MCP client, then confirm these public tools are available without an API key:

- `list_models`
- `get_model`
- `get_model_pricing`
- `compare_models`
- `get_api_overview`

The default `core` profile also exposes generated credentialed tools for:

- OpenAI Chat Completions and Responses
- Anthropic Messages and Gemini generateContent
- image generation/editing through JSON or local multipart files
- video, music, 3D, speech, transcription, and audio translation
- task polling/cancellation and file operations
- embeddings, multimodal embeddings, rerank, and text translation

Set `TOKENLAB_MCP_TOOL_PROFILE=full` to expose every allowlisted developer operation generated from the public OpenAPI contract. Realtime and streaming-only operations remain excluded. Compatible clients can also discover three resources and two prompts for contract inspection, model selection, and request construction.

Video, music, and 3D tools return async task summaries. Image tools may return a completed result or an async task summary. When `delivery.mode` is `async`, call `get_task_status` with `{ "id": delivery.task_id }` until `delivery.terminal` is `true`.

If startup fails, run `node --version` and confirm it is at least `18.17`, then run `npx -y @tokenlabai/mcp-server` once in a terminal to surface npm or network errors.
