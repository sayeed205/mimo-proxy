const MIMO_BASE_URL =
  (Deno.env.get("MIMO_BASE_URL") || "https://api.xiaomimimo.com").replace(
    /\/+$/,
    "",
  );
const BOOTSTRAP_URL = `${MIMO_BASE_URL}/api/free-ai/bootstrap`;
const CHAT_URL = `${MIMO_BASE_URL}/api/free-ai/openai/chat`;
const TRACKING_URL = "https://tracking.miui.com/track/v4/o";
const USER_AGENT =
  "mimocode/0.1.0 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14";
const DEFAULT_PORT = 3000;

// Optional: require `Authorization: Bearer <PROXY_API_KEY>` from callers.
// Leave unset for unrestricted local use.
const PROXY_API_KEY = Deno.env.get("PROXY_API_KEY");

const DATA_DIR = `${Deno.env.get("HOME") ?? "."}/.mimo-proxy`;
const FINGERPRINT_FILE = `${DATA_DIR}/client-fingerprint`; // legacy single-fp file (migrated)
const POOL_FILE = `${DATA_DIR}/fingerprints.json`;

// On 429 the proxy rotates to a different anonymous fingerprint to get a fresh
// free-tier budget. Only helps if MiMo keys the limit on the fingerprint/identity
// rather than the egress IP. Tunables:
const MAX_FINGERPRINTS = Number(Deno.env.get("MAX_FINGERPRINTS") ?? 8);
const FP_COOLDOWN_MS = Number(Deno.env.get("FP_COOLDOWN_MS") ?? 60 * 60_000); // assumed window reset
const MAX_429_RETRIES = Number(Deno.env.get("MAX_429_RETRIES") ?? 3);

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  [key: string]: unknown;
}

