// Talking to Foundry VTT 14 server-side: sessions, the join and setup forms, and its Socket.IO API over HTTP
// long-polling (no client library).
import { FOUNDRY, PASSWORD, ADMIN_USERNAME, ADMIN_PASSWORD } from "./config.js";

// Foundry roles (common/constants.mjs USER_ROLES).
export const ROLES = { none: 0, player: 1, trusted: 2, assistant: 3, gamemaster: 4 };
export const ROLE_NAMES = Object.fromEntries(Object.entries(ROLES).map(([k, v]) => [v, k]));
export const GM_ROLE = ROLES.assistant;

// Every call to Foundry gives up after 15 s, so a hung Foundry shows the error page instead of a page that never loads.
export const foundryFetch = (url, options = {}) => fetch(url, { signal: AbortSignal.timeout(15000), ...options });

/**
 * A fresh Foundry session plus the join data. Returns { session, data }, or { noWorld: true } when no world is
 * running (Foundry then answers /join with its "No Active Game" page or a redirect, and getJoinData with {}).
 */
export async function newSession() {
  const session = await bareSession();
  if ( !session ) return { noWorld: true };
  const data = await socketCall(session, "getJoinData");
  return data?.world ? { session, data } : { noWorld: true };
}

/** A fresh Foundry session id; Foundry creates one on any request (null if it redirected without one). */
export async function bareSession() {
  const res = await foundryFetch(`${FOUNDRY}/join`, { redirect: "manual", headers: { "sec-fetch-dest": "document" } });
  await res.arrayBuffer();
  const session = sessionFrom(res);
  if ( !session && !(res.status >= 300 && res.status < 400) ) throw new Error(`Foundry /join gave no session cookie (HTTP ${res.status})`);
  return session;
}

function sessionFrom(res) {
  for ( const c of res.headers.getSetCookie() ) {
    const m = /^session=([^;]+)/.exec(c);
    if ( m ) return m[1];
  }
  return null;
}

/** Foundry's /api/status: { active, version, world?, system?, users? }. */
export async function apiStatus() {
  return (await foundryFetch(`${FOUNDRY}/api/status`)).json();
}

/* ----------------------------------------------- Admin ----------------------------------------------- */

/**
 * Foundry's admin login as its /auth form and Return to Setup dialog post it (sessions.mjs authenticateAdmin).
 * externalAdminAuth (login by proxy headers) is not an option here: Foundry 14 turns it off unless it serves TLS
 * itself or listens on a Unix socket, and ours is plain HTTP behind SWAG.
 */
export const adminCredentials = () => ({ adminUsername: ADMIN_USERNAME, adminPassword: ADMIN_PASSWORD });

export const ADMIN_REFUSED = "Foundry refused the admin login. Check FOUNDRY_ADMIN_USERNAME / FOUNDRY_ADMIN_PASSWORD.";

/**
 * Makes a Foundry session administrator: POST /auth, as Foundry's admin form does. True when Foundry accepted it
 * (redirect to /setup); false on a wrong login (401) or while a world runs (redirect to /join).
 */
export async function adminLogin(session) {
  const res = await foundryFetch(`${FOUNDRY}/auth`, {
    method: "POST", redirect: "manual",
    headers: { cookie: `session=${session}`, "content-type": "application/json", "sec-fetch-site": "same-origin" },
    body: JSON.stringify(adminCredentials())
  });
  await res.arrayBuffer();
  const location = res.headers.get("location");
  return (res.status >= 300) && (res.status < 400) && !!location && /\/setup$/.test(new URL(location, FOUNDRY).pathname);
}

/** A fresh administrator session while no world runs. Returns the session id. */
export async function adminSession() {
  const session = await bareSession();
  if ( !session ) throw new Error("Foundry gave no session cookie");
  if ( !(await adminLogin(session)) ) throw new Error(ADMIN_REFUSED);
  return session;
}

/** POST /setup as administrator, the way Foundry's own setup page does, with the admin login in the body. */
function adminPost(session, body) {
  return foundryFetch(`${FOUNDRY}/setup`, {
    method: "POST", redirect: "manual",
    headers: { cookie: `session=${session}`, "content-type": "application/json", "sec-fetch-site": "same-origin" },
    body: JSON.stringify({ ...body, ...adminCredentials() })
  });
}

/** Launches a world, as Foundry's setup page does (it loads in the background). Throws on refusal. */
export async function launchWorld(world) {
  const r = await adminPost(await adminSession(), { action: "launchWorld", world });
  const data = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
  if ( !r.ok || data.error ) throw new Error(`Foundry couldn't launch ${world}: ${data.error || `HTTP ${r.status}`}`);
}

/** Return to Setup: shuts the running world down for everyone. Throws on refusal. */
export async function shutdownWorld() {
  const session = await bareSession();
  if ( !session ) throw new Error("Foundry gave no session cookie");
  const r = await adminPost(session, { action: "worldShutdown" });
  await r.arrayBuffer();
  // Success redirects to /setup; a refused login goes back to /join.
  const location = r.headers.get("location") || "";
  if ( !(r.status >= 300 && r.status < 400 && /\/setup$/.test(new URL(location, FOUNDRY).pathname)) ) throw new Error(ADMIN_REFUSED);
}

/** Foundry's worlds and version from the setup data (needs an admin session, so only while no world runs). */
export async function setupWorlds() {
  const data = await socketCall(await adminSession(), "getSetupData");
  if ( !data?.worlds ) throw new Error(ADMIN_REFUSED);
  return { worlds: data.worlds, version: data.release?.version };
}

