#!/usr/bin/env node

import { authenticate } from "@google-cloud/local-auth";
import { drive_v3 } from "@googleapis/drive";
import { sheets_v4 } from "@googleapis/sheets";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import fs from "fs";
import { OAuth2Client } from "google-auth-library";
import os from "os";
import path from "path";

const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024; // 100 MB
const MAX_QUERY_LENGTH = 1000;
const ENABLE_RESOURCES = process.env.GDRIVE_ENABLE_RESOURCES === "true";
const ENABLE_SHEETS = process.env.GDRIVE_ENABLE_SHEETS === "true";
const DOWNLOAD_DIR =
  process.env.GDRIVE_DOWNLOAD_DIR ||
  path.join(os.tmpdir(), "gdrive-downloads");

function writeCredentials(filePath: string, data: unknown): void {
  const json = JSON.stringify(data);
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, json, { mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
}

const credentialsPath =
  process.env.GDRIVE_CREDENTIALS_PATH ||
  path.join(os.homedir(), ".gdrive-server-credentials.json");
const oauthKeysPath =
  process.env.GDRIVE_OAUTH_PATH ||
  path.join(os.homedir(), "gcp-oauth.keys.json");

let drive: drive_v3.Drive;
let sheets: sheets_v4.Sheets | null = null;

const serverCapabilities: Record<string, Record<string, never>> = { tools: {} };
if (ENABLE_RESOURCES) {
  serverCapabilities.resources = {};
}

const server = new Server(
  {
    name: "gdrive-mcp-server",
    version: "0.9.0",
  },
  {
    capabilities: serverCapabilities,
  },
);

if (ENABLE_RESOURCES) {

server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
  const pageSize = 10;
  const params: Record<string, unknown> = {
    pageSize,
    fields: "nextPageToken, files(id, name, mimeType)",
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    corpora: "allDrives",
  };

  if (request.params?.cursor) {
    params.pageToken = request.params.cursor;
  }

  const res = await drive.files.list(params);
  const files = res.data.files ?? [];

  return {
    resources: files.map((file) => ({
      uri: `gdrive:///${file.id}`,
      mimeType: file.mimeType ?? undefined,
      name: file.name ?? "Untitled",
    })),
    nextCursor: res.data.nextPageToken ?? undefined,
  };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const uri = request.params.uri;
  if (!uri.startsWith("gdrive:///")) {
    throw new Error("Invalid resource URI: must start with gdrive:///");
  }
  const fileId = uri.replace("gdrive:///", "");
  if (!fileId || !/^[a-zA-Z0-9_-]+$/.test(fileId)) {
    throw new Error("Invalid file ID");
  }

  const file = await drive.files.get({
    fileId,
    fields: "mimeType, size",
    supportsAllDrives: true,
  });

  if (file.data.mimeType?.startsWith("application/vnd.google-apps")) {
    let exportMimeType: string;
    switch (file.data.mimeType) {
      case "application/vnd.google-apps.document":
        exportMimeType = "text/markdown";
        break;
      case "application/vnd.google-apps.spreadsheet":
        exportMimeType = "text/csv";
        break;
      case "application/vnd.google-apps.presentation":
        exportMimeType = "text/plain";
        break;
      case "application/vnd.google-apps.drawing":
        exportMimeType = "image/png";
        break;
      default:
        exportMimeType = "text/plain";
    }

    const res = await drive.files.export(
      { fileId, mimeType: exportMimeType },
      { responseType: "text" },
    );

    return {
      contents: [
        {
          uri: request.params.uri,
          mimeType: exportMimeType,
          text: String(res.data),
        },
      ],
    };
  }

  const fileSize = parseInt(file.data.size ?? "0", 10);
  if (fileSize > MAX_FILE_SIZE_BYTES) {
    throw new Error(
      `File too large (${Math.round(fileSize / 1024 / 1024)} MB). ` +
        `Maximum supported size is ${MAX_FILE_SIZE_BYTES / 1024 / 1024} MB.`,
    );
  }

  const res = await drive.files.get(
    { fileId, alt: "media", supportsAllDrives: true },
    { responseType: "arraybuffer" },
  );
  const mimeType = file.data.mimeType || "application/octet-stream";
  if (mimeType.startsWith("text/") || mimeType === "application/json") {
    return {
      contents: [
        {
          uri: request.params.uri,
          mimeType: mimeType,
          text: Buffer.from(res.data as ArrayBuffer).toString("utf-8"),
        },
      ],
    };
  }
  return {
    contents: [
      {
        uri: request.params.uri,
        mimeType: mimeType,
        blob: Buffer.from(res.data as ArrayBuffer).toString("base64"),
      },
    ],
  };
});

} // end if (ENABLE_RESOURCES)

