# mycosmetics backend

Tiny HTTP service the mod's client talks to instead of a Minecraft server, so
cosmetics show up for other players regardless of which server you're on.

## Run it locally (for testing)

```bash
cd backend
npm install
npm start
```

This starts it on `http://localhost:8080` (matches the mod's default config).
With no `API_KEY` set it'll warn on startup and accept writes from anyone -
fine for testing on your own machine, not for exposing to the internet.

## Deploy it somewhere real

You need this reachable at a stable URL from every player's machine. Cheapest
options for a hobby project:

- **A small VPS you already have** - copy the `backend` folder over, run
  `npm install --production`, then keep it alive with `pm2 start server.js`
  or a systemd unit. Put it behind a reverse proxy (nginx/caddy) if you want
  HTTPS on a real domain.
- **Render / Railway / Fly.io free tiers** - point them at this folder,
  set the start command to `npm start`, set the `API_KEY` and (if the
  platform doesn't set it for you) `PORT` environment variables.

Either way, once it's up, set `API_KEY` to a long random string and put that
same string in every player's `config/mycosmetics.json` `apiKey` field.

## Config

Environment variables:

- `PORT` - defaults to `8080`.
- `API_KEY` - if set, POST requests must include a matching `X-Api-Key`
  header or they're rejected with 401. Leave unset only for local testing.
- `DATA_FILE` - defaults to `backend/data.json`. A flat JSON file mapping
  UUID -> `{ cape, hat }`. Back this file up like you would any other bit of
  server data you care about.

## Endpoints

- `GET /api/cosmetics/:uuid` -> `{ "cape": "sharingan", "hat": "none" }`
  (defaults to `"none"`/`"none"` for a UUID that's never set anything).
- `POST /api/cosmetics/:uuid` with JSON body `{ "type": "CAPE", "value": "sharingan" }`
  -> `{ "ok": true, ... }`. Requires `X-Api-Key` if `API_KEY` is set.
  `type`/`value` are validated against the same id lists as `CosmeticType`
  on the client - keep the two in sync if you add more cosmetics.

## The honest limitation

This has no way to check that a request claiming to be player X's UUID
actually came from player X - that would need verifying against Mojang's
session servers, which is a lot more plumbing than a hobby cosmetics mod
usually needs. Anyone with your `apiKey` (or, if you leave it unset, anyone
who can reach the server at all) can set any UUID's cosmetics. Fine for a
small friend group; if you ever need it locked down harder, that's the piece
to add.