/** a > b for dotted versions ("14.369" > "13.351"). */
export function newer(a, b) {
  const pa = String(a || "").split(".").map(Number), pb = String(b || "").split(".").map(Number);
  for ( let i = 0; i < Math.max(pa.length, pb.length); i++ ) {
    if ( (pa[i] || 0) !== (pb[i] || 0) ) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

/* ----------------------------------------------- Socket ----------------------------------------------- */

/**
 * Runs fn(call, events) on one Foundry Socket.IO connection over HTTP long-polling: open → connect namespace →
 * call(event, ...args) emits with an ack id and waits for its "43<id>[...]" answer. `events` keeps the last payload
 * of each event the server pushed (Foundry sends "session" right after connecting: { userId } when a user is attached).
 */
export async function withSocket(session, fn) {
  const headers = { cookie: `session=${session}` };
  const base = `${FOUNDRY}/socket.io/?EIO=4&transport=polling`;
  const open = await (await foundryFetch(`${base}&t=${Date.now()}`, { headers })).text();
  const sid = JSON.parse(open.slice(open.indexOf("{"))).sid;
  const url = `${base}&sid=${encodeURIComponent(sid)}`;
  const send = body => foundryFetch(url, { method: "POST", headers: { ...headers, "content-type": "text/plain;charset=UTF-8" }, body });
  const events = {};
  const acks = new Map();
  let connected = false;
  let nextId = 0;
  const poll = async () => {
    for ( const p of (await (await foundryFetch(`${url}&t=${Date.now()}`, { headers })).text()).split("\x1e") ) {
      if ( p === "2" ) await send("3");                         // engine.io ping → pong
      else if ( p.startsWith("40") ) connected = true;
      else if ( p.startsWith("43") ) {
        const m = /^43(\d+)/.exec(p);
        if ( m ) acks.set(Number(m[1]), JSON.parse(p.slice(m[0].length))[0]);
      }
      else if ( p.startsWith("42") ) {
        try { const [event, data] = JSON.parse(p.slice(2)); events[event] = data; } catch {}
      }
    }
  };
  try {
    await send("40");
    // Only until connected: an empty long-poll would hang until Foundry's 20 s ping.
    for ( let i = 0; !connected; i++ ) {
      if ( i >= 10 ) throw new Error("Foundry's socket didn't connect");
      await poll();
    }
    const call = async (event, ...args) => {
      const id = nextId++;
      await send(`42${id}${JSON.stringify([event, ...args])}`);
      for ( let i = 0; i < 20; i++ ) {
        if ( acks.has(id) ) return acks.get(id);
        await poll();
      }
      throw new Error(`No ${event} answer from Foundry`);
    };
    return await fn(call, events);
  } finally {
    // Leave the namespace (Foundry marks the user inactive), then close the transport.
    send("41").then(() => send("1")).catch(() => {});
  }
}

/** One socket request ("getJoinData", "getSetupData") on its own connection. */
export const socketCall = (session, event) => withSocket(session, call => call(event));

/* ----------------------------------------------- Users ----------------------------------------------- */

/** Log a Foundry session in as a user. Returns { ok, redirect } or { ok: false, error }. */
export async function join(session, userId, password) {
  const res = await foundryFetch(`${FOUNDRY}/join`, {
    method: "POST",
    headers: {
      cookie: `session=${session}`,
      "content-type": "application/json",
      // Foundry refuses cross-site POSTs (express.mjs); this server-side call is same-origin by design.
      "sec-fetch-site": "same-origin"
    },
    body: JSON.stringify({ action: "join", userId, password })
  });
  const text = await res.text();
  if ( res.ok ) {
    const data = JSON.parse(text);
    if ( data.status === "success" ) return { ok: true, redirect: data.redirect || "/game" };
  }
  return { ok: false, error: ERRORS[text] || text || `HTTP ${res.status}` };
}

const ERRORS = {
  "JOIN.ErrorInvalidPassword": "That Foundry user doesn't use the shared password (FOUNDRY_PASSWORD).",
  "USERS.LoginAsGMRequired": "Only a Gamemaster can do that."
};

/** Which of the running world's users accept the shared password (a throwaway login each, no socket). */
export async function checkPasswords() {
  const s = await newSession();
  if ( s.noWorld ) throw new Error("No world is running.");
  const results = [];
  for ( const u of s.data.users ) {
    if ( u.role === ROLES.none ) { results.push({ user: u, ok: null }); continue; }
    const session = await bareSession();
    results.push({ user: u, ok: (await join(session, u._id, PASSWORD)).ok });
  }
  return { world: s.data.world, results };
}

/**
 * Changes User documents in the running world as one of its Gamemasters (logged in with the shared password), the way
 * Foundry's client does: socket "modifyDocument" { type: "User", action, operation }. Returns Foundry's result.
 * The GM shows as connected for the second this takes.
 */
export async function modifyUsers(action, operation) {
  const s = await newSession();
  if ( s.noWorld ) throw new Error("No world is running: Foundry users can only be changed while their world runs.");
  const gms = s.data.users.filter(u => u.role === ROLES.gamemaster);
  let joined = null;
  for ( const gm of gms ) {
    if ( (await join(s.session, gm._id, PASSWORD)).ok ) { joined = gm; break; }
  }
  if ( !joined ) throw new Error("None of this world's Gamemaster users accepts the shared password, so the service can't change users.");
  return withSocket(s.session, async (call, events) => {
    if ( events.session && !events.session.userId ) throw new Error(`Foundry didn't attach ${joined.name} to the socket.`);
    const r = await call("modifyDocument", { type: "User", action, operation: { modifiedTime: Date.now(), render: true, ...operation } });
    if ( r?.error ) throw new Error(r.error.message || String(r.error));
    return { gm: joined.name, result: r?.result ?? [] };
  });
}
