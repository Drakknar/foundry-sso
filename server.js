// foundry-sso: every Foundry VTT login step, behind SWAG + Authentik.
// - Join page (/join): every Foundry user shares one password (FOUNDRY_PASSWORD), so anyone allowed into the running
//   world can join as any player: "Continue as <their player>", "Join as Table", or any other player from a list;
//   each in desktop or phone mode. The service logs in to Foundry server-side and hands the browser Foundry's cookie.
// - Campaigns (access.js): a world with a member list in access.json is members-only; GMs per campaign.
// - Admin (ADMIN_USERS only): Foundry's admin routes (/auth, /setup, /create, /update, /license,
//   /quit) come through here. For admins the service logs their Foundry session in as administrator server-side
//   (Foundry's /auth form) and adds the admin login to their setup POSTs, so the admin password is never typed;
//   everyone else is refused. The join page adds one-click "Launch <world>" and "Return to Setup".
// - MCP (tools.js, MCP_PORT): campaign access, Foundry users, status + audit log, launch/shutdown.
// - /join?classic=1 proxies Foundry's own page.
// The x-authentik-* headers are only trusted on requests carrying SWAG's shared secret (see README).
// No dependencies: Node 22 built-ins only. See README.md.
import http from "node:http";
import crypto from "node:crypto";
import { PORT, MCP_PORT, MCP_TOKEN, PROXY_SECRET, FOUNDRY, SIGN_OUT, PASSWORD, TABLE_USER, isAdmin, log } from "./config.js";
import { newSession, bareSession, join, launchWorld, shutdownWorld, setupWorlds, adminLogin, adminCredentials, newer, GM_ROLE, ADMIN_REFUSED } from "./foundry.js";
import { canEnter, mayGM, playerName } from "./access.js";
import { audit } from "./audit.js";
import { mcpServer } from "./mcp.js";
import { tools } from "./tools.js";

const VERSION = "0.4.3";
// Foundry's own session lifetime (sessions.mjs: 864e5 ms).
const SESSION_MAX_AGE = 86400;
// Foundry routes that need the server administrator (views/*.mjs); they reach Foundry only through this service.
const ADMIN_ROUTES = new Set(["/auth", "/setup", "/create", "/update", "/license", "/quit"]);
// Set by /join?auto=table: this browser joins as the Table whenever a world is running (the table screen's kiosk).
const AUTO_COOKIE = "fsso_auto";

/* ----------------------------------------------- Login ----------------------------------------------- */

/** The Authentik user SWAG's forward auth let in (it sets these headers on every request), or null. */
const SECRET_HEADER = "x-foundry-sso-secret";
const digest = s => crypto.createHash("sha256").update(String(s)).digest();
const fromSwag = req => !!PROXY_SECRET && crypto.timingSafeEqual(digest(req.headers[SECRET_HEADER] ?? ""), digest(PROXY_SECRET));

function authentikUser(req) {
  const username = req.headers["x-authentik-username"];
  return username ? { username, name: req.headers["x-authentik-name"] || username } : null;
}

const findUser = (users, name) => users.find(u => u.name.toLowerCase() === String(name).toLowerCase());

/** The Foundry user an Authentik user plays: their campaign entry / USER_MAP, else their name, its first word, or their username. */
function playerOf(users, ak, world) {
  const mapped = playerName(ak, world);
  if ( mapped ) return findUser(users, mapped);
  return findUser(users, ak.name) || findUser(users, ak.name.split(/\s+/)[0]) || findUser(users, ak.username);
}

/**
 * The Foundry users an Authentik user may join as. Everyone shares one password, so Gamemaster and Assistant GM
 * users are offered only to the world's GMs; the shared password would otherwise make any player a GM.
 */
const joinable = (users, ak, world) => (users || []).filter(u => (u.role < GM_ROLE) || mayGM(ak, world));

