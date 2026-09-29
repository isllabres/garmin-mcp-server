// Valida que el intercambio OAuth1 -> OAuth2 envia mfa_token como garth 0.8.0
// (sso.exchange). Todo pasa por connectapi() con fetch sustituido: nunca sale a la red.
import { connectapi, presetConsumer, pct, hmacSha1, type OAuth1Token } from "../src/garmin.ts";

const EXCHANGE_URL = "https://connectapi.garmin.com/oauth-service/oauth/exchange/user/2.0";
const PING_URL = "https://connectapi.garmin.com/test/ping";
const OAUTH_KEYS = ["oauth_consumer_key", "oauth_nonce", "oauth_signature",
  "oauth_signature_method", "oauth_timestamp", "oauth_token", "oauth_version"];

interface Captured { url: string; authorization: string; contentType: string; body: string }

// Parametros de la cabecera Authorization: OAuth k="v", k="v", ...
const headerParams = (authorization: string) => Object.fromEntries(
  authorization.replace(/^OAuth /, "").split(", ").map((kv) => {
    const i = kv.indexOf("=");
    return [decodeURIComponent(kv.slice(0, i)), decodeURIComponent(kv.slice(i + 2, -1))];
  }),
);

// Verifica la firma como lo haria el servidor (RFC 5849 3.4.1): parametros de
// la cabecera (sin oauth_signature ni realm) mas los del cuerpo de formulario.
async function verifyOAuth1(req: Captured, cs: string, ts: string): Promise<boolean> {
  const header = headerParams(req.authorization);
  const pairs = Object.entries(header).filter(([k]) => k !== "oauth_signature" && k !== "realm");
  for (const [k, v] of new URLSearchParams(req.body)) pairs.push([k, v]);
  const normalized = pairs.map(([k, v]) => [pct(k), pct(v)])
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`).join("&");
  const base = `POST&${pct(req.url)}&${pct(normalized)}`;
  return (await hmacSha1(`${pct(cs)}&${pct(ts)}`, base)) === header.oauth_signature;
}

let fail = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = got === want;
  console.log(`${ok ? "PASS" : "FALLO"}  ${name}`);
  if (!ok) { console.log(`        obtenido: ${got}\n        esperado: ${want}`); fail++; }
};

// Ejecuta connectapi() con fetch sustituido y devuelve las peticiones de
// intercambio capturadas. expires_in 0 hace que cada llamada vuelva a intercambiar,
// asi los casos no dependen del orden ni de la cache de tokens.
async function captureExchange(oauth1: OAuth1Token): Promise<Captured[]> {
  const captured: Captured[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    if (req.url === EXCHANGE_URL) {
      captured.push({
        url: req.url,
        authorization: req.headers.get("Authorization") ?? "",
        contentType: req.headers.get("Content-Type") ?? "",
        body: await req.text(),
      });
      return new Response(JSON.stringify({ access_token: "test-at", expires_in: 0 }), { status: 200 });
    }
    if (req.url === PING_URL) return new Response(null, { status: 204 });
    throw new Error("fetch inesperado: " + req.url);
  };
  try {
    presetConsumer("test-ck", "test-cs");
    await connectapi(oauth1, "/test/ping");
  } finally {
    globalThis.fetch = realFetch;
  }
  return captured;
}

const headerKeys = (req: Captured) => JSON.stringify(Object.keys(headerParams(req.authorization)).sort());
const MFA = { oauth_token: "tok-123", oauth_token_secret: "sec-456", mfa_token: "mfa-abc123" };

// --- 1. con mfa_token, el cuerpo del intercambio lo lleva ---
{
  const captured = await captureExchange(MFA);
  check("mfa: una sola peticion de intercambio", captured.length, 1);
  check("mfa: body con mfa_token", captured[0]?.body, "mfa_token=mfa-abc123");
  check("mfa: content-type de formulario", captured[0]?.contentType, "application/x-www-form-urlencoded");
}

// --- 2. mfa_token entra en la firma y no en la cabecera ---
{
  const [req] = await captureExchange(MFA);
  check("mfa: cabecera solo con parametros oauth_*", headerKeys(req), JSON.stringify(OAUTH_KEYS));
  check("mfa: firma valida incluyendo mfa_token", await verifyOAuth1(req, "test-cs", "sec-456"), true);
}

console.log(fail ? `\n${fail} FALLO(S)` : "\nTodo correcto.");
process.exit(fail ? 1 : 0);
