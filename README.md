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

1. Generates a per-install fingerprint, persisted to `~/.mimo-proxy/client-fingerprint`.
2. Exchanges it for a short-lived JWT via `POST /api/free-ai/bootstrap`.
3. Forwards chat requests to `/api/free-ai/openai/chat` with that JWT, refreshing it ~5 min before expiry or on 401/403.

## Environment variables

- `PORT` - listen port (default `3000`)
- `PROXY_API_KEY` - if set, callers must send `Authorization: Bearer <PROXY_API_KEY>`
- `MIMO_BASE_URL` - override the upstream base URL (default `https://api.xiaomimimo.com`)