interface ChatCompletionRequest {
  model?: string;
  messages: ChatMessage[];
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  [key: string]: unknown;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

function jsonError(status: number, message: string, type: string): Response {
  return new Response(JSON.stringify({ error: { message, type } }), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function base64UrlDecode(input: string): string {
  let base64 = input.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4) base64 += "=";
  return atob(base64);
}

// MiMo's free-tier bootstrap binds the issued JWT to a per-install
// fingerprint. We keep a pool of fingerprints persisted to disk and rotate
// between them on 429 so each one carries its own free-tier budget. A
// rate-limited fingerprint is parked with a cooldown and reused once it
// (presumably) resets.
interface Fingerprint {
  fp: string;
  cooldownUntil: number; // epoch ms; <= now means available
}

let pool: Fingerprint[] | null = null;
let activeIdx = 0;

async function generateFingerprint(): Promise<string> {
  const seed = [Deno.build.os, Deno.build.arch, crypto.randomUUID()].join("|");
  return await sha256Hex(seed);
}

async function savePool(): Promise<void> {
  try {
    await Deno.mkdir(DATA_DIR, { recursive: true });
    await Deno.writeTextFile(POOL_FILE, JSON.stringify(pool));
  } catch {}
}

async function loadPool(): Promise<Fingerprint[]> {
  if (pool) return pool;
  // Existing pool file wins.
  try {
    const parsed = JSON.parse(await Deno.readTextFile(POOL_FILE));
    if (Array.isArray(parsed) && parsed.length) {
      pool = parsed as Fingerprint[];
      return pool;
    }
  } catch {}
  // Migrate the legacy single-fingerprint file if present.
  let seedFp: string | undefined;
  try {
    const legacy = (await Deno.readTextFile(FINGERPRINT_FILE)).trim();
    if (legacy) seedFp = legacy;
  } catch {}
  seedFp ??= await generateFingerprint();
  pool = [{ fp: seedFp, cooldownUntil: 0 }];
  await savePool();
  return pool;
}

async function getClientFingerprint(): Promise<string> {
  const p = await loadPool();
  return p[activeIdx]?.fp ?? p[0].fp;
}

// Park the current fingerprint with a cooldown and switch to the best
// alternative: the available one with the lowest cooldown, a freshly minted
// one if the pool has room, else the entry that frees up soonest.
async function rotateFingerprint(): Promise<string> {
  const p = await loadPool();
  const now = Date.now();
  if (p[activeIdx]) p[activeIdx].cooldownUntil = now + FP_COOLDOWN_MS;

  let pick = p.findIndex((f, i) => i !== activeIdx && f.cooldownUntil <= now);
  if (pick === -1 && p.length < MAX_FINGERPRINTS) {
    p.push({ fp: await generateFingerprint(), cooldownUntil: 0 });
    pick = p.length - 1;
  }
  if (pick === -1) {
    // All cooling down — take the one that recovers soonest.
    pick = p.reduce(
      (best, f, i) => (f.cooldownUntil < p[best].cooldownUntil ? i : best),
      0,
    );
  }
  activeIdx = pick;
  await savePool();
  return p[activeIdx].fp;
}

interface JwtState {
  jwt: string;
  exp: number;
}

let jwtCache: JwtState | null = null;
let bootstrapInflight: Promise<JwtState> | null = null;

function parseJwtExpiry(jwt: string): number {
  try {
    const payload = JSON.parse(base64UrlDecode(jwt.split(".")[1] ?? ""));
    if (typeof payload.exp === "number") return payload.exp * 1000;
  } catch {}
  return Date.now() + 50 * 60_000;
}

async function bootstrap(): Promise<JwtState> {
  const client = await getClientFingerprint();
  const res = await fetch(BOOTSTRAP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "mimocode/0.1.0",
    },
    body: JSON.stringify({ client }),
  });
  if (!res.ok) {
    throw new Error(`bootstrap failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { jwt?: string };
  if (!data.jwt) throw new Error("bootstrap response missing jwt");
  return { jwt: data.jwt, exp: parseJwtExpiry(data.jwt) };
}

const JWT_REFRESH_BUFFER_MS = 5 * 60_000;

async function getJwt(forceRefresh = false): Promise<string> {
  if (
    !forceRefresh && jwtCache &&
    jwtCache.exp - Date.now() > JWT_REFRESH_BUFFER_MS
  ) {
    return jwtCache.jwt;
  }
  if (bootstrapInflight) return (await bootstrapInflight).jwt;
  jwtCache = null;
  bootstrapInflight = bootstrap();
  try {
    jwtCache = await bootstrapInflight;
    return jwtCache.jwt;
  } finally {
    bootstrapInflight = null;
  }
}

// Rotate to a different fingerprint and force a fresh JWT under that identity.
async function rotateAndRefreshJwt(): Promise<string> {
  await rotateFingerprint();
  jwtCache = null;
  bootstrapInflight = null;
  return await getJwt(true);
}

// Derive a stable session id from the system + first user message so that
// repeated turns of the same conversation reuse MiMo's server-side prompt
// cache (visible as cached_read_tokens in their tracking payloads).
async function deriveSessionId(
  req: Request,
  messages: ChatMessage[],
): Promise<string> {
  const provided = req.headers.get("x-session-affinity");
  if (provided) return provided;
  const seed = JSON.stringify(messages.slice(0, 2));
  return "ses_" + (await sha256Hex(seed)).slice(0, 24);
}

// MiMo's free-tier chat endpoint rejects (403 illegal_access) any request
// whose first message isn't a system message containing this MiMoCode
// identity string - it's how they scope the free tier to their own CLI.
// Prepend it so requests from other agent apps still pass the check while
// keeping the caller's own system prompt intact.
const MIMOCODE_SYSTEM_PROMPT =
  "You are MiMoCode, an interactive CLI tool that helps users with software engineering tasks.";

function ensureMimoSystemPrompt(messages: ChatMessage[]): ChatMessage[] {
  const first = messages[0];
  if (
    first?.role === "system" && typeof first.content === "string" &&
    first.content.includes("MiMoCode")
  ) {
    return messages;
  }
  return [{ role: "system", content: MIMOCODE_SYSTEM_PROMPT }, ...messages];
}

function callMimo(
  jwt: string,
  mimoBody: unknown,
  sessionId: string,
): Promise<Response> {
  return fetch(CHAT_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`,
      "User-Agent": USER_AGENT,
      "X-Mimo-Source": "mimocode-cli-free",
      "x-session-affinity": sessionId,
    },
    body: JSON.stringify(mimoBody),
  });
}