function getExportMimeType(googleMimeType: string): string {
  switch (googleMimeType) {
    case "application/vnd.google-apps.document":
      return "text/markdown";
    case "application/vnd.google-apps.spreadsheet":
      return "text/csv";
    case "application/vnd.google-apps.presentation":
      return "text/plain";
    case "application/vnd.google-apps.drawing":
      return "image/png";
    default:
      return "text/plain";
  }
}

function getExportExtension(exportMimeType: string): string {
  switch (exportMimeType) {
    case "text/markdown":
      return ".md";
    case "text/csv":
      return ".csv";
    case "text/plain":
      return ".txt";
    case "image/png":
      return ".png";
    default:
      return ".txt";
  }
}

function sanitizeFilename(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0, 200);
}

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools: Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }> = [
    {
      name: "search",
      description: "Search for files in Google Drive",
      inputSchema: {
        type: "object" as const,
        properties: {
          query: {
            type: "string",
            description: "Search query",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "read",
      description:
        "Read a file's contents from Google Drive and return it inline. " +
        "Google Docs are exported as Markdown, Sheets as CSV, " +
        "Presentations as plain text. Binary files return a base64 snippet. " +
        "For large files, use the download tool instead.",
      inputSchema: {
        type: "object" as const,
        properties: {
          fileId: {
            type: "string",
            description: "The Google Drive file ID (from search results)",
          },
        },
        required: ["fileId"],
      },
    },
    {
      name: "download",
      description:
        "Download a file from Google Drive to a local directory. " +
        "Google Docs are exported as Markdown, Sheets as CSV, " +
        "Presentations as plain text. Use the file ID from search results.",
      inputSchema: {
        type: "object" as const,
        properties: {
          fileId: {
            type: "string",
            description: "The Google Drive file ID (from search results)",
          },
        },
        required: ["fileId"],
      },
    },
  ];

  if (ENABLE_SHEETS) {
    tools.push({
      name: "sheets_read",
      description:
        "Read a Google Sheets spreadsheet with optional range (A1 notation). " +
        "Returns cell values as a formatted table. More structured than reading " +
        "a sheet as CSV via the read tool.",
      inputSchema: {
        type: "object" as const,
        properties: {
          spreadsheetId: {
            type: "string",
            description: "The Google Sheets spreadsheet ID",
          },
          range: {
            type: "string",
            description:
              "Optional A1 range (e.g. 'Sheet1!A1:C10', 'A1:Z', 'Sheet1'). " +
              "Omit to read the first sheet.",
          },
        },
        required: ["spreadsheetId"],
      },
    });
  }

  return { tools };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "search") {
    const userQuery = request.params.arguments?.query as string;
    if (!userQuery || typeof userQuery !== "string") {
      throw new Error("Search query must be a non-empty string");
    }
    if (userQuery.length > MAX_QUERY_LENGTH) {
      throw new Error(`Search query too long (max ${MAX_QUERY_LENGTH} characters)`);
    }
    const escapedQuery = userQuery.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const formattedQuery = `fullText contains '${escapedQuery}'`;

    const res = await drive.files.list({
      q: formattedQuery,
      pageSize: 10,
      fields: "files(id, name, mimeType, modifiedTime, size)",
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      corpora: "allDrives",
    });

    const files = res.data.files ?? [];
    const fileList = files
      .map((file) => `${file.name} (${file.mimeType}) [id: ${file.id}]`)
      .join("\n");
    return {
      content: [
        {
          type: "text" as const,
          text: `Found ${files.length} files:\n${fileList}`,
        },
      ],
      isError: false,
    };
  }
  if (request.params.name === "read") {
    const fileId = request.params.arguments?.fileId as string;
    if (!fileId || typeof fileId !== "string") {
      throw new Error("fileId must be a non-empty string");
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(fileId)) {
      throw new Error("Invalid file ID");
    }

    const file = await drive.files.get({
      fileId,
      fields: "name, mimeType, size",
      supportsAllDrives: true,
    });

    const fileName = file.data.name ?? "untitled";
    const mimeType = file.data.mimeType ?? "application/octet-stream";

    if (mimeType.startsWith("application/vnd.google-apps")) {
      const exportMimeType = getExportMimeType(mimeType);
      const res = await drive.files.export(
        { fileId, mimeType: exportMimeType },
        { responseType: "text" },
      );
      return {
        content: [
          {
            type: "text" as const,
            text: `# ${fileName}\n\n${String(res.data)}`,
          },
        ],
        isError: false,
      };
    }

    const fileSize = parseInt(file.data.size ?? "0", 10);
    if (fileSize > MAX_FILE_SIZE_BYTES) {
      throw new Error(
        `File too large (${Math.round(fileSize / 1024 / 1024)} MB). ` +
          `Use the download tool instead.`,
      );
    }

    if (mimeType.startsWith("text/") || mimeType === "application/json") {
      const res = await drive.files.get(
        { fileId, alt: "media", supportsAllDrives: true },
        { responseType: "text" },
      );
      return {
        content: [
          {
            type: "text" as const,
            text: `# ${fileName}\n\n${String(res.data)}`,
          },
        ],
        isError: false,
      };
    }

    return {
      content: [
        {
          type: "text" as const,
          text: `"${fileName}" is a binary file (${mimeType}, ${fileSize} bytes). Use the download tool to save it locally.`,
        },
      ],
      isError: false,
    };
  }
  if (request.params.name === "sheets_read") {
    if (!sheets) {
      throw new Error(
        "Sheets support is disabled. Set GDRIVE_ENABLE_SHEETS=true and re-auth with the spreadsheets.readonly scope.",
      );
    }
    const spreadsheetId = request.params.arguments?.spreadsheetId as string;
    if (!spreadsheetId || typeof spreadsheetId !== "string") {
      throw new Error("spreadsheetId must be a non-empty string");
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(spreadsheetId)) {
      throw new Error("Invalid spreadsheet ID");
    }

    const range = request.params.arguments?.range as string | undefined;
    if (range && range.length > 200) {
      throw new Error("Range too long");
    }

    const meta = await sheets.spreadsheets.get({
      spreadsheetId,
      fields: "properties.title, sheets.properties.title",
    });

    const effectiveRange =
      range || meta.data.sheets?.[0]?.properties?.title || "Sheet1";

    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: effectiveRange,
      valueRenderOption: "FORMATTED_VALUE",
    });

    const rows = res.data.values ?? [];
    if (rows.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Spreadsheet "${meta.data.properties?.title}" range "${effectiveRange}" is empty.`,
          },
        ],
        isError: false,
      };
    }

    const header = rows[0];
    const separator = header.map(() => "---");
    const table = [
      `| ${header.join(" | ")} |`,
      `| ${separator.join(" | ")} |`,
      ...rows.slice(1).map(
        (row) =>
          `| ${header.map((_, i) => String(row[i] ?? "")).join(" | ")} |`,
      ),
    ].join("\n");

    return {
      content: [
        {
          type: "text" as const,
          text: `# ${meta.data.properties?.title}\nRange: ${effectiveRange} (${rows.length} rows)\n\n${table}`,
        },
      ],
      isError: false,
    };
  }
  if (request.params.name === "download") {
    const fileId = request.params.arguments?.fileId as string;
    if (!fileId || typeof fileId !== "string") {
      throw new Error("fileId must be a non-empty string");
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(fileId)) {
      throw new Error("Invalid file ID");
    }

    const file = await drive.files.get({
      fileId,
      fields: "name, mimeType, size",
      supportsAllDrives: true,
    });

    const fileName = file.data.name ?? "untitled";
    const mimeType = file.data.mimeType ?? "application/octet-stream";

    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

    if (mimeType.startsWith("application/vnd.google-apps")) {
      const exportMimeType = getExportMimeType(mimeType);
      const ext = getExportExtension(exportMimeType);
      const safeName = sanitizeFilename(fileName) + ext;
      const destPath = path.join(DOWNLOAD_DIR, safeName);

      const res = await drive.files.export(
        { fileId, mimeType: exportMimeType },
        { responseType: "text" },
      );

      fs.writeFileSync(destPath, String(res.data), "utf-8");

      return {
        content: [
          {
            type: "text" as const,
            text: `Downloaded "${fileName}" as ${exportMimeType} to ${destPath}`,
          },
        ],
        isError: false,
      };
    }

    const fileSize = parseInt(file.data.size ?? "0", 10);
    if (fileSize > MAX_FILE_SIZE_BYTES) {
      throw new Error(
        `File too large (${Math.round(fileSize / 1024 / 1024)} MB). ` +
          `Maximum supported size is ${MAX_FILE_SIZE_BYTES / 1024 / 1024} MB.`,
      );
    }

    const res = await drive.files.get(
      { fileId, alt: "media", supportsAllDrives: true },
      { responseType: "arraybuffer" },
    );

    const safeName = sanitizeFilename(fileName);
    const destPath = path.join(DOWNLOAD_DIR, safeName);
    fs.writeFileSync(destPath, Buffer.from(res.data as ArrayBuffer));

    return {
      content: [
        {
          type: "text" as const,
          text: `Downloaded "${fileName}" (${mimeType}, ${fileSize} bytes) to ${destPath}`,
        },
      ],
      isError: false,
    };
  }

  throw new Error(`Unknown tool: ${request.params.name}`);
});

