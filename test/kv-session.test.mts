// Valida la sesion DI OAuth2 leida de KV a traves de worker.fetch: los metodos de
// protocolo no la necesitan, tools/call la lee en cada llamada y nunca la refresca,
// y una sesion ausente, malformada o caducada sale como isError sin llamar a Garmin.
// fetch esta sustituido por un stub que graba cada llamada: nunca sale a la red.
import "./workers-crypto.mts";
import worker from "../src/index.ts";
import { memoryKV } from "./fakes.mts";

let fail = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = got === want;
  console.log(`${ok ? "PASS" : "FALLO"}  ${name}`);
  if (!ok) { console.log(`        obtenido: ${got}\n        esperado: ${want}`); fail++; }
};

// Stub de fetch: graba {method, url, headers, body} y deja "fetch <METODO> <url>"
// en events. diauth contesta un refresco valido a proposito: si una peticion
// refrescara, funcionaria en silencio y solo el recuento de T3 lo delataria.
const DIAUTH = "https://diauth.garmin.com/di-oauth2-service/oauth/token";
let events: string[] = [];
const calls: { method: string; url: string; headers: Headers; body: string }[] = [];
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const req = new Request(input, init);
  calls.push({ method: req.method, url: req.url, headers: req.headers, body: await req.text() });
  events.push(`fetch ${req.method} ${req.url}`);
  if (req.url.endsWith("/userprofile-service/socialProfile")) {
    return new Response(JSON.stringify({ displayName: "atleta" }), { status: 200 });
  }
  if (req.url.startsWith("https://connectapi.garmin.com/")) {
    return new Response(JSON.stringify({ userData: { weight: 70000 } }), { status: 200 });
  }
  if (req.url === DIAUTH) {
    return new Response(JSON.stringify({ access_token: "a.b.c", refresh_token: "r", expires_in: 89604 }), { status: 200 });
  }
  throw new Error("fetch inesperado: " + req.url);
};

const rpc = async (env: unknown, body: unknown) => {
  const res = await worker.fetch(new Request("https://worker.test/", {
    method: "POST",
    headers: { Authorization: "Bearer test-upstream", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }), env as never);
  return { status: res.status, body: await res.json() as { error?: unknown; result?: any } };
};

// --- T1 should_answer_initialize_ping_and_tools_list_without_reading_kv ---
// Antes, sin GARMIN_OAUTH1 todo era HTTP 500 / -32603. Un get que lanza, junto con
// events vacio, pilla una lectura de KV adelantada que se trague el fallo.
{
  events = [];
  calls.length = 0;
  const env = {
    GARMIN_KV: memoryKV({}, { events, failGet: new Error("KV prohibido") }),
    UPSTREAM_TOKEN: "test-upstream",
  };
  const init = await rpc(env, { jsonrpc: "2.0", id: 1, method: "initialize" });
  const ping = await rpc(env, { jsonrpc: "2.0", id: 2, method: "ping" });
  const list = await rpc(env, { jsonrpc: "2.0", id: 3, method: "tools/list" });
  check("T1 initialize sin sesion: HTTP 200", init.status, 200);
  check("T1 initialize sin sesion: sin error", "error" in init.body, false);
  check("T1 initialize sin sesion: protocolVersion", init.body.result?.protocolVersion, "2025-06-18");
  check("T1 ping sin sesion: HTTP 200", ping.status, 200);
  check("T1 ping sin sesion: result {}", JSON.stringify(ping.body.result), "{}");
  check("T1 tools/list sin sesion: HTTP 200", list.status, 200);
  check("T1 tools/list sin sesion: 14 herramientas", list.body.result?.tools?.length, 14);
  check("T1 ni KV ni fetch", events.length, 0);
}

console.log(fail ? `\n${fail} FALLO(S)` : "\nTodo correcto.");
process.exit(fail ? 1 : 0);
