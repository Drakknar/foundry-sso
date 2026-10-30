// Campaign access: who may join which world, kept in DATA_DIR/access.json and changed by the MCP tools.
//   { "campaigns": { "<world-id>": { "members": { "<authentik username>": { "player": "Foundry name", "gm": true } } } } }
// A world listed there is members-only (admins always get in); a world not listed is open to everyone Authentik lets
// in, as before campaigns existed. Members may still join as any non-GM player of the world, or as the Table.
// A hand edit of the file is picked up on the next request. If no good copy was ever read (file missing or broken at
// start), only admins get in, so a lost mount or a typo can't open a members-only world.
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, USER_MAP, GM_USERS, inWorld, isAdmin, log } from "./config.js";

const FILE = path.join(DATA_DIR, "access.json");
let state = { campaigns: {} };
let loadedMtime = 0;
let available = false;
let warnedMissing = false;

function load() {
  try {
    const mtime = fs.statSync(FILE).mtimeMs;
    if ( mtime === loadedMtime ) return state;
    const data = JSON.parse(fs.readFileSync(FILE, "utf8"));
    const c = data?.campaigns;
    if ( !c || (typeof c !== "object") || Array.isArray(c) ) throw new Error('no "campaigns" object');
    state = { campaigns: c };
    loadedMtime = mtime;
    available = true;
  } catch ( e ) {
    const keeping = available ? "keeping the last good copy" : "only admins can join";
    if ( e.code !== "ENOENT" ) log(`access.json unreadable, ${keeping}: ${e.message}`);
    else if ( !warnedMissing ) {
      warnedMissing = true;
      log(`access.json missing, ${keeping}. To open unlisted worlds, create it with {"campaigns":{}}.`);
    }
  }
  return state;
}

function save() {
  const tmp = `${FILE}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
    fs.renameSync(tmp, FILE);
    loadedMtime = fs.statSync(FILE).mtimeMs;
    available = true;
  } catch ( e ) {
    throw new Error(`Couldn't write ${FILE} (is ${DATA_DIR} mounted read-write?): ${e.message}`);
  }
}

/** Before a change: never overwrite a file that couldn't be read. */
function loadForChange() {
  load();
  if ( !available && fs.existsSync(FILE) ) throw new Error("access.json can't be read, so it wasn't changed. Fix the file first.");
}

const key = world => String(world || "").toLowerCase();

/** The campaign entry for a world, or null when the world is open to everyone. */
export function campaign(world) {
  return load().campaigns[key(world)] || null;
}

export const campaigns = () => load().campaigns;

/** May this Authentik user join the world at all? */
export function canEnter(ak, world) {
  if ( !ak ) return false;
  if ( isAdmin(ak) ) return true;
  const c = campaign(world);
  if ( !available ) return false;
  return !c || !!c.members?.[ak.username.toLowerCase()];
}

/** May this Authentik user join the world as a Gamemaster / Assistant GM user? */
export function mayGM(ak, world) {
  if ( !ak ) return false;
  if ( isAdmin(ak) ) return true;
  const username = ak.username.toLowerCase();
  if ( campaign(world)?.members?.[username]?.gm ) return true;
  return inWorld(GM_USERS, world).some(e => (e.entry === "*") || (e.entry === username));
}

/** The Foundry user name an Authentik user plays in a world, if set: the member's "player", else USER_MAP. */
export function playerName(ak, world) {
  const username = ak.username.toLowerCase();
  const member = campaign(world)?.members?.[username];
  if ( member?.player ) return member.player;
  const entries = inWorld(USER_MAP, world).filter(e => e.username === username);
  return (entries.find(e => e.world) || entries[0])?.name || null;
}

/**
 * Adds or changes a member. `player` (string, or null to drop it) and `gm` (boolean) change only when given.
 * Returns { member, created } where created = the world just became members-only.
 */
export function setMember(world, username, { player, gm } = {}) {
  loadForChange();
  const w = key(world), u = String(username).toLowerCase();
  const created = !state.campaigns[w];
  const c = state.campaigns[w] ||= { members: {} };
  c.members ||= {};
  const m = c.members[u] ||= {};
  if ( player !== undefined ) {
    if ( player ) m.player = String(player);
    else delete m.player;
  }
  if ( gm !== undefined ) {
    if ( gm ) m.gm = true;
    else delete m.gm;
  }
  save();
  return { member: m, created };
}

/** Removes a member; the world stays members-only even with nobody left (admins only). Returns false if absent. */
export function removeMember(world, username) {
  loadForChange();
  const c = state.campaigns[key(world)];
  const u = String(username).toLowerCase();
  if ( !c?.members?.[u] ) return false;
  delete c.members[u];
  save();
  return true;
}

/** Drops a world's member list: it is open to everyone Authentik lets in again. Returns the removed entry. */
export function openCampaign(world) {
  loadForChange();
  const c = state.campaigns[key(world)];
  if ( !c ) return null;
  delete state.campaigns[key(world)];
  save();
  return c;
}
