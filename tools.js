// The foundry_sso MCP tools: campaign access, Foundry users of the running world, status + audit log, launch/shutdown.
// Reached only through LiteLLM with the MCP token, so every tool acts as the server admin.
import fs from "node:fs";
import path from "node:path";
import { PASSWORD, TABLE_USER, WORLDS_DIR, ADMIN_USERS } from "./config.js";
import * as foundry from "./foundry.js";
import { ROLES, ROLE_NAMES, GM_ROLE } from "./foundry.js";
import * as access from "./access.js";
import { audit, recent } from "./audit.js";
import { ToolError } from "./mcp.js";

const AUTHENTIK_NOTE = "A member also needs the Authentik application \"Foundry VTT\" (swag_publisher site_access / add_user).";

/* ---------------------------------------------- helpers ---------------------------------------------- */

/** Foundry's worlds: Data/worlds/<id>/world.json when mounted, else the setup data (only while no world runs). */
async function listWorlds() {
  try {
    return fs.readdirSync(WORLDS_DIR, { withFileTypes: true }).filter(d => d.isDirectory()).flatMap(d => {
      try {
        const w = JSON.parse(fs.readFileSync(path.join(WORLDS_DIR, d.name, "world.json"), "utf8"));
        return [{ id: w.id || d.name, title: w.title, system: w.system, coreVersion: w.coreVersion, lastPlayed: w.lastPlayed || null }];
      } catch { return []; }
    });
  } catch {
    const { worlds } = await foundry.setupWorlds();
    return worlds.map(w => ({ id: w.id, title: w.title, system: w.system, coreVersion: w.coreVersion, lastPlayed: w.lastPlayed || null }));
  }
}

/** The running world's join data, or null. */
async function running() {
  const s = await foundry.newSession();
  return s.noWorld ? null : s.data;
}

function requireString(args, name) {
  const v = args[name];
  if ( (typeof v !== "string") || !v.trim() ) throw new ToolError(`${name} is required.`);
  return v.trim();
}

/** A world id that exists (when the world list can be read). */
async function knownWorld(id) {
  let worlds = null;
  try { worlds = await listWorlds(); } catch {}
  if ( worlds && !worlds.some(w => w.id === id) ) {
    throw new ToolError(`No world "${id}". Worlds: ${worlds.map(w => w.id).join(", ")}`);
  }
  return worlds?.find(w => w.id === id) || { id };
}

/** The running world, which must be `world` when given. */
async function requireRunning(world) {
  const data = await running();
  if ( !data ) throw new ToolError("No world is running: Foundry users can only be read or changed while their world runs.");
  if ( world && (data.world.id !== world) ) throw new ToolError(`${world} isn't running (the running world is ${data.world.id}).`);
  return data;
}

function findFoundryUser(users, ref) {
  const r = String(ref).toLowerCase();
  return users.find(u => u._id === ref) || users.find(u => u.name.toLowerCase() === r);
}

function roleOf(name) {
  if ( name === undefined ) return undefined;
  const role = ROLES[String(name).toLowerCase()];
  if ( role === undefined ) throw new ToolError(`role must be one of ${Object.keys(ROLES).join(", ")}.`);
  return role;
}

/** Members of a world with what they actually get: their player and whether they may join as GM. */
function describeAccess(world, users) {
  const c = access.campaign(world);
  const members = Object.entries(c?.members || {}).map(([username, m]) => {
    const ak = { username, name: username };
    const player = access.playerName(ak, world);
    const row = { username, player: player || null, player_from: m.player ? "member" : (player ? "USER_MAP" : null), gm: access.mayGM(ak, world) };
    if ( users && player && !findFoundryUser(users, player) ) row.warning = `No Foundry user named "${player}" in this world.`;
    return row;
  });
  return { access: c ? "members-only" : "open (no member list: anyone with the Authentik app may join)", admins: [...ADMIN_USERS], members };
}

/* ----------------------------------------------- tools ----------------------------------------------- */

const STR = { type: "string" };
const WORLD = { type: "string", description: "World id: its folder name under Data/worlds, e.g. my-world (see list_campaigns)." };
const USERNAME = { type: "string", description: "Authentik username, e.g. alice." };
const obj = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });

