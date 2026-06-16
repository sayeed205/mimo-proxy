# mimo-proxy

OpenAI-compatible proxy for Xiaomi MiMo Code's free `mimo-auto` model. Handles
the anonymous bootstrap/JWT auth that the [MiMo Code](https://github.com/XiaomiMiMo/MiMo-Code)
CLI does internally, so any OpenAI-compatible agent/tool can use it without
needing a MiMo account.

## Run

Locally:

```bash
deno run -A index.ts
```

Directly from GitHub (no clone needed):

```bash
deno run -A https://raw.githubusercontent.com/sayeed205/mimo-proxy/main/index.ts
```

`-A` grants all permissions. For a tighter set:

```bash
deno run --allow-net --allow-env --allow-read --allow-write index.ts
```

## Endpoints

- `POST /v1/chat/completions` - OpenAI-compatible chat endpoint (streaming and non-streaming)
- `GET /v1/models` - lists `mimo-auto`
- `GET /health` - health check

Point any OpenAI-compatible client at `http://localhost:3000/v1` with model
`mimo-auto`. The `Authorization` header can be anything (most tools require
one to be set) unless `PROXY_API_KEY` is configured.

## How it works

1. Keeps a pool of anonymous fingerprints, persisted to `~/.mimo-proxy/fingerprints.json` (migrates the legacy `client-fingerprint` file).
2. Exchanges the active fingerprint for a short-lived JWT via `POST /api/free-ai/bootstrap`.
3. Forwards chat requests to `/api/free-ai/openai/chat` with that JWT, refreshing it ~5 min before expiry or on 401/403.
4. On `429` (rate limit) parks the current fingerprint with a cooldown, rotates to another fingerprint (minting a fresh one if the pool has room), re-bootstraps, and retries — up to `MAX_429_RETRIES` times.

> Rotation only resets the limit if MiMo keys the free tier on the fingerprint/identity. If it's keyed on your egress IP, you'll need a rotating egress (proxy pool) instead. Quick test: on a 429, `rm ~/.mimo-proxy/fingerprints.json`, restart — if it works again, rotation will help.

## Environment variables

- `PORT` - listen port (default `3000`)
- `PROXY_API_KEY` - if set, callers must send `Authorization: Bearer <PROXY_API_KEY>`
- `MIMO_BASE_URL` - override the upstream base URL (default `https://api.xiaomimimo.com`)
- `MAX_FINGERPRINTS` - max fingerprints kept in the rotation pool (default `8`)
- `FP_COOLDOWN_MS` - how long a rate-limited fingerprint is parked before reuse (default `3600000`, 1h)
- `MAX_429_RETRIES` - rotation+retry attempts per request on `429` (default `3`)
