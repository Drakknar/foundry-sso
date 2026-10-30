// Audit log: one JSON line per event in DATA_DIR/audit.log (joins, refusals, admin actions, MCP changes), plus the
// last 1000 in memory for the MCP's audit_log tool. Rolled over to audit.log.1 at 5 MB.
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, log } from "./config.js";

const FILE = path.join(DATA_DIR, "audit.log");
const KEEP = 1000;
const MAX_BYTES = 5 * 1024 * 1024;
const recentEvents = [];

try {
  const lines = fs.readFileSync(FILE, "utf8").trim().split("\n").slice(-KEEP);
  for ( const l of lines ) { try { recentEvents.push(JSON.parse(l)); } catch {} }
} catch {}

let warned = false;

/** Records an event: audit("join", { user, world, as, mode }). Never throws. */
export function audit(event, fields = {}) {
  const entry = { time: new Date().toISOString(), event, ...fields };
  recentEvents.push(entry);
  if ( recentEvents.length > KEEP ) recentEvents.shift();
  try {
    if ( fs.statSync(FILE, { throwIfNoEntry: false })?.size > MAX_BYTES ) fs.renameSync(FILE, `${FILE}.1`);
    fs.appendFileSync(FILE, `${JSON.stringify(entry)}\n`);
  } catch ( e ) {
    if ( !warned ) log(`audit.log not writable (is ${DATA_DIR} mounted read-write?): ${e.message}`);
    warned = true;
  }
}

/** The newest events first, optionally only one world / Authentik user / event type. */
export function recent({ limit = 50, world, user, event } = {}) {
  return recentEvents.filter(e => (!world || e.world === world) && (!user || e.user === user) && (!event || e.event === event))
    .slice(-limit).reverse();
}
