// A minimal MCP server (Streamable HTTP, stateless, JSON responses): initialize, ping, tools/list, tools/call.
// No SDK, so the service keeps running on stock Node without npm install.
import http from "node:http";
import crypto from "node:crypto";
import { log } from "./config.js";

const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

/** Thrown by a tool for an expected failure: the message goes back as a tool error without a stack in the log. */
export class ToolError extends Error {}

function authorized(token, header) {
  if ( !token ) return false;
  const want = crypto.createHash("sha256").update(`Bearer ${token}`).digest();
  const got = crypto.createHash("sha256").update(String(header || "")).digest();
  return crypto.timingSafeEqual(want, got);
}

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body === undefined ? "" : JSON.stringify(body));
}

async function callTool(tools, params) {
  const tool = tools.find(t => t.name === params?.name);
  if ( !tool ) return { content: [{ type: "text", text: `Unknown tool ${params?.name}` }], isError: true };
  try {
    const result = await tool.run(params.arguments || {});
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
  } catch ( e ) {
    if ( !(e instanceof ToolError) ) log(`tool ${tool.name}:`, e.stack || e.message);
    return { content: [{ type: "text", text: e.message }], isError: true };
  }
}

async function answer(message, { info, tools }) {
  const { id, method, params } = message || {};
  const result = r => ({ jsonrpc: "2.0", id, result: r });
  switch ( method ) {
    case "initialize":
      return result({
        protocolVersion: PROTOCOLS.includes(params?.protocolVersion) ? params.protocolVersion : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: info
      });
    case "ping": return result({});
    case "tools/list": return result({ tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case "tools/call": return result(await callTool(tools, params));
    default:
      if ( id === undefined ) return null;                          // a notification: nothing to answer
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
  }
}

/** An HTTP server answering MCP on /mcp (and /), plus GET /health. Without a token every MCP request is refused. */
export function mcpServer({ token, info, tools }) {
  return http.createServer(async (req, res) => {
    const path = req.url.split("?")[0].replace(/\/+$/, "") || "/";
    if ( path === "/health" ) return send(res, 200, { ok: true });
    if ( (path !== "/mcp") && (path !== "/") ) return send(res, 404, { error: "not found" });
    if ( !authorized(token, req.headers.authorization) ) {
      return send(res, 401, { jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
    }
    if ( req.method !== "POST" ) {
      res.setHeader("allow", "POST");
      return send(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
    }
    let body = "";
    try {
      for await ( const chunk of req ) {
        body += chunk;
        if ( body.length > 1 << 20 ) return send(res, 413, { jsonrpc: "2.0", error: { code: -32600, message: "Request too large" }, id: null });
      }
    } catch { return; } // The client went away mid-request.
    let message;
    try { message = JSON.parse(body); }
    catch { return send(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }); }
    try {
      const replies = (await Promise.all((Array.isArray(message) ? message : [message]).map(m => answer(m, { info, tools })))).filter(Boolean);
      if ( !replies.length ) return send(res, 202);
      send(res, 200, Array.isArray(message) ? replies : replies[0]);
    } catch ( e ) {
      log("mcp error:", e.stack || e.message);
      if ( !res.headersSent ) send(res, 500, { jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  });
}
