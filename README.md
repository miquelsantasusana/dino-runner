# Dino Runner — Multiplayer

An endless-runner in the spirit of the classic offline dino game, with online
multiplayer: friends join a room with a 4-letter code, everyone races the
**same seeded obstacle course** side by side, and the last dino standing wins.
Original code and pixel art, no external assets.

## Run locally

```bash
npm install
npm start
# → http://localhost:8642
```

Open the URL in several tabs/machines on the same network to play together.

## How to play

- **Space / ↑** — jump (hold ↓ mid-air to drop faster)
- **↓** — duck (needed for mid-height pterodactyls)
- **Esc** — back to menu (solo mode)

Menu → *Play solo* for the classic single-player game, or *Create room* and
share the code (or the `?room=CODE` link shown in the lobby). The host starts
the race; a 3-2-1 countdown syncs everyone. Crash and you spectate until the
race ends. The host can start a rematch on a fresh course.

## Architecture

- `server.js` — thin Node server (only dependency: `ws`). Serves `public/`
  and manages rooms: lobby membership, the shared course seed, relaying each
  player's state (~15 Hz), death tracking, winner/standings, rematch.
- `public/game.js` — the whole game simulation. Deterministic: a seeded RNG
  drives obstacle spawns and a fixed 120 Hz timestep drives physics, so every
  client with the same seed runs the same course. Remote players are "ghost"
  dinos interpolated from network state; only your own dino is physics-simulated
  and collision-checked locally.
- `public/net.js` — WebSocket client + menu/lobby/game-over screens.

## Deploy (free tier)

The server binds `process.env.PORT`, so any Node host works.

**Render** (config included): push this folder to a GitHub repo, then on
[render.com](https://render.com) choose *New → Blueprint* and point it at the
repo — `render.yaml` does the rest. Note: free instances sleep after idle;
the first visit takes ~30 s to wake.

**Railway / Fly.io**: create a Node service from the repo; start command
`npm start`. Nothing else to configure.

**Instant tunnel (no account, for a quick session with friends):**
```bash
brew install cloudflared
cloudflared tunnel --url http://localhost:8642
```
Share the printed `https://….trycloudflare.com` URL — WebSockets included.
