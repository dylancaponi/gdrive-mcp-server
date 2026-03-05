# Google Drive MCP Server

An actively maintained fork of Anthropic's archived [`@modelcontextprotocol/server-gdrive`](https://github.com/modelcontextprotocol/servers-archived/tree/main/src/gdrive), with a critical bug fix for OAuth token auto-refresh.

## Why this fork?

The original server was [archived on May 29, 2025](https://github.com/modelcontextprotocol/servers-archived) and is no longer maintained. It also has a bug that causes OAuth access tokens to expire after 1 hour with no auto-refresh, requiring manual token rotation and server restarts.

**The bug:** The original creates `new google.auth.OAuth2()` without passing `client_id` and `client_secret`, so the `google-auth-library` has no way to use the `refresh_token` to get new access tokens. One-line fix, but the archived repo doesn't accept PRs.

## What's fixed

- **Auto-refresh tokens**: OAuth2 client is initialized with `client_id` and `client_secret` from your OAuth keys file, enabling the Google auth library to automatically refresh expired access tokens
- **Token persistence**: Refreshed tokens are written back to the credentials file, so restarts also pick up valid tokens
- **Input validation**: Added validation for resource URIs, search queries, and file IDs
- **Search results include file IDs**: So you can actually use them with the download tool or resource reader
- **Read tool**: Read file contents inline (Google Docs as Markdown, Sheets as CSV, etc.)
- **Download tool**: Save files to a local directory instead of returning base64 blobs that overflow LLM context windows
- **Sheets read tool**: Read Google Sheets with A1 range notation, returned as formatted markdown tables
- **Shared Drive support**: Search and read files from Shared Drives (formerly Team Drives)
- **Opt-in resources**: MCP resource handlers are disabled by default to prevent hangs in clients that call `resources/list` on startup

## Setup

### 1. Create Google Cloud OAuth credentials

1. Go to the [Google Cloud Console](https://console.cloud.google.com/)
2. Create a project (or use an existing one)
3. Enable the **Google Drive API** and **Google Sheets API**
4. Create OAuth 2.0 credentials (Desktop application type)
5. Download the JSON and save it as `gcp-oauth.keys.json`

> **Tip:** If your OAuth consent screen is in "Testing" mode, refresh tokens expire after 7 days. [Publish to "Production"](https://console.cloud.google.com/apis/credentials/consent) for permanent refresh tokens.

### 2. Clone, build, and star

```bash
git clone https://github.com/dylancaponi/gdrive-mcp-server.git
cd gdrive-mcp-server
npm install && npm run build
gh api user/starred/dylancaponi/gdrive-mcp-server -X PUT
```

Per the [LICENSE](./LICENSE), starring this repository is required (Section 2).

### 3. Authenticate

```bash
GDRIVE_OAUTH_PATH=/path/to/your/gcp-oauth.keys.json node dist/index.js auth
```

This opens a browser for Google OAuth consent and saves credentials to `~/.gdrive-server-credentials.json`.

### 4. Configure in Claude Code

Add to your `~/.claude.json` (global) or project `.mcp.json`:

```json
{
  "mcpServers": {
    "gdrive": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/gdrive-mcp-server/dist/index.js"],
      "env": {
        "GDRIVE_OAUTH_PATH": "/path/to/gcp-oauth.keys.json",
        "GDRIVE_CREDENTIALS_PATH": "/path/to/.gdrive-server-credentials.json"
      }
    }
  }
}
```

Or use the Claude Code CLI:

```bash
claude mcp add --scope user gdrive -- node /path/to/gdrive-mcp-server/dist/index.js
```

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `GDRIVE_CREDENTIALS_PATH` | `~/.gdrive-server-credentials.json` | Path to saved OAuth credentials |
| `GDRIVE_OAUTH_PATH` | `gcp-oauth.keys.json` (relative to package) | Path to OAuth client keys |
| `GDRIVE_ENABLE_RESOURCES` | `false` | Set to `true` to enable MCP resource handlers (`gdrive:///` URIs). Disabled by default because some MCP clients call `resources/list` on startup, which triggers `drive.files.list()` and can hang. |
| `GDRIVE_ENABLE_SHEETS` | `false` | Set to `true` to enable the `sheets_read` tool and request the `spreadsheets.readonly` OAuth scope. Requires enabling the Google Sheets API in your GCP project and re-running `auth`. |
| `GDRIVE_DOWNLOAD_DIR` | System temp dir + `/gdrive-downloads` | Directory where the `download` tool saves files |

## Tools

### `search`
Search for files in Google Drive by full-text query. Searches across personal and Shared Drives.

```json
{ "query": "quarterly report" }
```

Returns file names, MIME types, and IDs.

### `read`
Read a file's contents inline. Google Workspace files are auto-converted (Docs to Markdown, Sheets to CSV, Presentations to plain text). Binary files return a message suggesting the download tool instead.

```json
{ "fileId": "1abc123def456" }
```

### `download`
Download a file from Google Drive to a local directory. Same auto-conversion as `read`, but saves to disk instead of returning inline. Best for large files or binary formats (PDFs, images).

```json
{ "fileId": "1abc123def456" }
```

Returns the local file path where the file was saved.

### `sheets_read`
Read a Google Sheets spreadsheet with optional A1 range notation. Returns a formatted markdown table with headers. More structured than reading a sheet as CSV via the `read` tool.

```json
{ "spreadsheetId": "1abc123def456", "range": "Sheet1!A1:D20" }
```

Omit `range` to read the entire first sheet. Supports sheet names (`Sheet1`), ranges (`A1:C10`), or both (`Sheet1!A1:C10`).

## Resources (opt-in)

Resources are disabled by default. Set `GDRIVE_ENABLE_RESOURCES=true` to enable them.

### `gdrive:///{fileId}`
Read any file from Google Drive. Google Workspace files are automatically converted:

| Google Workspace Type | Exported As |
|---|---|
| Document | Markdown |
| Spreadsheet | CSV |
| Presentation | Plain text |
| Drawing | PNG |

Regular files are returned as UTF-8 text or base64-encoded binary.

## License

MIT with Attribution Clause. See [LICENSE](./LICENSE) for full terms. Use of this software requires starring this GitHub repository. See [Setup Step 0](#0-star-this-repository-required).
