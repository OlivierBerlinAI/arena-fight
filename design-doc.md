# One-Shot Prompt: "Mech Arena Fight" — Web-based 1v1 Base Assault

> Paste everything below this line into a fresh session.

---

Build a complete, runnable, web-based multiplayer game inspired by the base-assault mode of Future Cop: L.A.P.D. (1998). Two players each pilot a hovering combat mech, but the match is won strategically: each player has a base with a robot factory, builds autonomous attack robots, captures neutral turrets, and wins by getting one of their own robots into the opponent's base. The deliverable is a working monorepo I can start with a single command and play in two browser tabs.

## Tech stack (use exactly this)

- **Language:** TypeScript everywhere.
- **Client:** Three.js + Vite. No React, plain TS + DOM for UI overlays (lobby, HUD, build menu).
- **Server:** Node.js with the `ws` WebSocket library. No socket.io, no Colyseus, no database — all state in memory.
- **Structure:** Monorepo with npm workspaces:
  - `packages/shared` — message protocol types, game constants, map layout (spawns, lanes, turret positions), simulation math used by both sides
  - `packages/server` — authoritative game server + lobby
  - `packages/client` — Three.js client
- **Testing:** Vitest for unit/integration tests, Playwright for end-to-end browser tests (see the dedicated testing section below — it is a first-class requirement, not an afterthought).
- A root `npm run dev` must start server and client concurrently (use `concurrently`). Root scripts must also include `npm test` (Vitest), `npm run test:e2e` (Playwright), and `npm run simulate` (headless scripted match). Include a README with setup, play, test, and debug instructions.

## Architecture requirements

- **Authoritative server.** The server runs the simulation at a configurable tick rate (`TICK_RATE`, default 100 Hz): mechs, projectiles, AI robots, turrets, economy. The rate is carried on the balance so every tick-based duration scales with it (game feel in seconds is rate-invariant) and is sent to clients in `matchStart`. Clients send only inputs (movement, aim, fire, build commands); the server simulates and broadcasts state snapshots every other tick.
- **Pure, deterministic simulation core.** The entire game simulation must live in a self-contained module (e.g. `GameSimulation` class) with no timers, no sockets, no `Date.now()`, and no global state inside. It exposes `tick(inputsByPlayer)` and is advanced externally by the room's tick loop. All randomness comes from a seeded PRNG; the seed is chosen at match start and logged. Same seed + same input sequence ⇒ identical match. This is non-negotiable — it is what makes the game headless-testable.
- **Client-side interpolation.** Clients render all entities by interpolating between the two most recent snapshots (~100 ms render delay). No client-side prediction/reconciliation in v1.
- **Protocol:** JSON messages over WebSocket, with a discriminated-union message type defined once in `shared` (e.g. `input`, `buildUnit`, `snapshot`, `lobbyState`, `matchEvent`). Validate all incoming messages on the server (including: can the player afford the unit?); never trust the client.
- **Rooms:** The server manages multiple independent game rooms. Each room: max 2 players, own simulation loop, cleaned up when empty.

## Lobby flow

1. Player opens the page, enters a display name.
2. Lobby screen shows a live list of open rooms (name, host, player count) plus a "Create room" button.
3. Creating a room puts you in a waiting screen; another player can join from the list.
4. When 2 players are present, both click "Ready"; a 3-second countdown starts, then the match begins.
5. After a match ends (victory/defeat screen), players return to the lobby. Handle disconnects gracefully at every stage (opponent leaves → remaining player wins by forfeit and is returned to lobby; room is removed).

## The mech (player avatar)

- A hovering walker in the spirit of the X1-Alpha. Omnidirectional strafing on a flat plane (WASD relative to camera), torso/aim controlled by the mouse, subtle hover bob, weighty acceleration/friction.
- **Camera:** Third-person chase camera, slightly elevated and behind the mech. Mouse aim projects onto the ground plane.
- **Weapons (server-simulated projectiles):**
  - *Primary — Gatling:* left mouse, high fire rate, low damage, slight spread, overheat meter (overheat forces a 2 s cooldown).
  - *Secondary — Rockets:* right mouse, slow projectile, splash damage with falloff, 1.5 s cooldown, 3-rocket burst then reload.
- 100 HP. On death: explosion, 4 s respawn inside the own base, 2 s spawn protection. **Player kills do not win the match** — dying just takes the defender off the field at a critical moment.

## Strategic layer (this is the heart of the game)