function sendTrackingEvent(
  sessionId: string,
  model: string,
  messages: ChatMessage[],
): void {
  const trackingBody = [
    {
      H: {
        event: "model_call",
        app_id: "31000402765",
        instance_id: crypto.randomUUID(),
        instance_id_type: "uuid",
        e_ts: Date.now(),
        uid: sessionId,
        uid_type: "session_id",
      },
      B: {
        finish_reason: "stop",
        ttft_ms: 0,
        latency_ms: Date.now(),
        cached_read_tokens: 0,
        model_id: model,
        provider: "mimo",
        total_tokens_in: messages.reduce(
          (acc, m) =>
            acc + (typeof m.content === "string" ? m.content.length : 0),
          0,
        ),
        total_tokens_out: 0,
      },
    },
  ];

  fetch(TRACKING_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "mimocode/0.1.0",
    },
    body: JSON.stringify(trackingBody),
  }).catch(() => {});
}

async function handleChatCompletion(req: Request): Promise<Response> {
  if (PROXY_API_KEY) {
    const authHeader = req.headers.get("authorization") || "";
    if (authHeader !== `Bearer ${PROXY_API_KEY}`) {
      return jsonError(401, "Invalid proxy API key", "auth_error");
    }
  }

  let body: ChatCompletionRequest;
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "Invalid JSON body", "invalid_request_error");
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return jsonError(
      400,
      "messages is required and must be non-empty",
      "invalid_request_error",
    );
  }

  const sessionId = await deriveSessionId(req, body.messages);
  const {
    model: _model,
    max_tokens,
    temperature,
    stream,
    stream_options,
    ...rest
  } = body;

  const mimoBody = {
    ...rest,
    model: "mimo-auto",
    max_tokens: max_tokens || 128000,
    temperature: temperature ?? 0.5,
    messages: ensureMimoSystemPrompt(body.messages),
    stream: stream !== false,
    stream_options: stream_options || { include_usage: true },
  };

  let jwt = await getJwt();
  let mimoRes = await callMimo(jwt, mimoBody, sessionId);

  if (mimoRes.status === 401 || mimoRes.status === 403) {
    jwt = await getJwt(true);
    mimoRes = await callMimo(jwt, mimoBody, sessionId);
  }

  // Rate limited: park this fingerprint, rotate to a fresh identity, retry.
  for (let attempt = 0; mimoRes.status === 429 && attempt < MAX_429_RETRIES; attempt++) {
    await mimoRes.body?.cancel();
    console.warn(`429 from upstream, rotating fingerprint (attempt ${attempt + 1}/${MAX_429_RETRIES})`);
    jwt = await rotateAndRefreshJwt();
    mimoRes = await callMimo(jwt, mimoBody, sessionId);
  }

  if (!mimoRes.ok) {
    const errorText = await mimoRes.text();
    return new Response(errorText, {
      status: mimoRes.status,
      headers: {
        "Content-Type": mimoRes.headers.get("content-type") ||
          "application/json",
        ...CORS_HEADERS,
      },
    });
  }

  if (!mimoBody.stream) {
    const fullText = await mimoRes.text();
    return new Response(fullText, {
      status: 200,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }

  sendTrackingEvent(sessionId, mimoBody.model, body.messages);

  return new Response(mimoRes.body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...CORS_HEADERS,
    },
  });
}

function handleModels(): Response {
  return new Response(
    JSON.stringify({
      object: "list",
      data: [
        {
          id: "mimo-auto",
          object: "model",
          created: Date.now(),
          owned_by: "xiaomi",
          permission: [],
          root: "mimo-auto",
          parent: null,
        },
      ],
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    },
  );
}

function handleHealth(): Response {
  return new Response(JSON.stringify({ status: "ok", service: "mimo-proxy" }), {
    status: 200,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

const port = parseInt(Deno.env.get("PORT") || String(DEFAULT_PORT));

Deno.serve(
  {
    port,
    onListen: ({ port }) => {
      console.log(`MiMo Proxy running on http://localhost:${port}`);
      console.log(
        `  POST /v1/chat/completions  - OpenAI-compatible chat endpoint`,
      );
      console.log(`  GET  /v1/models            - List available models`);
      console.log(`  GET  /health               - Health check`);
    },
  },
  async (req) => {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (
      req.method === "GET" &&
      (url.pathname === "/health" || url.pathname === "/")
    ) {
      return handleHealth();
    }

    if (req.method === "GET" && url.pathname === "/v1/models") {
      return handleModels();
    }

    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      return handleChatCompletion(req);
    }

    return jsonError(404, "Not found", "invalid_request_error");
  },
);
