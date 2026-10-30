# foundry-sso

Handles every Foundry VTT login step for every campaign and for the admin area, with single sign-on through Authentik. Its join page is mobile-friendly.

## How it works

```
browser ─► Cloudflare ─► SWAG (Authentik forward auth on the whole site)
                           ├─ /join, /join/*                                   ─► foundry-sso ─► Foundry
                           ├─ /auth /setup /create /update /license /quit      ─► foundry-sso (admin routes)
                           └─ everything else                                  ─► Foundry
```

- **Authentik** guards the whole site: a plain proxy provider "Foundry VTT", with no HTTP Basic and no attributes. SWAG's `authentik-location.conf` passes the signed-in user as `X-authentik-username` / `X-authentik-name`.
- **One shared Foundry password:** every Foundry user in every world, the Table included, has the same password, `FOUNDRY_PASSWORD`. Only this service knows it. This suits a group of trusted players and keeps the setup simple.
- **The page** shows:
  - **Continue as <player>**, with the buttons **Join** and **Join on phone**
  - **Join as Table**, for the table screen (always desktop)
  - **Join as another player**: a player list with the same two buttons

  **Gamemaster and Assistant GM users** (Foundry roles 3 and 4) are offered only to the Authentik users in `GM_USERS` and to admins. Otherwise the shared password would let any player join as GM.

  The Authentik user's own player comes from `USER_MAP` (`authentikUsername=Foundry name;…`). Without an entry, the service matches the Authentik name, its first word, or the username against the Foundry user names (case-insensitive).
- **Campaigns (access.js, `/data/access.json`):** Foundry runs one world at a time, and each world has its own users.
  - **Members-only:** a world listed in `access.json` admits only its members, and admins always get in. Members may still join as any non-GM player of that world, or as the Table. Anyone else sees "You're not in this campaign", and their POSTs from Foundry's own page are refused. A world that isn't listed stays open to everyone with the Authentik app, as before.
  - **File format:** `{"campaigns": {"<world-id>": {"members": {"<authentik username>": {"player": "Foundry name", "gm": true}}}}}`. The world id is the world's folder name under `Data/worlds`. A member's `player` overrides the `USER_MAP` entry, and `gm: true` lets them join as a Gamemaster or Assistant GM. The MCP edits this file; a hand edit takes effect on the next request.
  - **Env fallbacks:** the env vars still work, with an optional `world-id/` prefix. `GM_USERS=my-world/alice` lets Alice be GM in that world only; an entry without a prefix applies to every world, and `*` means everyone. In `USER_MAP=alice=Alice;my-world/bob=Bob the Bard`, the world entry wins.
- **Audit log:** every join, refusal, launch, shutdown, setup visit and MCP change goes to `/data/audit.log` as one JSON line. The file rolls over to `audit.log.1` at 5 MB.
- **Logging in:** the service opens a Foundry session, reads the users over Socket.IO (`getJoinData`, HTTP long-polling, no client library), and posts `{action: "join", userId, password}` to Foundry's `/join`. It then gives the browser Foundry's `session` cookie and redirects to `/game?phone=on|off`. The awesome-vtt-mobile module reads that parameter and switches phone mode on or off for the device without asking.
- **No world running:** the page says so and checks again every 20 s. Players who are waiting, and the table screen, get in on their own once a world starts.
- **Table screen:** open `/join?auto=table` once in the kiosk profile. From then on, that browser joins as the Table by itself whenever a world is running, and after a world shuts down it goes back to the waiting page, never to setup. The page links to `/join?auto=off`, which turns this off. Auto-join is skipped when the last try failed (so it can't loop) or when the Table is already connected somewhere else.

## Admin

`ADMIN_USERS` are the only Authentik users who reach anything admin:

- **Foundry's admin routes** (`/auth`, `/setup`, `/create`, `/update`, `/license`, `/quit`) are proxied through this service. For admins, opening `/setup` or `/auth` logs their Foundry session in as administrator server-side (a POST to Foundry's `/auth` form with `FOUNDRY_ADMIN_USERNAME` / `FOUNDRY_ADMIN_PASSWORD`), and their POSTs to `/setup` get the admin login filled in, so nobody types the admin password. Everyone else is sent back to `/join` (GET) or refused with a 403 (POST).
  - That covers Foundry's in-game **Return to Setup** too: for a GM who isn't an admin, it now does nothing. Otherwise a GM could shut the world down, and only the admin could start it again. In-game **Edit World** still works for GMs: it also posts to `/setup`, so that one action is passed on and Foundry checks the GM role.
  - Why not Foundry 14's **externalAdminAuth** (admin login by proxy headers): Foundry turns it off at startup unless it serves TLS itself or listens on a Unix socket ("externalAdminAuth disabled: either a Unix socket or TLS certificate and key must be configured."), and ours is plain HTTP behind SWAG. Leave it out of options.json.