export const tools = [
  {
    name: "status",
    description: "What Foundry is doing now: the running world (if any), who is connected, Foundry's version, and each campaign's access mode.",
    inputSchema: obj({}),
    async run() {
      const [api, data] = await Promise.all([foundry.apiStatus().catch(e => ({ error: e.message })), running()]);
      const active = new Set(data?.activeUsers || []);
      return {
        foundry_version: api.version || null,
        running_world: data ? { id: data.world.id, title: data.world.title } : null,
        connected: data ? data.users.filter(u => active.has(u._id)).map(u => u.name) : [],
        campaigns: Object.fromEntries(Object.entries(access.campaigns()).map(([w, c]) => [w, `members-only, ${Object.keys(c.members || {}).length} members`])),
        note: "Worlds not listed under campaigns are open to everyone with the Authentik app."
      };
    }
  },
  {
    name: "list_campaigns",
    description: "Every Foundry world (campaign) with its title, system, last played date, whether it is running, and its access mode (members-only with N members, or open).",
    inputSchema: obj({}),
    async run() {
      const [worlds, data] = await Promise.all([listWorlds(), running().catch(() => null)]);
      return worlds.sort((a, b) => String(b.lastPlayed || "").localeCompare(String(a.lastPlayed || ""))).map(w => {
        const c = access.campaign(w.id);
        return { ...w, running: data?.world.id === w.id, access: c ? "members-only" : "open", members: c ? Object.keys(c.members || {}).length : null };
      });
    }
  },
  {
    name: "get_campaign",
    description: "One campaign's access: its members (Authentik username → Foundry player, GM or not) and, while that world runs, its Foundry users with role, connection and which member plays them, plus warnings for mismatches.",
    inputSchema: obj({ world: WORLD }, ["world"]),
    async run(args) {
      const world = (await knownWorld(requireString(args, "world"))).id;
      const data = await running();
      const live = data?.world.id === world ? data : null;
      const result = { world, running: !!live, ...describeAccess(world, live?.users) };
      if ( live ) {
        const active = new Set(live.activeUsers || []);
        const playedBy = new Map(result.members.filter(m => m.player).map(m => [m.player.toLowerCase(), m.username]));
        result.foundry_users = live.users.map(u => ({
          name: u.name, role: ROLE_NAMES[u.role], connected: active.has(u._id),
          member: playedBy.get(u.name.toLowerCase()) || (u.name === TABLE_USER ? "(table screen)" : null)
        }));
      } else {
        result.note = "Start the world to see its Foundry users.";
      }
      return result;
    }
  },
  {
    name: "set_member",
    description: "Give an Authentik user access to a campaign, or change their access: player = their Foundry user name in that world (empty string removes the mapping), gm = may join as a Gamemaster/Assistant GM user. Only the fields given change. The first member makes the world members-only (admins always get in). " + AUTHENTIK_NOTE,
    inputSchema: obj({
      world: WORLD, username: USERNAME,
      player: { type: "string", description: "Foundry user name this person plays in the world (\"\" = none: matched by name)." },
      gm: { type: "boolean", description: "May join as a Gamemaster / Assistant GM user." }
    }, ["world", "username"]),
    async run(args) {
      const world = (await knownWorld(requireString(args, "world"))).id;
      const username = requireString(args, "username").toLowerCase();
      if ( (args.gm !== undefined) && (typeof args.gm !== "boolean") ) throw new ToolError("gm must be true or false.");
      const before = access.campaign(world)?.members?.[username] || null;
      const { member, created } = access.setMember(world, username, { player: args.player, gm: args.gm });
      audit("mcp_set_member", { world, member: username, before, after: member });
      const result = { world, username, member: { ...member }, note: AUTHENTIK_NOTE };
      if ( created ) result.now_members_only = `${world} was open to everyone; now only its members (and admins) can join. Add the other players too.`;
      const data = await running().catch(() => null);
      if ( (data?.world.id === world) && member.player && !findFoundryUser(data.users, member.player) ) {
        result.warning = `No Foundry user named "${member.player}" in ${world} (create_foundry_user can add one).`;
      }
      return result;
    }
  },
  {
    name: "remove_member",
    description: "Take an Authentik user's access to a campaign away. The world stays members-only, even with nobody left (then only admins can join). Doesn't touch Foundry users or Authentik.",
    inputSchema: obj({ world: WORLD, username: USERNAME }, ["world", "username"]),
    async run(args) {
      const world = requireString(args, "world"), username = requireString(args, "username").toLowerCase();
      const before = access.campaign(world)?.members?.[username] || null;
      if ( !access.removeMember(world, username) ) throw new ToolError(`${username} isn't a member of ${world}.`);
      audit("mcp_remove_member", { world, member: username, before });
      return { world, removed: username, members_left: Object.keys(access.campaign(world)?.members || {}) };
    }
  },
  {
    name: "open_campaign",
    description: "Drop a campaign's member list so the world is open again to everyone with the Authentik app (as before campaigns existed). Needs confirm: true.",
    inputSchema: obj({ world: WORLD, confirm: { type: "boolean" } }, ["world", "confirm"]),
    async run(args) {
      const world = requireString(args, "world");
      if ( args.confirm !== true ) throw new ToolError("Set confirm: true to open the campaign to everyone.");
      const removed = access.openCampaign(world);
      if ( !removed ) throw new ToolError(`${world} is already open.`);
      audit("mcp_open_campaign", { world, removed });
      return { world, access: "open", removed_member_list: removed.members };
    }
  },
  {
    name: "create_foundry_user",
    description: "Create a Foundry user in the RUNNING world with the shared password. role: player (default), trusted, assistant, gamemaster. Optionally member = Authentik username to add to the campaign as playing this user (gm set for assistant/gamemaster).",
    inputSchema: obj({
      world: WORLD, name: { type: "string", description: "Foundry user name." },
      role: { type: "string", enum: ["player", "trusted", "assistant", "gamemaster"] },
      member: USERNAME
    }, ["world", "name"]),
    async run(args) {
      const world = requireString(args, "world"), name = requireString(args, "name");
      const role = roleOf(args.role ?? "player");
      if ( role === ROLES.none ) throw new ToolError("Can't create a banned user.");
      const data = await requireRunning(world);
      if ( findFoundryUser(data.users, name) ) throw new ToolError(`${world} already has a user named ${name}.`);
      const r = await foundry.modifyUsers("create", { data: [{ name, role, password: PASSWORD }] });
      audit("mcp_create_user", { world, foundry_user: name, role: ROLE_NAMES[role], via_gm: r.gm });
      const result = { world, created: { name, role: ROLE_NAMES[role] }, password: "the shared password" };
      if ( args.member ) {
        const username = String(args.member).toLowerCase();
        const { member, created } = access.setMember(world, username, { player: name, ...(role >= GM_ROLE ? { gm: true } : {}) });
        audit("mcp_set_member", { world, member: username, after: member });
        result.member = { username, ...member };
        if ( created ) result.now_members_only = `${world} is now members-only. Add the other players too.`;
      }
      return result;
    }
  },
  {
    name: "update_foundry_user",
    description: "Rename a Foundry user of the RUNNING world or change their role (player, trusted, assistant, gamemaster, none = banned). Campaign members mapped to the old name follow a rename.",
    inputSchema: obj({
      world: WORLD, user: { type: "string", description: "Current Foundry user name (or id)." },
      name: { type: "string", description: "New name." },
      role: { type: "string", enum: ["none", "player", "trusted", "assistant", "gamemaster"] }
    }, ["world", "user"]),
    async run(args) {
      const world = requireString(args, "world");
      const data = await requireRunning(world);
      const user = findFoundryUser(data.users, requireString(args, "user"));
      if ( !user ) throw new ToolError(`No Foundry user ${args.user} in ${world}.`);
      const update = { _id: user._id };
      if ( args.name !== undefined ) {
        const name = requireString(args, "name");
        const clash = findFoundryUser(data.users, name);
        if ( clash && clash._id !== user._id ) throw new ToolError(`${world} already has a user named ${name}.`);
        update.name = name;
      }
      if ( args.role !== undefined ) update.role = roleOf(args.role);
      if ( Object.keys(update).length === 1 ) throw new ToolError("Give a new name or role.");
      if ( (update.role !== undefined) && (user.role === ROLES.gamemaster) && (update.role !== ROLES.gamemaster)
        && (data.users.filter(u => u.role === ROLES.gamemaster).length === 1) ) {
        throw new ToolError(`${user.name} is the world's only Gamemaster; make someone else Gamemaster first.`);
      }
      const r = await foundry.modifyUsers("update", { updates: [update], diff: true, recursive: true });
      const renamed = [];
      if ( update.name ) {
        for ( const [username, m] of Object.entries(access.campaign(world)?.members || {}) ) {
          if ( m.player?.toLowerCase() === user.name.toLowerCase() ) {
            access.setMember(world, username, { player: update.name });
            renamed.push(username);
          }
        }
      }
      audit("mcp_update_user", { world, foundry_user: user.name, changes: { name: update.name, role: ROLE_NAMES[update.role] }, via_gm: r.gm });
      return { world, user: user.name, now: { name: update.name ?? user.name, role: ROLE_NAMES[update.role ?? user.role] }, members_remapped: renamed };
    }
  },
  {
    name: "check_passwords",
    description: "Which Foundry users of the RUNNING world don't accept the shared password (those can't be joined through the join page). Read-only: one throwaway login per user.",
    inputSchema: obj({}),
    async run() {
      const { world, results } = await foundry.checkPasswords();
      return {
        world: world.id,
        shared_password_ok: results.filter(r => r.ok).map(r => r.user.name),
        wrong_password: results.filter(r => r.ok === false).map(r => r.user.name),
        banned: results.filter(r => r.ok === null).map(r => r.user.name)
      };
    }
  },
  {
    name: "set_shared_password",
    description: "Give Foundry users of the RUNNING world the shared password. Default: only the users that don't accept it yet (check_passwords). Changing a password logs that user out of Foundry, so users = [names] picks exactly whom.",
    inputSchema: obj({ users: { type: "array", items: STR, description: "Foundry user names; default = every user with a different password." } }),
    async run(args) {
      const { world, results } = await foundry.checkPasswords();
      let targets;
      if ( Array.isArray(args.users) && args.users.length ) {
        targets = args.users.map(n => {
          const r = results.find(x => x.user.name.toLowerCase() === String(n).toLowerCase() || x.user._id === n);
          if ( !r ) throw new ToolError(`No Foundry user ${n} in ${world.id}.`);
          return r.user;
        });
      } else {
        targets = results.filter(r => r.ok === false).map(r => r.user);
      }
      if ( !targets.length ) return { world: world.id, changed: [], note: "Every user already accepts the shared password." };
      const r = await foundry.modifyUsers("update", { updates: targets.map(u => ({ _id: u._id, password: PASSWORD })), diff: true, recursive: true });
      audit("mcp_set_password", { world: world.id, foundry_users: targets.map(u => u.name), via_gm: r.gm });
      return { world: world.id, changed: targets.map(u => u.name), note: "These users were logged out of Foundry and can join again from the join page." };
    }
  },
  {
    name: "launch_world",
    description: "Launch a world (only while no world runs). Worlds that need a core migration should be launched from Foundry's setup instead, where Foundry offers a backup first.",
    inputSchema: obj({ world: WORLD }, ["world"]),
    async run(args) {
      const w = await knownWorld(requireString(args, "world"));
      const api = await foundry.apiStatus().catch(() => ({}));
      if ( api.active ) throw new ToolError(`${api.world} is running; shut it down first (shutdown_world).`);
      if ( api.version && w.coreVersion && foundry.newer(api.version, w.coreVersion) ) {
        throw new ToolError(`${w.id} was last saved with Foundry ${w.coreVersion} and needs migrating to ${api.version}: launch it from Foundry's setup, which offers a backup first.`);
      }
      await foundry.launchWorld(w.id);
      audit("mcp_launch", { world: w.id });
      return { world: w.id, launching: true, note: "Foundry loads it in the background; the join page lets players in once it's ready." };
    }
  },
  {
    name: "shutdown_world",
    description: "Return to Setup: shut the running world down for every connected player. Needs confirm: true.",
    inputSchema: obj({ confirm: { type: "boolean" } }, ["confirm"]),
    async run(args) {
      if ( args.confirm !== true ) throw new ToolError("Set confirm: true: this disconnects every player.");
      const data = await running();
      if ( !data ) throw new ToolError("No world is running.");
      const active = new Set(data.activeUsers || []);
      await foundry.shutdownWorld();
      audit("mcp_shutdown", { world: data.world.id });
      return { world: data.world.id, shut_down: true, disconnected: data.users.filter(u => active.has(u._id)).map(u => u.name) };
    }
  },
  {
    name: "audit_log",
    description: "Recent events, newest first: joins (who joined which world as which Foundry user), refusals, admin launches/shutdowns/setup visits, and MCP changes. Filters: world, user (Authentik username), event.",
    inputSchema: obj({ limit: { type: "integer", minimum: 1, maximum: 1000 }, world: STR, user: STR, event: STR }),
    async run(args) {
      return { events: recent({ limit: Math.min(Number(args.limit) || 50, 1000), world: args.world, user: args.user, event: args.event }) };
    }
  }
];