function loadOAuthKeys(): { client_id: string; client_secret: string } {
  if (!fs.existsSync(oauthKeysPath)) {
    console.error(
      "OAuth keys file not found. " +
        "Set GDRIVE_OAUTH_PATH or place gcp-oauth.keys.json in the expected location.",
    );
    process.exit(1);
  }
  const raw = JSON.parse(fs.readFileSync(oauthKeysPath, "utf-8"));
  const keys = raw.installed || raw.web;
  if (!keys?.client_id || !keys?.client_secret) {
    console.error("OAuth keys file is missing client_id or client_secret.");
    process.exit(1);
  }
  return { client_id: keys.client_id, client_secret: keys.client_secret };
}

async function authenticateAndSaveCredentials() {
  console.log("Launching auth flow...");
  const scopes = ["https://www.googleapis.com/auth/drive.readonly"];
  if (ENABLE_SHEETS) {
    scopes.push("https://www.googleapis.com/auth/spreadsheets.readonly");
  }
  const auth = await authenticate({
    keyfilePath: oauthKeysPath,
    scopes,
  });
  writeCredentials(credentialsPath, auth.credentials);
  console.log("Credentials saved. You can now run the server.");
}

async function loadCredentialsAndRunServer() {
  if (!fs.existsSync(credentialsPath)) {
    console.error(
      "Credentials not found. Please run with 'auth' argument first.",
    );
    process.exit(1);
  }

  const credentials = JSON.parse(fs.readFileSync(credentialsPath, "utf-8"));
  const { client_id, client_secret } = loadOAuthKeys();

  const auth = new OAuth2Client(client_id, client_secret);
  auth.setCredentials(credentials);

  // Persist refreshed tokens back to disk so restarts also get fresh tokens.
  auth.on("tokens", (tokens) => {
    try {
      const existing = JSON.parse(fs.readFileSync(credentialsPath, "utf-8"));
      const updated = {
        ...existing,
        access_token: tokens.access_token ?? existing.access_token,
        expiry_date: tokens.expiry_date ?? existing.expiry_date,
      };
      if (tokens.refresh_token) {
        updated.refresh_token = tokens.refresh_token;
      }
      writeCredentials(credentialsPath, updated);
      console.error("Tokens refreshed and saved to disk.");
    } catch (err) {
      console.error("Failed to persist refreshed tokens:", err);
    }
  });

  drive = new drive_v3.Drive({ auth });
  if (ENABLE_SHEETS) {
    sheets = new sheets_v4.Sheets({ auth });
  }

  console.error("Credentials loaded. Starting server.");
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (process.argv[2] === "auth") {
  authenticateAndSaveCredentials().catch(console.error);
} else {
  loadCredentialsAndRunServer().catch(console.error);
}
