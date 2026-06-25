# Example 8: standard MCP client config

The SDK is a **REST** client. For the MCP ecosystem (including the MCP-only
`rank` and `explain` tools, which have **no REST route**), point a standard MCP
client at the Free2AITools MCP endpoint. The SDK ships **config examples only** —
it contains no proprietary MCP transport.

## Generic MCP server entry (HTTP transport)

```json
{
  "mcpServers": {
    "free2aitools": {
      "type": "http",
      "url": "https://free2aitools.com/api/mcp"
    }
  }
}
```

## Discovering the tools

The canonical, machine-readable tool list (including input schemas for `search`,
`select`, `compare`, `rank`, and `explain`) is served at:

```
https://free2aitools.com/.well-known/mcp.json
```

## Reaching rank / explain

`rank` (search-by-task, MCP default limit 10) and `explain` (FNI factor
breakdown) are **MCP tools only**. Call them through your MCP client's
`tools/call` against the endpoint above. Do **not** expect a REST route — the SDK
intentionally does not expose `rank()`/`explain()` because no REST endpoint
exists for them. For a local, no-network FNI factor view, use the REST SDK's
`getEntityEvidence()` instead.

## Honesty note

Whether reached via REST or MCP, these surfaces return **evidence and rankings**.
They do not assert "the best" choice or guarantee compatibility — the calling
agent makes the final decision.
