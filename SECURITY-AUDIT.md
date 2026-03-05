# Security Audit: gdrive-mcp-server

**Date:** 2026-03-04
**Audited file:** `index.ts` (272 lines), `package.json`
**Version:** 0.7.0 (fork of archived `@modelcontextprotocol/server-gdrive`)

---

## Summary

| Severity | Count |
|----------|-------|
| Critical | 0     |
| High     | 2     |
| Medium   | 4     |
| Low      | 3     |
| Info     | 3     |

---

## Findings

### HIGH-1: Credential file written with default umask (world-readable)

**Severity:** High
**Location:** Line 225, Line 256

```typescript
fs.writeFileSync(credentialsPath, JSON.stringify(auth.credentials));  // line 225
fs.writeFileSync(credentialsPath, JSON.stringify(updated));           // line 256
```

`writeFileSync` creates files with the process's default umask, typically `0o644` (rw-r--r--). This means the credentials file containing `access_token`, `refresh_token`, and `expiry_date` is readable by all users on the system. On a shared machine, any local user can steal the OAuth tokens.

**Recommendation:** Write with mode `0o600`:
```typescript
fs.writeFileSync(credentialsPath, JSON.stringify(updated), { mode: 0o600 });
```

---

### HIGH-2: Unbounded file download into memory

**Severity:** High
**Location:** Lines 122-146

```typescript
const res = await drive.files.get(
  { fileId, alt: "media" },
  { responseType: "arraybuffer" },
);
```

When reading a non-Google-Apps file via `ReadResource`, the entire file is downloaded into memory as an `ArrayBuffer`, then converted to a UTF-8 string or base64. There is no size limit. A multi-gigabyte file would cause the Node.js process to run out of memory and crash (OOM kill).

The same issue exists for Google Apps exports (line 106-109), though those are somewhat bounded by Google's export size limits.

**Recommendation:** Check file size before downloading. The `files.get` metadata call on line 82 should request the `size` field and enforce a maximum (e.g., 50 MB). Alternatively, use streaming responses.

---

### MEDIUM-1: Search query injection via backslash sequences

**Severity:** Medium
**Location:** Lines 176-177

```typescript
const escapedQuery = userQuery.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
const formattedQuery = `fullText contains '${escapedQuery}'`;
```

The escaping handles single quotes and backslashes, which is good and prevents basic breakout from the `'...'` string literal. However, the Google Drive API query language does not use standard SQL escaping. According to Google's documentation, the only characters that need escaping in string literals are `'` (with `\'`) and `\` (with `\\`). This escaping appears correct for the Drive API.

That said, there is no server-side enforcement that the query is safe. If Google ever changes their query parser behavior, or if a future developer changes the query template to use `name contains` or adds boolean operators, the lack of a proper query builder could become exploitable.

**Residual risk:** An attacker cannot break out of the string literal, but they can perform full-text search across all files the OAuth token has access to. If the token has `drive.readonly` scope (line 223), this means searching the entire Drive. This is by design but worth noting.

**Recommendation:** Consider adding query length limits and logging search queries to stderr for audit purposes.

---

### MEDIUM-2: Race condition in token refresh (TOCTOU)

**Severity:** Medium
**Location:** Lines 246-257

```typescript
auth.on("tokens", (tokens) => {
  const existing = JSON.parse(fs.readFileSync(credentialsPath, "utf-8"));
  const updated = {
    ...existing,
    access_token: tokens.access_token ?? existing.access_token,
    expiry_date: tokens.expiry_date ?? existing.expiry_date,
  };
  if (tokens.refresh_token) {
    updated.refresh_token = tokens.refresh_token;
  }
  fs.writeFileSync(credentialsPath, JSON.stringify(updated));
});
```

The token refresh callback reads the credentials file, modifies it in memory, and writes it back. If two requests trigger token refresh concurrently (e.g., two MCP tool calls arrive at nearly the same time when the token is expired), both callbacks will read the same file, and the second write will overwrite the first. This is a classic read-modify-write race condition.

In practice, the `google-auth-library` likely serializes token refresh internally, making this unlikely. But the code does not protect against it.

**Recommendation:** Use a file lock (e.g., `proper-lockfile` package) or an in-process mutex around the read-modify-write cycle.

---

### MEDIUM-3: No input validation on resource URI file ID

**Severity:** Medium
**Location:** Lines 73-80

```typescript
const uri = request.params.uri;
if (!uri.startsWith("gdrive:///")) {
  throw new Error("Invalid resource URI: must start with gdrive:///");
}
const fileId = uri.replace("gdrive:///", "");
if (!fileId || fileId.includes("/") || fileId.includes("..")) {
  throw new Error("Invalid file ID");
}
```

The path traversal checks (`/` and `..`) are good. However, the file ID is not validated against the expected format. Google Drive file IDs are alphanumeric strings (plus hyphens and underscores), typically 28-44 characters. The current code would pass through any string that doesn't contain `/` or `..`, including strings with newlines, null bytes, or other control characters.

