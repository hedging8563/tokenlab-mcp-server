# TokenLab MCP Server

Read-only Model Context Protocol server for TokenLab public model discovery.

It exposes public catalog tools for agents that need to choose models, inspect request contracts, or compare pricing before calling TokenLab APIs.

## Tools

- `list_models` - List public TokenLab models, optionally filtered by `recommended_for`.
- `get_model` - Fetch public model contract details for one model ID.
- `get_model_pricing` - Fetch pricing details for one model ID.
- `get_api_overview` - Fetch the agent-readable `llms.txt` overview.

## Run

```bash
npm install
npm start
```

Claude Desktop style config:

```json
{
  "mcpServers": {
    "tokenlab-model-catalog": {
      "command": "node",
      "args": ["/absolute/path/to/tokenlab-mcp-server/src/index.js"]
    }
  }
}
```

No TokenLab API key is required for the default public catalog tools.

## Environment

- `TOKENLAB_API_BASE`: optional, defaults to `https://api.tokenlab.sh`

## Links

- Docs: https://docs.tokenlab.sh
- OpenAPI: https://docs.tokenlab.sh/openapi.json
- Model catalog: https://api.tokenlab.sh/v1/models
- Skills: https://github.com/hedging8563/tokenlab-skills
