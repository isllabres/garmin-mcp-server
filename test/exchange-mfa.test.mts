// Valida que el intercambio OAuth1 -> OAuth2 envia mfa_token como garth 0.8.0
// (sso.exchange). Todo pasa por connectapi() con fetch sustituido: nunca sale a la red.
import { connectapi, presetConsumer } from "../src/garmin.ts";

const EXCHANGE_URL = "https://connectapi.garmin.com/oauth-service/oauth/exchange/user/2.0";
const PING_URL = "https://connectapi.garmin.com/test/ping";

let fail = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = got === want;
  console.log(`${ok ? "PASS" : "FALLO"}  ${name}`);
  if (!ok) { console.log(`        obtenido: ${got}\n        esperado: ${want}`); fail++; }
};

// --- 1. con mfa_token, el cuerpo del intercambio lo lleva ---
{
  const captured: { contentType: string; body: string }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    if (req.url === EXCHANGE_URL) {
      captured.push({ contentType: req.headers.get("Content-Type") ?? "", body: await req.text() });
      return new Response(JSON.stringify({ access_token: "test-at", expires_in: 0 }), { status: 200 });
    }
    if (req.url === PING_URL) return new Response(null, { status: 204 });
    throw new Error("fetch inesperado: " + req.url);
  };
  try {
    presetConsumer("test-ck", "test-cs");
    await connectapi({ oauth_token: "tok-123", oauth_token_secret: "sec-456", mfa_token: "mfa-abc123" }, "/test/ping");
  } finally {
    globalThis.fetch = realFetch;
  }
  check("mfa: una sola peticion de intercambio", captured.length, 1);
  check("mfa: body con mfa_token", captured[0]?.body, "mfa_token=mfa-abc123");
  check("mfa: content-type de formulario", captured[0]?.contentType, "application/x-www-form-urlencoded");
}

console.log(fail ? `\n${fail} FALLO(S)` : "\nTodo correcto.");
process.exit(fail ? 1 : 0);
