# Precinct Duel

A web-based 1v1 base-assault arena inspired by the *Precinct Assault* mode of
Future Cop: L.A.P.D. Two players each pilot a hovering combat mech — but the
match is won strategically: build autonomous attack robots at your base
factory, capture neutral turrets for income, and win by getting **one of your
robots onto the opponent's core pad**. Killing the enemy mech only takes the
defender off the field for a few seconds; it never wins the match.

## Quick start

```bash
npm install
npm run dev        # starts game server (:8080) + client (:5273) concurrently
```

Open **http://localhost:5273 in two browser tabs**, enter a name in each,
create a room in one tab, join it from the other, both click **Ready** — a
3-second countdown starts the match.

### Playing over the LAN

Both dev servers listen on all interfaces, so other machines just browse to
the host's address: `http://<host-ip>:5273` (find the IP with `hostname -I`).
The client automatically connects its WebSocket to port 8080 on whatever host
served the page — no configuration needed. If it doesn't connect, check that
no firewall on the host blocks ports 5273 and 8080; to point the client at a
different game server explicitly, use `http://<host-ip>:5273/?server=<ip>:8080`.

## How to play

The controls are **keyboard-only** — the mouse is not used during a match.
A **CONTROLS** button (top-right) opens an overlay with this list at any time.

| Control | Action |
| --- | --- |
| `W` / `S` | Drive forward / reverse along the facing direction |
| `A` / `D` | Turn left / right — the chase camera always looks where the mech faces |
| `M` | Primary fire — **Gatling** as a walker, **Laser** while hovering. Both share the **heat meter**; overheating locks it for 2 s |
| `N` | **Rockets** — splash damage, 3-rocket magazine, then a reload (**walker only** — disabled in hover) |
| `F` | Transform **Walker ⇄ Hover**. Hover glides faster with low drag, but trades rockets for the laser |
| `1` / `2` | Build **Hovertank** (50¢, 5 s) / **Dreadnought** (200¢, 15 s) |
| ♪ button | Mute / unmute sound (HUD top bar) |
| `F3` | Debug overlay (fps, ping, ticks, snapshot age, entity counts) |

- **Sound:** all audio is synthesised procedurally at runtime (retro 8-bit /
  chiptune — NES-style pulse waves plus a filtered noise channel), so there are
  no asset files. Weapons, explosions, the transform, turret captures, build
  feedback, the base-attack klaxon, the countdown and the victory/defeat
  jingles all have their own sounds.

- **Economy:** +1 credit/s passively, +1 credit/s per owned turret. You start
  with 100 credits. Build queue holds 3; at most 8 of your robots alive at once.
- **Turrets:** stand your mech on a turret's capture pad for 3 uninterrupted
  seconds to flip it (a progress ring shows in-world and on the minimap).
  Stepping off the pad makes progress decay at double speed rather than
  resetting; both mechs on one pad freeze it.
  Owned turrets shoot enemies and pay income. They can be destroyed (respawn
  neutral after 30 s) and re-captured (enemy progress drains to neutral first).
- **Robots** drive themselves: they alternate between the two lanes, engage
  enemies on the way (robots > turrets > mech), and win instantly when one
  reaches the enemy core pad. Defend your own pad!
- Dying respawns you in your base after 4 s with 2 s of spawn protection.

## Repository layout

```
packages/shared   protocol types, balance presets, map layout, and the pure
                  deterministic simulation core (GameSimulation) used by both
                  server and tests — no sockets, no timers, seeded PRNG
packages/server   authoritative Node server: lobby, rooms, configurable tick
                  loop (100 Hz default), snapshot broadcast, /debug/state, bots
packages/client   Three.js client: lobby UI, renderer, interpolation, HUD,
                  minimap, build bar — plain TypeScript + DOM, no framework
e2e               Playwright end-to-end tests (two browser contexts)
```

The server is authoritative: clients only send inputs and build commands;
every message is validated (`parseClientMessage`) and every build command is
re-checked against credits/queue/cap inside the simulation. State snapshots
broadcast every other tick (≈50 Hz at the default 100 Hz tick rate). Remote
entities are interpolated a short, jitter-adaptive delay (~55–140 ms) in the
past; the local player's own mech is client-side predicted (re-derived from the
freshest snapshot each frame) so steering feels immediate.

## Testing

```bash
npm test            # Vitest: headless simulation tests + protocol/server
                    # integration tests over real WebSockets
npm run test:e2e    # Playwright: full lobby→match→victory→rematch flows in
                    # two headless browser contexts (boots server+client itself)
npm run simulate    # fastest smoke test: complete scripted bot-vs-bot match
                    # against the real server, prints event log + outcome
npx playwright install chromium   # one-time browser download for test:e2e
```

The simulation is fully deterministic (same seed + same inputs ⇒ identical
state hash), which is what makes the headless test layers possible.

## Debugging

- `curl http://localhost:8080/debug/state | jq` — live JSON of every room:
  players, tick, phase, entities, economy.
- `F3` in the client — fps, ping, server vs render tick, snapshot age, own
  mech state. All protocol errors are logged to the browser console.
- Server logs are single-line JSON; `LOG_LEVEL=debug npm run dev` adds
  per-tick room diagnostics. Every rejected client message is logged with its
  reason.
- `window.__game` in the browser console — read-only live game state (phase,
  tick, credits, serialized entity list). This is also what Playwright asserts.

### Useful env vars (server)

| Var | Default | Effect |
| --- | --- | --- |
| `PORT` | `8080` | HTTP + WebSocket port |
| `TICK_RATE` | `100` | simulation ticks per second (Hz); scales the balance, sent to clients in `matchStart` |
| `TICK_MS` | `1000/TICK_RATE` | wall-clock ms per tick (pacing only — overrides the rate-derived default) |
| `LOG_LEVEL` | `info` | `debug` enables per-tick diagnostics |
| `BALANCE_PRESET` | per-room | force `default` or `test` balance for all rooms |

The accelerated `test` balance preset (instant-ish builds, fast robots, rich
economy) can also be requested per room by loading the client as
`http://localhost:5273/?test=1`.

## Balance tuning

Every gameplay number — costs, build times, HP, damage, income, capture time,
unit cap — lives in `packages/shared/src/balance.ts`. The map layout (walls,
lanes, turret positions, base zones) is declarative data in
`packages/shared/src/map.ts`; server collision and client rendering are both
generated from it.
