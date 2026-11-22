# API keys and MCP

Open **API / MCP** in the dashboard to create a named key for each tool. The secret is displayed once; copy it before closing the dialog. Only its SHA-256 hash is persisted. Expiry is optional and revocation takes effect on the next request. Expired/revoked keys remain listed for reference. The configured `API_TOKEN_HASH` remains supported as a legacy full-access credential.

| Scope | Allowed |
|---|---|
| `read` | API reads, including authenticated previews and sharing metadata |
| `publish` | Reads, private draft creation, content replacement, theme preview/application, explicit version publication |
| `full` | All document/folder operations, including access changes and deletion |

All scopes require an administrator session to manage keys. A publish key cannot create an artifact with a non-private visibility, access code or folder assignment; configure sharing/folder membership in the dashboard. It can update and approve versions of existing artifacts that are already shared. Keys are instance-wide, not limited to one client or folder.

## MCP connection

Endpoint: `https://YOUR-ADMIN-HOST/mcp` (the **admin** origin, not the public content origin).

The development UI proxies `/mcp` to the admin process, so its displayed `http://localhost:5173/mcp` endpoint works locally. The supplied Caddy and Tailscale configurations already forward the entire admin origin. If you maintain a proxy that only forwards `/api`, also forward `/mcp` to the same admin upstream.

Use an MCP client supporting Streamable HTTP and configure the request header:

```text
Authorization: Bearer YOUR_API_KEY
```

For Claude Code:

```bash
claude mcp add --transport http blazz https://YOUR-ADMIN-HOST/mcp --header "Authorization: Bearer ${BLAZZ_ARTIFACTS_TOKEN}"
```

For clients accepting JSON configuration:

```json
{
  "mcpServers": {
    "blazz": {
      "type": "http",
      "url": "https://YOUR-ADMIN-HOST/mcp",
      "headers": { "Authorization": "Bearer YOUR_API_KEY" }
    }
  }
}
```

Keep client configuration containing a key outside version control. The dashboard shows the endpoint and offers one-click URL copying. The server uses stateless JSON responses and negotiates protocol `2025-03-26`; it does not provide an SSE subscription, OAuth login, or browser cookie authentication. If a client sends an Origin header, it must match a configured admin origin.

## Tools

- `list_artifacts`: list artifacts and working/published versions.
- `get_artifact` (`id`): get one artifact and its sharing metadata.
- `create_artifact` (`filename`, `content`, optional `title`, `slug`, `message`): create a private draft from HTML, Markdown, JSON, JSX or TSX text.
- `update_artifact` (`id`, `filename`, `content`, optional `message`): create a working version; visitors keep the last approved version.
- `publish_artifact` (`id`, `versionId`): explicitly approve a version, preserving the URL and existing visibility. Ask the user to approve publication before invoking it.

Read keys only see and can call the first two tools. MCP tool operations re-enter the same HTTP API with the same key, so the same scope checks, upload validation and publication rules apply. Requests are limited to 2 MiB (or the configured upload limit plus metadata, whichever is smaller); use the CLI for larger files and ZIP/PDF uploads.

Transport reference: https://modelcontextprotocol.io/specification/2025-03-26/basic/transports
