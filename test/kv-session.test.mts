// Valida la sesion DI OAuth2 leida de KV a traves de worker.fetch: los metodos de
// protocolo no la necesitan, tools/call la lee en cada llamada y nunca la refresca,
// y una sesion ausente, malformada o caducada sale como isError sin llamar a Garmin.
// fetch esta sustituido por un stub que graba cada llamada: nunca sale a la red.
import "./workers-crypto.mts";
import worker from "../src/index.ts";
import { isDeepStrictEqual } from "node:util";
import { memoryKV, jwt, nowSec, tokensJson, captureLogs, MARK, NEW_RT } from "./fakes.mts";

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
    return new Response(JSON.stringify({ access_token: jwt(nowSec() + 89604), refresh_token: NEW_RT, expires_in: 89604 }), { status: 200 });
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
  check("T1 ping sin sesion: result {}", isDeepStrictEqual(ping.body.result, {}), true);
  check("T1 tools/list sin sesion: HTTP 200", list.status, 200);
  check("T1 tools/list sin sesion: 14 herramientas", list.body.result?.tools?.length, 14);
  check("T1 ni KV ni fetch", events.length, 0);
}

// --- T2 should_send_the_kv_access_token_as_bearer_with_todays_connectapi_headers ---
// Guarda la regla de "cabeceras obligatorias": las de Android del refresco nunca
// deben colarse en connectapi. get_user_settings no pasa por displayName(), asi que
// el recuento no depende de la cache de modulo.
{
  const AT = jwt(nowSec() + 20 * 3600);
  for (const [label, name, args, method, url, body, ctype] of [
    ["(a) get_user_settings", "get_user_settings", {}, "GET",
      "https://connectapi.garmin.com/userprofile-service/userprofile/user-settings", "", null],
    ["(b) schedule_workout", "schedule_workout", { workout_id: "987", date: "2026-03-02" }, "POST",
      "https://connectapi.garmin.com/workout-service/schedule/987", '{"date":"2026-03-02"}', "application/json"],
  ] as [string, string, Record<string, unknown>, string, string, string, string | null][]) {
    events = [];
    calls.length = 0;
    const env = { GARMIN_KV: memoryKV({ tokens: tokensJson(AT) }, { events }), UPSTREAM_TOKEN: "test-upstream" };
    const r = await rpc(env, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
    const c = calls[0];
    check(`T2 ${label}: una sola llamada`, calls.length, 1);
    check(`T2 ${label}: metodo y URL`, `${c?.method} ${c?.url}`, `${method} ${url}`);
    check(`T2 ${label}: cuerpo`, c?.body, body);
    check(`T2 ${label}: Bearer del token de KV`, c?.headers.get("Authorization"), "Bearer " + AT);
    check(`T2 ${label}: User-Agent de hoy`, c?.headers.get("User-Agent"), "GCM-iOS-5.22.1.4");
    check(`T2 ${label}: NK`, c?.headers.get("NK"), "NT");
    check(`T2 ${label}: Accept`, c?.headers.get("Accept"), "application/json");
    check(`T2 ${label}: Content-Type`, c?.headers.get("Content-Type") ?? null, ctype);
    check(`T2 ${label}: sin isError`, r.body.result?.isError, undefined);
    if (name === "get_user_settings") {
      check(`T2 ${label}: devuelve el JSON de Garmin`, r.body.result?.content?.[0]?.text,
        JSON.stringify({ userData: { weight: 70000 } }, null, 2));
    }
  }
}

// --- T3 should_read_kv_on_every_tools_call_and_never_refresh_from_a_request ---
// Guarda contra una cache de token por isolate (seguiria usando A tras una rotacion)
// y contra un refresco "de ayuda" desde una peticion, que la haria segunda escritora.
{
  events = [];
  calls.length = 0;
  const A = jwt(nowSec() + 3600);        // 1 h: dentro de la ventana de 12 h del cron
  const B = jwt(nowSec() + 20 * 3600);
  const kv = memoryKV({ tokens: tokensJson(A) }, { events });
  const env = { GARMIN_KV: kv, UPSTREAM_TOKEN: "test-upstream" };
  const call = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_user_settings", arguments: {} } };
  await rpc(env, call);
  kv.set("tokens", tokensJson(B, { di_refresh_token: NEW_RT }));   // simula una pasada del cron
  await rpc(env, call);
  const api = calls.filter((c) => c.url.startsWith("https://connectapi.garmin.com/"));
  check("T3 primera llamada con Bearer A", api[0]?.headers.get("Authorization"), "Bearer " + A);
  check("T3 segunda llamada con Bearer B", api[1]?.headers.get("Authorization"), "Bearer " + B);
  check("T3 ninguna peticion refresca en diauth", calls.filter((c) => c.url === DIAUTH).length, 0);
  check("T3 ninguna peticion escribe en KV", events.filter((e) => e.startsWith("kv.put")).length, 0);
}

// --- T4 should_return_the_no_session_isError_when_kv_has_no_or_malformed_tokens ---
// Texto exacto: el SyntaxError de JSON.parse cita la entrada, y anadirlo al mensaje
// filtraria el valor guardado al resultado de la herramienta.
const NO_SESSION = "Error: sin sesion de Garmin: ejecuta garmin-mcp-auth y carga el token en KV";
for (const [label, stored] of [
  ["sin clave tokens", undefined],
  ["no es JSON", "no-es-json-SECRETO"],
  ["falta di_refresh_token", tokensJson(jwt(nowSec() + 20 * 3600), { di_refresh_token: undefined })],
  ["di_token sin tres segmentos", tokensJson("SECRETO-sin-puntos")],
  ["di_token sin exp", tokensJson(jwt())],
] as [string, string | undefined][]) {
  events = [];
  calls.length = 0;
  const env = { GARMIN_KV: memoryKV(stored === undefined ? {} : { tokens: stored }, { events }), UPSTREAM_TOKEN: "test-upstream" };
  let r: Awaited<ReturnType<typeof rpc>> | undefined;
  const { lines } = await captureLogs(async () => {
    r = await rpc(env, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_user_settings", arguments: {} } });
  });
  check(`T4 ${label}: HTTP 200`, r?.status, 200);
  check(`T4 ${label}: sin error JSON-RPC`, r ? "error" in r.body : undefined, false);
  check(`T4 ${label}: isError`, r?.body.result?.isError, true);
  check(`T4 ${label}: texto exacto de sin sesion`, r?.body.result?.content?.[0]?.text, NO_SESSION);
  check(`T4 ${label}: 0 llamadas a fetch`, calls.length, 0);
  check(`T4 ${label}: ningun log con un secreto`, lines.some((l) => l.includes(MARK)), false);
}

// --- T5 should_return_the_expired_session_isError_without_calling_garmin ---
// La caducidad sale del claim exp del JWT, nunca de un campo guardado.
{
  events = [];
  calls.length = 0;
  const env = { GARMIN_KV: memoryKV({ tokens: tokensJson(jwt(nowSec() - 3600)) }, { events }), UPSTREAM_TOKEN: "test-upstream" };
  let r: Awaited<ReturnType<typeof rpc>> | undefined;
  const { lines } = await captureLogs(async () => {
    r = await rpc(env, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_user_settings", arguments: {} } });
  });
  check("T5 token caducado: isError", r?.body.result?.isError, true);
  check("T5 token caducado: texto exacto de sesion caducada", r?.body.result?.content?.[0]?.text,
    "Error: sesion de Garmin caducada: el refresco programado esta fallando; revisa los logs o ejecuta garmin-mcp-auth");
  check("T5 token caducado: 0 llamadas a fetch", calls.length, 0);
  check("T5 token caducado: ninguna escritura en KV", events.filter((e) => e.startsWith("kv.put")).length, 0);
  check("T5 token caducado: ningun log con un secreto", lines.some((l) => l.includes(MARK)), false);
}

console.log(fail ? `\n${fail} FALLO(S)` : "\nTodo correcto.");
process.exit(fail ? 1 : 0);