/** Logs in and answers with Foundry's cookie + a redirect into the game, or re-renders the page with the error. */
async function doLogin(req, res, { userId, mode }) {
  const s = await newSession();
  if ( s.noWorld ) return redirect(res, "/join");
  const ak = authentikUser(req);
  const world = s.data.world.id;
  if ( !canEnter(ak, world) ) {
    audit("refused", { user: ak.username, world, reason: "not a member" });
    return redirect(res, "/join");
  }
  const user = joinable(s.data.users, ak, world).find(u => u._id === userId);
  if ( !user ) return renderPage(req, res, { error: "That player isn't available." });
  const r = await join(s.session, user._id, PASSWORD);
  if ( !r.ok ) {
    log(`join as ${user.name} failed (${who(req)}): ${r.error}`);
    audit("join_failed", { user: ak.username, world, as: user.name, error: r.error });
    return renderPage(req, res, { error: r.error });
  }
  log(`${who(req)} joined ${world} as ${user.name} (${mode})`);
  audit("join", { user: ak.username, world, as: user.name, mode });
  const target = new URL(r.redirect, "http://x");
  target.searchParams.set("phone", mode === "phone" ? "on" : "off");
  res.setHeader("set-cookie", sessionCookie(s.session));
  redirect(res, target.pathname + target.search);
}

const who = req => req.headers["x-authentik-username"] || req.headers["x-forwarded-for"] || req.socket.remoteAddress;

/**
 * The join page's admin buttons for ADMIN_USERS:
 * - "launch" (no world): launches a world, as Foundry's setup page does, then waits on /join?starting=<id>.
 * - "shutdown" (world running): Return to Setup, which shuts the world down for everyone, then opens /setup.
 */
async function doAdmin(req, res, { action, world }) {
  const user = authentikUser(req).username;
  try {
    if ( action === "launch" ) {
      await launchWorld(world);
      log(`${who(req)} launched ${world}`);
      audit("launch", { user, world });
      return redirect(res, `/join?starting=${encodeURIComponent(world)}`);
    }
    if ( action === "shutdown" ) {
      await shutdownWorld();
      log(`${who(req)} returned to setup (world shut down)`);
      audit("shutdown", { user });
      return redirect(res, "/setup");
    }
  } catch ( e ) {
    log(`admin ${action} failed (${who(req)}): ${e.message}`);
    return renderPage(req, res, { error: e.message });
  }
  send(res, 400, "Unknown admin action.");
}

async function adminCard(running) {
  if ( running ) return `
    <form class="card" method="post" action="/join/admin" onsubmit="return confirm('Return to Setup shuts the world down for everyone. Continue?')">
      <h2>Admin</h2>
      <p class="note">The world is running: going to setup shuts it down for every player.</p>
      <div class="row"><button class="btn ghost" name="action" value="shutdown">Return to Setup</button></div>
    </form>`;
  let worlds, version, error;
  try { ({ worlds, version } = await setupWorlds()); }
  catch ( e ) { log("setup data:", e.message); error = e.message; }
  // One click for a world Foundry can launch as it is; one that needs a migration or is locked goes through setup,
  // where Foundry asks about the backup first.
  const rows = (worlds || []).sort((a, b) => String(b.lastPlayed || "").localeCompare(String(a.lastPlayed || "")) || a.title.localeCompare(b.title))
    .map(w => {
      const why = w.locked ? "locked" : (newer(version, w.coreVersion) ? "needs migrating in setup" : "");
      return `<li><span>${esc(w.title)}${why ? `<small>${esc(why)}</small>` : ""}</span>${why ? ""
        : `<button class="btn small" name="world" value="${esc(w.id)}">Launch</button>`}</li>`;
    }).join("");
  return `
    <form class="card" method="post" action="/join/admin">
      <h2>Admin</h2>
      <input type="hidden" name="action" value="launch">
      ${error ? `<p class="note">${esc(error)}</p>` : ""}
      ${rows ? `<ul class="worlds">${rows}</ul>` : ""}
      <div class="row"><a class="btn ghost" href="/setup">Game setup</a></div>
    </form>`;
}

/* ------------------------------------------------ Page ------------------------------------------------ */

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const looksLikePhone = req => /Android|iPhone|iPad|iPod|Mobile/i.test(req.headers["user-agent"] || "");
const cookieOf = (req, name) => (req.headers.cookie || "").split(/;\s*/).find(c => c.startsWith(`${name}=`))?.slice(name.length + 1);

