// Settings from the container's environment, shared by the join page (server.js), Foundry calls (foundry.js),
// campaign access (access.js) and the MCP tools (tools.js).

import fs from "node:fs";
import path from "node:path";

export const PORT = Number(process.env.PORT || 8080);
// The MCP endpoint's own port; without MCP_TOKEN every MCP request is refused.
export const MCP_PORT = Number(process.env.MCP_PORT || 8081);
export const MCP_TOKEN = process.env.MCP_TOKEN || "";
export const FOUNDRY = (process.env.FOUNDRY_URL || "").replace(/\/$/, "");
export const SIGN_OUT = process.env.SIGN_OUT_URL || "/outpost.goauthentik.io/sign_out";
// The password every Foundry user shares.
export const PASSWORD = process.env.FOUNDRY_PASSWORD || "";
// The shared table screen's Foundry user ("" hides its button).
export const TABLE_USER = process.env.TABLE_USER ?? "Table";
// Writable: access.json (campaign members) and audit.log.
export const DATA_DIR = process.env.DATA_DIR || "/data";
// Read-only view of Foundry's Data/worlds, for the campaign list while a world runs (optional).
export const WORLDS_DIR = process.env.WORLDS_DIR || "/worlds";

/**
 * A list setting whose entries may be limited to one world: "entry" applies to every world, "world-id/entry" only
 * while that world runs (the world id is its folder name under Data/worlds).
 */
function scopedList(value, split) {
  return (value || "").split(split).map(s => s.trim()).filter(Boolean).map(s => {
    const i = s.indexOf("/");
    return i > 0 ? { world: s.slice(0, i).toLowerCase(), entry: s.slice(i + 1).trim() } : { world: null, entry: s };
  });
}
export const inWorld = (list, world) => list.filter(e => !e.world || (e.world === String(world || "").toLowerCase()));

// Authentik username → Foundry user name, "alice=Alice;bob=Bob;my-world/bob=Bob the Bard". A world entry
// beats a general one; a campaign member's "player" in access.json beats both.
export const USER_MAP = scopedList(process.env.USER_MAP, /[;,\n]/).map(({ world, entry }) => {
  const [a, f] = entry.split("=").map(s => s?.trim());
  return { world, username: a?.toLowerCase(), name: f };
}).filter(e => e.username && e.name);
// Authentik usernames that may join as a Gamemaster / Assistant GM user ("*" = everyone, "world-id/username" = in
// that world only), besides campaign members marked gm in access.json.
export const GM_USERS = scopedList(process.env.GM_USERS, /[;,\s]+/).map(e => ({ ...e, entry: e.entry.toLowerCase() }));
// Authentik usernames that may enter Foundry's admin setup; the service sends Foundry's admin login for them.
export const ADMIN_USERS = new Set((process.env.ADMIN_USERS ?? "").split(/[;,\s]+/).filter(Boolean).map(u => u.toLowerCase()));
export const ADMIN_USERNAME = process.env.FOUNDRY_ADMIN_USERNAME || "";
export const ADMIN_PASSWORD = process.env.FOUNDRY_ADMIN_PASSWORD || "";

export const isAdmin = ak => !!ak && !!ADMIN_PASSWORD && ADMIN_USERS.has(ak.username.toLowerCase());

// Proves a request came through SWAG, which is what makes the x-authentik-* headers trustworthy. Without one, every
// request is refused: other containers on the Docker bridge can reach this service directly.
function proxySecret() {
  if ( process.env.PROXY_SECRET ) return process.env.PROXY_SECRET.trim();
  try { return fs.readFileSync(path.join(DATA_DIR, "proxy-secret"), "utf8").trim(); }
  catch { return ""; }
}
export const PROXY_SECRET = proxySecret();

if ( !FOUNDRY ) throw new Error("Environment variable FOUNDRY_URL is required");

export const log = (...a) => console.log(new Date().toISOString(), ...a);
