import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

const MCP_CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
  "access-control-allow-headers":
    "content-type,accept,mcp-protocol-version,mcp-session-id,last-event-id",
  "access-control-expose-headers":
    "mcp-session-id,mcp-protocol-version"
};

const DEFAULT_UI_POLICY = {
  chainConfirmation: "AUTO",
  hideChainOverlayDuringDecision: true,
  showChainResolutionOverlay: true,
  targetSelectionStyle: "BOARD_HIGHLIGHT",
  costSelectionStyle: "BOARD_HIGHLIGHT",
  zoneSelectionStyle: "BOARD_HIGHLIGHT"
};

async function ensureConfigTable(db) {
  if (!db) throw new Error("D1 database binding DB が設定されていません。");

  await db.prepare(`
    CREATE TABLE IF NOT EXISTS app_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `).run();
}

async function readConfig(db, key, fallback) {
  await ensureConfigTable(db);

  const row = await db
    .prepare("SELECT value FROM app_config WHERE key = ?1")
    .bind(key)
    .first();

  if (!row) return structuredClone(fallback);

  try {
    return JSON.parse(row.value);
  } catch {
    return structuredClone(fallback);
  }
}

async function writeConfig(db, key, value) {
  await ensureConfigTable(db);

  await db.prepare(`
    INSERT INTO app_config (key, value, updated_at)
    VALUES (?1, ?2, ?3)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at
  `)
    .bind(key, JSON.stringify(value), new Date().toISOString())
    .run();

  return value;
}

function mcpResult(payload) {
  return {
    structuredContent: payload,
    content: [
      {
        type: "text",
        text: JSON.stringify(payload)
      }
    ]
  };
}

function createMcpServer(env) {
  const server = new McpServer(
    {
      name: "ocg-engine-lab-control",
      version: "0.1.0"
    },
    {
      instructions:
        "OCG Engine Lab の設定を管理するMCP。現在はUI Policyを読み書きする。"
    }
  );

  server.registerTool(
    "get_ui_policy",
    {
      title: "UI Policyを取得",
      description:
        "OCG Engine Labのチェーン確認や効果処理UIに関する現在の設定を取得する。",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false
      }
    },
    async () => {
      const policy = await readConfig(
        env.DB,
        "ui-policy",
        DEFAULT_UI_POLICY
      );

      return mcpResult({ policy });
    }
  );

  server.registerTool(
    "update_ui_policy",
    {
      title: "UI Policyを更新",
      description:
        "OCG Engine Labのチェーン確認・効果処理UI設定を更新する。",
      inputSchema: {
        chainConfirmation: z
          .enum(["ON", "AUTO", "OFF"])
          .optional(),

        hideChainOverlayDuringDecision: z
          .boolean()
          .optional(),

        showChainResolutionOverlay: z
          .boolean()
          .optional(),

        targetSelectionStyle: z
          .enum(["BOARD_HIGHLIGHT", "MODAL"])
          .optional(),

        costSelectionStyle: z
          .enum(["BOARD_HIGHLIGHT", "MODAL"])
          .optional(),

        zoneSelectionStyle: z
          .enum(["BOARD_HIGHLIGHT", "MODAL"])
          .optional()
      },
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: true
      }
    },
    async (changes) => {
      const current = await readConfig(
        env.DB,
        "ui-policy",
        DEFAULT_UI_POLICY
      );

      const policy = {
        ...current,
        ...changes
      };

      await writeConfig(env.DB, "ui-policy", policy);

      return mcpResult({
        updated: true,
        policy
      });
    }
  );

  return server;
}

async function handleMcp(request, env) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: MCP_CORS_HEADERS
    });
  }

  const transport =
    new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    });

  const server = createMcpServer(env);

  await server.connect(transport);

  const response = await transport.handleRequest(request);

  const headers = new Headers(response.headers);

  for (const [key, value] of Object.entries(MCP_CORS_HEADERS)) {
    headers.set(key, value);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);

      if (
        url.pathname === "/mcp" ||
        url.pathname === "/api/mcp"
      ) {
        return handleMcp(request, env);
      }

      if (url.pathname === "/health") {
        return Response.json({
          ok: true,
          service: "ocg-engine-lab-control",
          version: "0.1.0",
          databaseBound: !!env.DB
        });
      }

      return new Response(
        "OCG Engine Lab Control MCP",
        {
          status: 200,
          headers: {
            "content-type":
              "text/plain; charset=utf-8"
          }
        }
      );
    } catch (error) {
      return Response.json(
        {
          ok: false,
          error: String(
            error?.message || error
          )
        },
        {
          status: 500
        }
      );
    }
  }
};