### Bases
- Each player has a base in opposite corners of the map: a walled compound with one gate opening toward the lanes, the robot factory inside, and a clearly marked **core pad**.
- **Win condition:** the match is won instantly when one of your robots enters the opponent's core pad zone. Only robots can capture — the player mech entering the enemy base does nothing. Defending means killing incoming robots before they reach the pad.
- Own units and the own mech can pass the gate freely; geometry must funnel enemy robots through the gate (no leaking through walls).

### Economy
- Passive income: +1 credit per second per player.
- Each owned turret: +1 credit per second extra.
- Starting credits: 100. Show credits prominently in the HUD.

### Robot factory & units
- The factory is a building inside the own base. Build commands via hotkeys (1/2) plus a small always-visible build bar in the HUD showing cost, build time, and queue (max queue: 3).
- **Small robot — "Tank":** cost 50, build time 5 s. Fast, 80 HP, light cannon (damages mechs, robots, and turrets). Spawns at the factory, drives out of the gate and follows the lane toward the enemy base.
- **Large robot — "Heavy Tank":** cost 400, build time 15 s. Slow, 400 HP, heavy cannon with splash. Same behavior, much harder to stop.
- **Unit AI (keep it deliberately simple):** units follow a predefined waypoint lane (lane data lives in `shared`). While moving, they engage the nearest enemy entity in range (enemy robots > enemy turrets > enemy mech), stop to shoot, then continue. On reaching the enemy core pad → match over. No pathfinding algorithm — waypoints plus local steering/separation so units don't stack inside each other.
- Unit cap: 8 robots per player alive at once (reject builds beyond that, greyed-out UI).

### Neutral turrets
- 4 neutral turret towers at fixed symmetric map positions (two per lane / flank).
- **Capture:** a turret has a capture pad at its foot. A player mech standing on the pad for 3 uninterrupted seconds flips the turret to their side (progress ring shown in-world and on the HUD). Capturing is mech-only; robots cannot capture.
- An owned turret automatically fires at enemy mechs and robots in range (moderate DPS) and pays +1 credit/s.
- Turrets can be destroyed (300 HP); a destroyed turret respawns as neutral after 30 s. Enemy players can also re-capture an intact turret by standing on the pad (capture progress first drains to neutral, then flips).

### Map
- One handcrafted, point-symmetric map, roughly 120×120 units: two corner bases, **two lanes** (left and right) connecting them, cover blocks along the lanes, the 4 turrets guarding the lanes, and an open contested middle that lets the mechs rotate quickly between lanes.
- All layout data (walls as AABBs, lane waypoints, turret positions, base zones) defined declaratively in `packages/shared/src/map.ts` so server collision and client rendering are generated from the same source.
- Collision is server-side: circles (mechs, robots) vs. AABBs; projectiles collide with geometry, mechs, robots, and turrets.

### Match flow & feedback
- Match timer counts up; no time limit needed in v1 (sudden death not required).
- A **minimap** in the HUD corner is mandatory: bases, lanes, turret ownership colors, robots, both mechs. Without it the mode is unreadable.
- Event feed (top of screen): "Turret captured", "Heavy Tank deployed", "Your base is under attack!". Audio is out of scope; visual feedback must compensate.
- Victory/defeat screen with match duration and stats (robots built, robots destroyed, turret captures, kills), then back to lobby; rematch without restarting the server must work.

## Visual style

- No external assets. Everything from Three.js primitives: low-poly mech (boxes/cylinders: legs, torso, gun arms), tanks as flat wedges, heavy tanks as bulky multi-part hulls, turrets as towers with rotating heads that visibly track targets.
- Team colors via emissive accents: cyan vs. orange; neutral turrets grey. Late-90s sci-fi look: dark ground with subtle grid, fog, one directional light + ambient. Cheap particle effects for muzzle flash, rocket trails, explosions, and the capture progress ring.
- HUD: health bar, heat meter, rocket pips, credits, build bar with queue, unit cap indicator, minimap, match timer, ping.

## Testing & debuggability (mandatory, first-class requirement)

This project will be developed and debugged iteratively by an AI agent, so it must be fully testable and inspectable **without a human looking at the screen**.