async function renderPage(req, res, { error } = {}) {
  const ak = authentikUser(req);
  if ( !ak ) return send(res, 200, page("Foundry VTT", `
    <p class="error">This page needs an Authentik sign-in.</p>
    <footer><a href="/join?classic=1">Foundry's own login page</a></footer>`));
  const url = new URL(req.url, "http://x");
  const autoTable = cookieOf(req, AUTO_COOKIE) === "table";
  const autoNote = autoTable ? ` · <a href="/join?auto=off">Stop joining as ${esc(TABLE_USER)} automatically</a>` : "";
  const s = await newSession();
  if ( s.noWorld ) {
    const starting = url.searchParams.get("starting");
    // Waiting players (and the table screen) get in by themselves once a world runs.
    return send(res, 200, page("Foundry VTT", `
    ${error ? `<p class="error">${esc(error)}</p>` : ""}
    <section class="card"><h2>${starting ? "Starting the world…" : "No game is running"}</h2>
    <p>${starting ? "Foundry is loading it. This page carries on by itself." : "The Gamemaster hasn't started a world yet. This page checks again by itself."}</p>
    <div class="row"><a class="btn" href="/join">Try again</a></div></section>
    ${isAdmin(ak) && !starting ? await adminCard(false) : ""}
    <footer><a href="${esc(SIGN_OUT)}">Sign out</a>${autoNote}</footer>`, { refresh: starting ? 3 : 20, refreshTo: "/join" }));
  }
  const { data } = s;
  const world = data.world;
  const bg = world.background ? (/^[a-z]+:/i.test(world.background) ? world.background : `/${world.background.replace(/^\//, "")}`) : "";
  // Not in this campaign: the page says so and checks again, in case the world changes or access is granted.
  if ( !canEnter(ak, world.id) ) return send(res, 200, page(world.title || "Foundry VTT", `
    <p class="who">Signed in as <b>${esc(ak.name)}</b></p>
    <section class="card"><h2>You're not in this campaign</h2>
    <p>The world running now is for its players only. Ask the Gamemaster or the server admin to add you.</p>
    <div class="row"><a class="btn" href="/join">Try again</a></div></section>
    <footer><a href="${esc(SIGN_OUT)}">Sign out</a>${autoNote}</footer>`, { bg, refresh: 60, refreshTo: "/join" }));
  const users = joinable(data.users, ak, world.id).sort((a, b) => a.name.localeCompare(b.name));
  const active = new Set(data.activeUsers || []);
  const me = playerOf(users, ak, world.id);
  const table = TABLE_USER ? findUser(users, TABLE_USER) : null;
  const phone = looksLikePhone(req);
  const busy = u => active.has(u._id) ? `<p class="note">${esc(u.name)} is already connected somewhere else.</p>` : "";
  const modeButtons = `
      <button class="btn${phone ? " ghost" : ""}" name="mode" value="desktop">Join</button>
      <button class="btn${phone ? "" : " ghost"}" name="mode" value="phone">Join on phone</button>`;
  // The table screen joins by itself, unless the last try failed (no loop) or the Table is connected elsewhere.
  const autoJoin = autoTable && table && !error && !active.has(table._id);

  let main = `<p class="who">Signed in as <b>${esc(ak.name)}</b></p>`;
  if ( me && (me !== table) ) main += `
    <form class="card" method="post" action="/join/as">
      <input type="hidden" name="userId" value="${esc(me._id)}">
      <h2>Continue as ${esc(me.name)}</h2>${busy(me)}
      <div class="row">${modeButtons}</div>
    </form>`;
  if ( table ) main += `
    <form class="card" method="post" action="/join/as"${autoJoin ? ` id="auto"` : ""}>
      <input type="hidden" name="userId" value="${esc(table._id)}">
      <input type="hidden" name="mode" value="desktop">
      <h2>Table screen</h2>${busy(table)}
      <div class="row"><button class="btn${me ? " ghost" : ""}">Join as ${esc(table.name)}</button></div>
    </form>`;

  const options = users.filter(u => u !== table)
    .map(u => `<option value="${esc(u._id)}"${me?._id === u._id ? " selected" : ""}>${esc(u.name)}${active.has(u._id) ? " (connected)" : ""}</option>`).join("");
  const other = !options ? "" : `
    <form class="card" method="post" action="/join/as">
      <label>Player<select name="userId" required>${options}</select></label>
      <div class="row">${modeButtons}</div>
    </form>`;

  send(res, 200, page(world.title || "Foundry VTT", `
    ${error ? `<p class="error">${esc(error)}</p>` : ""}
    ${main}
    ${me && other ? `<details><summary>Join as another player</summary>${other}</details>` : other}
    ${isAdmin(ak) ? await adminCard(true) : ""}
    <footer><a href="/join?classic=1">Foundry's own login page</a> · <a href="${esc(SIGN_OUT)}">Sign out</a>${autoNote}</footer>
    ${autoJoin ? `<script>document.getElementById("auto").requestSubmit()</script>` : ""}`, { bg }));
}

