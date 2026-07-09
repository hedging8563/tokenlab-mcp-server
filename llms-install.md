# Install TokenLab MCP Server

Use the published npm package. Do not clone or build the repository unless the user explicitly asks for a source checkout.

## Requirements

- Node.js 18.17 or newer
- An MCP client that supports stdio servers
- `TOKENLAB_API_KEY` only when the user wants to call inference tools

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

Public model catalog and pricing tools work without credentials. When inference is requested, add the user's TokenLab key without printing or committing it:

```json
{
  "TOKENLAB_API_KEY": "<TOKENLAB_API_KEY>"
}
```

## Verification

Start or reload the MCP client, then confirm these public tools are available without an API key:

- `list_models`
- `get_model`
- `get_model_pricing`
- `compare_models`
- `get_api_overview`

The server also exposes four credentialed inference tools:

- `create_chat_completion`
- `create_response`
- `create_anthropic_message`
- `create_gemini_content`

If startup fails, run `node --version` and confirm it is at least `18.17`, then run `npx -y @tokenlabai/mcp-server` once in a terminal to surface npm or network errors.