### Layer 1 — Headless simulation tests (Vitest)
- Because the simulation core is pure and deterministic, unit tests can construct a match, inject inputs, and fast-forward thousands of ticks in milliseconds. No sockets, no browser.
- Required unit/integration tests at minimum: mech movement & wall collision, gatling overheat cycle, rocket splash falloff, turret capture (progress, interruption, drain-to-neutral, recapture), economy (income, affordability validation, queue limits, unit cap), tank lane-following reaching the enemy core pad, win condition firing exactly once, and a determinism test (same seed + same inputs ⇒ identical final state hash).

### Layer 2 — Headless protocol tests (Vitest + real WebSockets)
- Provide a reusable **bot client** (`packages/server/test/botClient.ts`): a Node-side class that speaks the real WebSocket protocol — join lobby, create/join room, ready, send inputs, build units, receive snapshots.
- Integration tests boot the actual server on a random port, connect two bot clients, and play scripted matches, e.g.: bot A builds tanks, bot B idles ⇒ assert bot A wins within N seconds; disconnect mid-match ⇒ assert forfeit handling; invalid messages (unaffordable build, malformed JSON) ⇒ assert rejection without crashing the room.
- The server must accept a `TICK_MS` env override and a test balance preset so these tests run accelerated (full match in a few seconds of wall time).

### Layer 3 — End-to-end tests (Playwright)
- Playwright config uses the `webServer` option to boot server + client automatically.
- Tests use **two browser contexts** in one test to simulate both players: full lobby flow (name → create room → second context joins → both ready → countdown → match starts), build flow (press hotkey ⇒ credits drop, queue UI updates, robot appears), and a full victory flow using the accelerated test balance preset (activated via `?test=1` query param), ending on the victory/defeat screens in the respective contexts, then back to lobby and rematch.
- **Assertable state, not pixels.** Canvas pixels cannot be asserted, so the client must expose hooks:
  - Every DOM/UI element (lobby buttons, room list entries, build bar, credits, health, event feed, victory screen) carries a stable `data-testid`.
  - A read-only `window.__game` object: current phase, tick, ping, credits, snapshot age, and a serialized entity list (positions, HP, ownership). Playwright asserts game logic through this object (e.g. "a tank entity owned by player A exists and its x increases").
- Playwright runs headless by default; failure artifacts (screenshot, trace) must be enabled.

### Layer 4 — Runtime debug tooling
- **`npm run simulate`:** a Node script that runs a complete scripted match headlessly (two bot strategies against each other), prints the event log and outcome, and exits non-zero on simulation errors. This is the agent's fastest smoke test — no browser involved.
- **Server inspection endpoint:** `GET /debug/state` on the server's HTTP port returns full JSON of all rooms (players, entities, economy, tick). An agent must be able to `curl` the live game state at any moment.
- **Client debug overlay:** toggled with F3 — fps, ping, server tick vs. render tick, snapshot age, entity counts, own mech state. Also logs every protocol error to the console.
- **Structured logging:** server logs are single-line JSON with a level field; `LOG_LEVEL=debug` enables per-tick diagnostics for a room. Every rejected client message is logged with the reason.



- Strict TypeScript (`strict: true`), no `any` in the protocol layer.
- All balance constants (costs, build times, HP, DPS, income, capture time, unit cap) in a single `packages/shared/src/balance.ts` so they can be tuned in one place.
- The game must be playable end-to-end: two browser tabs → lobby → match → build robots, capture turrets, defend, win by base capture → result screen → rematch, without restarting the server.
- Server-side simulation must stay stable with the maximum entity count (2 mechs, 16 robots, 4 turrets, projectiles).
- `npm test`, `npm run test:e2e`, and `npm run simulate` must all pass/succeed in the delivered project — do not deliver with failing or skipped tests.
- Log meaningful server events (room created, match start, turret captured, unit built, base captured, match end).
- Structure server code as lobby manager / room / simulation (mechs, units, turrets, economy as separate modules) / protocol.

## Explicitly out of scope (do not build)

- Story/campaign content, AI opponents for the mechs, more than 2 players, accounts/auth, persistence, audio, mobile controls, free pathfinding (lanes only), fog of war.

Build order: monorepo + shared protocol/map/balance → pure simulation core **with Vitest tests written alongside each system** (mechs → projectiles → turrets → economy/factory → unit AI → win condition) → server transport layer (lobby → rooms) + bot client + protocol integration tests + `npm run simulate` → client (lobby UI → rendering → input → interpolation → HUD/minimap/build bar → `window.__game` hooks + testids) → Playwright e2e suite → polish gameplay feel. Deliver the complete project.