function page(title, body, { bg = "", refresh = 0, refreshTo = "" } = {}) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
${refresh ? `<meta http-equiv="refresh" content="${refresh}${refreshTo ? `;url=${esc(refreshTo)}` : ""}">` : ""}
<meta name="color-scheme" content="dark"><title>${esc(title)}</title>
<style>
:root{--bg:#16131a;--card:#221d27ee;--ink:#ece6f2;--muted:#a79fb0;--acc:#ff6400;--line:#3a3242;--err:#ff8a7a}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;min-height:100dvh;background:var(--bg) ${bg ? `url("${esc(bg)}") center/cover fixed` : ""};color:var(--ink);
  font:16px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;display:flex;justify-content:center;
  padding:max(24px,env(safe-area-inset-top)) 16px max(24px,env(safe-area-inset-bottom))}
main{width:100%;max-width:440px;display:flex;flex-direction:column;gap:16px}
h1{font-size:1.6rem;margin:8px 0;text-align:center;text-shadow:0 2px 8px #000}
h2{font-size:1.2rem;margin:0 0 12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px;backdrop-filter:blur(6px)}
.who{margin:0;text-align:center;color:var(--ink);font-size:.9rem;text-shadow:0 1px 4px #000}
.row{display:flex;gap:10px;flex-wrap:wrap}
.btn{flex:1 1 140px;min-height:52px;border:0;border-radius:10px;background:var(--acc);color:#fff;font:600 1.05rem/1 inherit;
  cursor:pointer;display:inline-flex;align-items:center;justify-content:center;text-decoration:none;padding:0 14px}
.btn.ghost{background:transparent;border:2px solid var(--acc);color:var(--ink)}
.btn.small{flex:0 0 auto;min-height:44px;font-size:.95rem}
.worlds{list-style:none;margin:0 0 12px;padding:0;display:flex;flex-direction:column;gap:8px}
.worlds li{display:flex;align-items:center;justify-content:space-between;gap:10px;min-height:44px}
.worlds small{display:block;color:var(--muted);font-size:.8rem}
label{display:block;margin:0 0 12px;color:var(--muted);font-size:.9rem}
select{display:block;width:100%;margin-top:4px;min-height:48px;border-radius:10px;border:1px solid var(--line);
  background:#0f0c12;color:var(--ink);font:inherit;padding:0 12px}
details summary{cursor:pointer;color:var(--ink);padding:8px 18px;min-height:44px;display:flex;align-items:center;gap:8px;
  background:var(--card);border:1px solid var(--line);border-radius:14px;backdrop-filter:blur(6px)}
details summary::before{content:"▸"}
details[open] summary::before{content:"▾"}
details .card{margin-top:4px}
.error{background:#3a1714;border:1px solid var(--err);color:var(--err);border-radius:10px;padding:12px;margin:0}
.note{color:var(--muted);margin:-4px 0 12px;font-size:.9rem}
footer{text-align:center;font-size:.85rem;color:var(--ink);background:var(--card);border:1px solid var(--line);border-radius:10px;
  padding:10px 14px;backdrop-filter:blur(6px)}
footer a{color:var(--ink)}
</style></head><body><main><h1>${esc(title)}</h1>${body}</main></body></html>`;
}

/* ----------------------------------------------- HTTP ----------------------------------------------- */

function send(res, status, html) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY" });
  res.end(html);
}

function redirect(res, location, headers = {}) {
  res.writeHead(303, { location, "cache-control": "no-store", ...headers });
  res.end();
}

function readBody(req, limit = 16384) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", c => {
      size += c.length;
      if ( size > limit ) { reject(new Error("Body too large")); req.destroy(); }
      else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** Our own forms only: refuse cross-site POSTs (login CSRF). */
function sameOrigin(req) {
  const site = req.headers["sec-fetch-site"];
  if ( site ) return site === "same-origin";
  const origin = req.headers.origin;
  return !!origin && URL.parse(origin)?.host === req.headers.host;
}

/**
 * Foundry's own join page (/join?classic=1) lists every user, and they all share one password, so its POSTs are
 * checked like ours: refused for anyone outside the running campaign, and a "join" or "loginAs" for a GM / Assistant
 * GM user is refused for anyone who isn't GM there. Returns the refusal reason or null. Foundry's JoinGameForm posts
 * JSON; a form-encoded body is read too.
 */
async function classicRefusal(req, body) {
  const ak = authentikUser(req);
  const s = await newSession();
  if ( s.noWorld ) return null;
  if ( !canEnter(ak, s.data.world.id) ) return "not a member";
  const text = body.toString("utf8");
  let data;
  try { data = JSON.parse(text); }
  catch { data = Object.fromEntries(new URLSearchParams(text)); }
  if ( !["join", "loginAs"].includes(data?.action) || mayGM(ak, s.data.world.id) ) return null;
  const user = (s.data.users || []).find(u => u._id === data.userId);
  return (user && (user.role >= GM_ROLE)) ? "GM login from Foundry's own join page" : null;
}

/**
 * Passes a request through to Foundry: Foundry's own join page and its POSTs, and the admin routes. `session` swaps
 * in another Foundry session and hands it to the browser too. Without a buffered body the request is streamed.
 */
function proxy(req, res, { body, session } = {}) {
  // Only the path and query of the request: a "//host/..." URL must never pick another server as the target.
  const { pathname, search } = new URL(req.url, "http://x");
  const target = new URL(FOUNDRY);
  target.pathname = pathname;
  target.search = search;
  const headers = { ...req.headers, host: target.host };
  delete headers[SECRET_HEADER];
  if ( body !== undefined ) {
    headers["content-length"] = Buffer.byteLength(body);
    delete headers["transfer-encoding"];
  }
  if ( session ) {
    const others = (req.headers.cookie || "").split(/;\s*/).filter(c => c && !c.startsWith("session="));
    headers.cookie = [...others, `session=${session}`].join("; ");
  }
  const up = http.request(target, { method: req.method, headers }, r => {
    const out = { ...r.headers };
    if ( session && !out["set-cookie"]?.some(c => c.startsWith("session=")) ) {
      out["set-cookie"] = [...(out["set-cookie"] || []), sessionCookie(session)];
    }
    res.writeHead(r.statusCode, out);
    r.pipe(res);
  });
  up.on("error", e => { log("proxy error:", e.message); if ( !res.headersSent ) send(res, 502, "Foundry is not reachable."); });
  if ( body === undefined ) req.pipe(up);
  else up.end(body);
}

const sessionCookie = session => `session=${session}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_MAX_AGE}`;

/**
 * An administrator Foundry session for an admin's browser: their own session made admin, or a fresh one. Null while
 * a world runs (Foundry only logs administrators in at setup).
 */
async function adminBrowserSession(req) {
  const own = cookieOf(req, "session");
  if ( own && await adminLogin(own) ) return own;
  const fresh = await bareSession();
  return (fresh && await adminLogin(fresh)) ? fresh : null;
}

/**
 * An admin's POST to /setup or /auth with the admin login filled in: Foundry checks it on every setup action, Return
 * to Setup included, and its dialogs would otherwise ask for the password. JSON and form bodies; others unchanged.
 */
function withAdminCredentials(req, body) {
  const type = req.headers["content-type"] || "";
  if ( type.includes("application/json") ) {
    let data;
    try { data = JSON.parse(body.toString("utf8") || "{}"); } catch { return body; }
    return Buffer.from(JSON.stringify({ ...data, ...adminCredentials() }));
  }
  if ( type.includes("application/x-www-form-urlencoded") ) {
    const form = new URLSearchParams(body.toString("utf8"));
    for ( const [k, v] of Object.entries(adminCredentials()) ) form.set(k, v);
    return Buffer.from(form.toString());
  }
  return body;
}

/** Is this POST to /setup Foundry's in-game Edit World (WorldConfig posts JSON)? */
function isEditWorld(req, body) {
  if ( !(req.headers["content-type"] || "").includes("application/json") ) return false;
  try { return JSON.parse(body.toString("utf8"))?.action === "editWorld"; }
  catch { return false; }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    if ( path === "/join/healthz" ) return void res.end("ok");
    if ( !fromSwag(req) ) {
      log(`refused ${req.method} ${path} from ${req.socket.remoteAddress}: no valid SWAG secret${PROXY_SECRET ? "" : " (proxy-secret is not set)"}`);
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      return void res.end("This service is only reachable through the reverse proxy.");
    }
    if ( ADMIN_ROUTES.has(path) ) {
      const ak = authentikUser(req);
      // When a world shuts down, Foundry sends every client to / → /setup: players and the table screen go back to
      // the join page (which waits for the next world), admins get setup.
      const tableScreen = cookieOf(req, AUTO_COOKIE) === "table";
      if ( isAdmin(ak) && !(tableScreen && req.method === "GET") ) {
        const login = (path === "/setup") || (path === "/auth");
        if ( login && (req.method === "GET") ) {
          if ( path === "/setup" ) audit("setup", { user: ak.username });
          const session = await adminBrowserSession(req);
          if ( session && (path === "/auth") ) return redirect(res, "/setup", { "set-cookie": sessionCookie(session) });
          return proxy(req, res, { session });
        }
        if ( login && (req.method === "POST") ) return proxy(req, res, { body: withAdminCredentials(req, await readBody(req, 1048576)) });
        return proxy(req, res);
      }
      if ( req.method === "GET" ) return redirect(res, "/join");
      // In-game Edit World posts to /setup: Foundry itself checks that the session's user is a GM.
      if ( ak && (path === "/setup") && (req.method === "POST") ) {
        const body = await readBody(req, 1048576);
        if ( isEditWorld(req, body) ) return proxy(req, res, { body });
      }
      log(`${who(req)} refused: ${req.method} ${path}`);
      audit("refused", { user: ak?.username || null, path, reason: "admin only" });
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      return void res.end("Foundry's setup is only available to the server admin.");
    }
    if ( path === "/join" && req.method === "GET" ) {
      const auto = url.searchParams.get("auto");
      if ( auto === "table" ) return redirect(res, "/join", { "set-cookie": `${AUTO_COOKIE}=table; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000` });
      if ( auto === "off" ) return redirect(res, "/join", { "set-cookie": `${AUTO_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0` });
      if ( url.searchParams.has("classic") ) {
        // Foundry's own page only for people allowed into the running world.
        const s = await newSession();
        if ( !s.noWorld && !canEnter(authentikUser(req), s.data.world.id) ) return redirect(res, "/join");
        return proxy(req, res);
      }
      return await renderPage(req, res);
    }
    if ( path === "/join" && req.method === "POST" ) {
      const body = await readBody(req, 1 << 20);
      const refusal = await classicRefusal(req, body);
      if ( refusal ) {
        log(`${who(req)} refused: ${refusal}`);
        audit("refused", { user: authentikUser(req)?.username || null, path, reason: refusal });
        res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
        return void res.end(refusal === "not a member" ? "This account isn't in the running campaign." : "Joining as a Gamemaster isn't available to this account.");
      }
      return proxy(req, res, { body });
    }
    if ( path === "/join/as" && req.method === "POST" ) {
      if ( !sameOrigin(req) ) return send(res, 400, "Cross-site request refused.");
      if ( !authentikUser(req) ) return send(res, 403, "Joining needs an Authentik sign-in.");
      const form = new URLSearchParams((await readBody(req)).toString("utf8"));
      return await doLogin(req, res, { userId: form.get("userId") || "", mode: form.get("mode") === "phone" ? "phone" : "desktop" });
    }
    if ( path === "/join/admin" && req.method === "POST" ) {
      if ( !sameOrigin(req) ) return send(res, 400, "Cross-site request refused.");
      if ( !isAdmin(authentikUser(req)) ) return send(res, 403, "Admin setup isn't available to this account.");
      const form = new URLSearchParams((await readBody(req)).toString("utf8"));
      return await doAdmin(req, res, { action: form.get("action") || "", world: form.get("world") || "" });
    }
    send(res, 404, "Not found");
  } catch ( e ) {
    log("error:", e.stack || e.message);
    // A world that is still loading also lands here (Foundry holds /join until it is ready), so the page retries.
    if ( !res.headersSent ) send(res, 502, page("Foundry VTT", `<p class="error">Foundry is not answering right now. Trying again by itself…</p>
      <footer><a href="/join">Try again</a> · <a href="/join?classic=1">Foundry's own login page</a></footer>`, { refresh: 10, refreshTo: "/join" }));
  }
});

server.listen(PORT, () => log(`foundry-sso ${VERSION} on :${PORT} → ${FOUNDRY}`));

// The MCP endpoint (published on the LAN for LiteLLM); without MCP_TOKEN it refuses everything.
const mcp = mcpServer({ token: MCP_TOKEN, info: { name: "foundry-sso", version: VERSION }, tools });
mcp.listen(MCP_PORT, () => log(`MCP on :${MCP_PORT}/mcp${MCP_TOKEN ? "" : " (MCP_TOKEN not set: every request is refused)"}`));

for ( const sig of ["SIGTERM", "SIGINT"] ) process.on(sig, () => { mcp.close(); server.close(() => process.exit(0)); });