- **Admin card on the join page:**
  - **No world:** every world, most recently played first, each with a **Launch** button: one click launches it and waits on `/join?starting=<id>`. Worlds that are locked or need a core migration have no button; they go through **Game setup**, where Foundry asks about a backup first.
  - **World running:** **Return to Setup** shuts the world down for every player (the browser asks first) and opens setup.
  - **The table screen** (auto-table cookie) never opens setup, even when its Authentik account is an admin.
- Without `FOUNDRY_ADMIN_PASSWORD` there's no admin at all.

## MCP (`foundry_sso` in LiteLLM)

The MCP listens on container port 8081 (`MCP_PORT`), meant for an MCP gateway such as LiteLLM. It needs the bearer token `MCP_TOKEN`; without one, every request gets a 401. It speaks stateless Streamable HTTP with JSON answers (mcp.js, no SDK). Every tool acts as the server admin, so use it only through LiteLLM.

| Tool | What it does |
|---|---|
| `status` | the running world, who's connected, Foundry's version, and the members-only campaigns |
| `list_campaigns` | every world, with title, system, last played date, whether it's running, and its access mode (read from `/worlds`; without that mount, from the setup data while no world runs) |
| `get_campaign` | one world's members and their effective player and GM rights; while the world runs, also its Foundry users with role, connection and member, plus warnings |
| `set_member` | adds a member or changes one (`player`, `gm`); the first member makes the world members-only |
| `remove_member` | removes a member; the world stays members-only |
| `open_campaign` | drops the member list, so the world is open again (needs `confirm: true`) |
| `create_foundry_user` | creates a user in the running world with the shared password, and can add them as a campaign member |
| `update_foundry_user` | renames a user or changes their role in the running world; members follow a rename, and the world's only Gamemaster can't be demoted |
| `check_passwords` | finds the running world's users who don't accept the shared password (one throwaway login each) |
| `set_shared_password` | gives those users the shared password (or the users you list); Foundry logs each changed user out |
| `launch_world` | launches a world, but not one that needs a core migration (use setup for that) |
| `shutdown_world` | Return to Setup (needs `confirm: true`) |
| `audit_log` | recent events, newest first, filterable by world, user and event |

The Foundry user tools work only while that world runs. They log in as one of its Gamemaster users with the shared password and send Foundry's own `modifyDocument` socket request. That GM shows as connected for about a second. Giving someone access to Foundry at all is still done in Authentik.

## Safety

- **Authentik is required:** the page and `POST /join/as` refuse requests without `X-authentik-username`. That check is only safe because nothing can reach the container except through SWAG (see Container).
- **Cross-site POSTs** to `/join/as` and `/join/admin` are refused.
- **Fallbacks:** `/join?classic=1` shows Foundry's own join page, and its POSTs to `/join` are passed through. That page lists every user, GMs included, and everyone shares one password. So a `join` or `loginAs` for a Gamemaster or Assistant GM user is refused (403) for anyone who isn't a GM in that world, the same rule as on this page.
- **Timeouts:** every call to Foundry gives up after 15 s. The page then says Foundry isn't answering and retries every 10 s, which also covers a world that's still loading.
- **Only through SWAG:** the `x-authentik-*` headers are only trusted on requests carrying `X-Foundry-Sso-Secret`. SWAG adds it (`nginx/foundry-sso-secret.conf`, included in both sidecar locations and overwriting anything a client sends), and the service compares it to `/data/proxy-secret` (or env `PROXY_SECRET`) and never passes it on to Foundry. The Docker bridge port alone isn't enough, because every other container can reach it. No secret set = every request refused, `/join/healthz` excepted. To rotate: change both files, then restart this service.

The service stores only `access.json`, `audit.log` and the auto-table cookie, and it never logs a password.

## Container

Image: `ghcr.io/drakknar/foundry-sso` (Node 22 built-ins only, no dependencies). Port 8080 serves the join page and must only be reachable by the reverse proxy; port 8081 serves the MCP.

Required: `FOUNDRY_URL`, `FOUNDRY_PASSWORD`, and a proxy secret in `/data/proxy-secret` or `PROXY_SECRET`. Without a proxy secret every request is refused, `/join/healthz` excepted.

Optional: `TABLE_USER` (`Table`; empty hides the button), `USER_MAP`, `GM_USERS`, `ADMIN_USERS`, `FOUNDRY_ADMIN_USERNAME`, `FOUNDRY_ADMIN_PASSWORD`, `MCP_TOKEN`, `PORT`, `MCP_PORT`, `DATA_DIR`, `WORLDS_DIR`, `SIGN_OUT_URL`.

Mounts: `/data` (read-write), `/worlds` (read-only view of Foundry's `Data/worlds`).

## Adding a player or a campaign

1. In Authentik, give the person access to the "Foundry VTT" application (or your own tooling).
2. Start the world, then use the MCP: `create_foundry_user` with `world`, `name`, and `member` = their Authentik username. That creates the user with the shared password and adds them to the campaign in one step.
3. For a GM, call `set_member` with `gm: true`. For a person whose Foundry user already exists, `set_member` with `player` is enough.