The `fileId` is passed directly to the Google API client, which likely handles this safely, but defense in depth would be better.

**Recommendation:** Validate with a regex: `/^[a-zA-Z0-9_-]+$/`

---

### MEDIUM-4: Sensitive paths leaked in error messages

**Severity:** Medium
**Location:** Lines 204-206

```typescript
console.error(
  `OAuth keys not found at ${oauthKeysPath}. ` +
    "Set GDRIVE_OAUTH_PATH or place gcp-oauth.keys.json in the expected location.",
);
```

The full filesystem path to the OAuth keys file is printed to stderr. Since MCP uses stdio transport, stderr is typically visible to the MCP client (Claude Desktop, etc.). This leaks the server's filesystem layout. The default path (line 19-22) reveals the directory structure three levels up from the dist folder.

**Recommendation:** Log a generic message without the full path, or only include the path in debug-level logging.

---

### LOW-1: OAuth keys file read with default permissions

**Severity:** Low
**Location:** Line 210

```typescript
const raw = JSON.parse(fs.readFileSync(oauthKeysPath, "utf-8"));
```

The OAuth keys file (`gcp-oauth.keys.json`) contains `client_id` and `client_secret`. While these are not as sensitive as user tokens (they identify the app, not the user), leaking them could enable phishing attacks where an attacker uses the same client ID to create a fake OAuth consent screen. The file is not checked for safe permissions.

**Recommendation:** Warn if the OAuth keys file is world-readable.

---

### LOW-2: No request timeout or rate limiting

**Severity:** Low
**Location:** Lines 48-200 (all request handlers)

There are no timeouts on Google API calls and no rate limiting on incoming MCP requests. A slow or hanging Google API call would block the server indefinitely. A flood of MCP requests could exhaust API quota.

**Recommendation:** Set timeouts on `googleapis` calls via `gaxios` options. Consider basic rate limiting.

---

### LOW-3: Error objects may leak internal details

**Severity:** Low
**Location:** Lines 199, 79, 75, 174

Error messages from Google API calls (thrown by `googleapis`) may contain internal details like request IDs, token fragments, or API error messages that reference internal state. These errors propagate to the MCP client as-is.

**Recommendation:** Wrap Google API calls in try-catch blocks and return sanitized error messages.

---

### INFO-1: Dependencies use wide semver ranges

**Severity:** Info
**Location:** `package.json` lines 22-24

```json
"@google-cloud/local-auth": "^3.0.1",
"@modelcontextprotocol/sdk": "^1.0.1",
"googleapis": "^144.0.0"
```

The `^` prefix allows minor and patch updates. While `package-lock.json` pins exact versions, anyone installing without the lockfile gets whatever latest compatible version is published. A supply chain attack on any of these packages (or their transitive dependencies) would be pulled in automatically.

The locked versions appear current. No known CVEs were identified for the locked versions as of the audit date.

**Recommendation:** Consider pinning exact versions in `package.json` or using `npm audit` in CI.

---

### INFO-2: sourceMap enabled in production build

**Severity:** Info
**Location:** `tsconfig.json` line 13

```json
"sourceMap": true
```

Source maps are generated and shipped in the `dist` folder (which is what gets published to npm per the `files` field). This makes reverse engineering trivial, though for an open-source project this is irrelevant.

**Recommendation:** No action needed for an open-source project. If the source were proprietary, disable source maps for production builds.

---

### INFO-3: Server logs to stderr (by design, but notable)

**Severity:** Info
**Location:** Lines 257, 262

The server correctly uses `console.error` (stderr) rather than `console.log` (stdout) for diagnostic messages, since MCP uses stdout for the JSON-RPC protocol. This is correct behavior. However, the token refresh log on line 257 confirms to stderr observers that a refresh occurred, which is minor information disclosure.

---

## Architecture Notes

- The server requests `drive.readonly` scope (line 223), which is the minimum needed. Good.
- The `gdrive:///` URI scheme correctly uses triple slash (authority is empty). The path traversal guards on line 78 are appropriate.
- The MCP SDK handles JSON-RPC framing and validation, so raw protocol injection is not a concern at this layer.
- The `authenticate` function from `@google-cloud/local-auth` starts a local HTTP server for the OAuth callback. This is only used during the `auth` flow (line 267), not during normal server operation.

## Recommended Priority

1. **HIGH-1** (credential file permissions) - quick fix, high impact
2. **HIGH-2** (unbounded download) - needs size check before download
3. **MEDIUM-3** (file ID validation) - quick regex addition
4. **MEDIUM-2** (TOCTOU on token refresh) - lower urgency, unlikely in practice
5. **MEDIUM-1** (query length limit) - quick addition
6. **MEDIUM-4** (path in error messages) - quick fix
