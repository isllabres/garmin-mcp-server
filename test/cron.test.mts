// Valida el refresco programado de la sesion DI OAuth2 (worker.scheduled): la
// peticion exacta a diauth, que el token rotado se guarda en KV antes de nada, el
// umbral de 12 h, y que ningun fallo toca KV ni escribe un token en los logs.
// Solo se llama a worker.scheduled; fetch esta sustituido por un stub que graba
// cada llamada y lanza ante cualquier URL que no sea diauth.
import { format } from "node:util";
import worker from "../src/index.ts";
import { memoryKV, jwt, nowSec, tokensJson, captureLogs, CLIENT, OLD_RT, NEW_RT, MARK } from "./fakes.mts";

let fail = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = got === want;
  console.log(`${ok ? "PASS" : "FALLO"}  ${name}`);
  if (!ok) { console.log(`        obtenido: ${got}\n        esperado: ${want}`); fail++; }
};

const DIAUTH = "https://diauth.garmin.com/di-oauth2-service/oauth/token";
let events: string[] = [];
const calls: { method: string; url: string; headers: Headers; body: string }[] = [];
// Lo que contesta diauth en el test en curso: una Response nueva por llamada, o un error que lanzar.
let diauth: () => Response = () => { throw new Error("diauth sin configurar"); };
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const req = new Request(input, init);
  calls.push({ method: req.method, url: req.url, headers: req.headers, body: await req.text() });
  events.push(`fetch ${req.method} ${req.url}`);
  // Contesta en otra vuelta del bucle: si scheduled no esperase su trabajo, el
  // kv.put aun no habria ocurrido al acabar el Act y T8 lo delataria.
  if (req.url === DIAUTH) { await new Promise((r) => setTimeout(r, 0)); return diauth(); }
  throw new Error("fetch inesperado: " + req.url);
};
const ok200 = (body: unknown) => () => new Response(JSON.stringify(body), { status: 200 });

// Ejecuta el cron como lo haria Workers y espera tambien lo que pase por ctx.waitUntil.
// Devuelve ademas los motivos de rechazo de waitUntil: Workers los escribe en sus
// logs, igual que un error que salga de scheduled (threw).
async function runCron(kv: ReturnType<typeof memoryKV>) {
  const pending: Promise<unknown>[] = [];
  const rejections: unknown[] = [];
  const controller = { scheduledTime: Date.now(), cron: "0 */6 * * *", noRetry() {} };
  const ctx = { waitUntil(p: Promise<unknown>) { pending.push(p); }, passThroughOnException() {} };
  const env = { GARMIN_KV: kv, UPSTREAM_TOKEN: "test-upstream" };
  const out = await captureLogs(async () => {
    try {
      await (worker as any).scheduled(controller, env, ctx);
    } finally {
      for (const r of await Promise.allSettled(pending)) if (r.status === "rejected") rejections.push(r.reason);
    }
  });
  return { ...out, rejections };
}
const reset = () => { events = []; calls.length = 0; };

// --- T7 should_post_the_refresh_grant_to_diauth_with_basic_auth_and_the_native_android_headers ---
// La peticion exacta del spike del 2026-10-05: no cambiar estos valores de memoria.
// La segunda fila delata un client_id fijo; +/= en OLD_RT, un cuerpo sin codificar.
const NATIVE: [string, string][] = [
  ["User-Agent", "GCM-Android-5.23"],
  ["X-Garmin-User-Agent", "com.garmin.android.apps.connectmobile/5.23; ; Google/sdk_gphone64_arm64/google; Android/33; Dalvik/2.1.0"],
  ["X-Garmin-Paired-App-Version", "10861"],
  ["X-Garmin-Client-Platform", "Android"],
  ["X-App-Ver", "10861"],
  ["X-Lang", "en"],
  ["X-GCExperience", "GC5"],
  ["Accept-Language", "en-US,en;q=0.9"],
];
for (const [id, basic] of [
  [CLIENT, "Basic R0FSTUlOX0NPTk5FQ1RfTU9CSUxFX0FORFJPSURfRElfMjAyNVEyOg=="],
  ["CLIENTE_PRUEBA", "Basic Q0xJRU5URV9QUlVFQkE6"],
]) {
  reset();
  diauth = ok200({ access_token: jwt(nowSec() + 89604), refresh_token: NEW_RT, expires_in: 89604, refresh_token_expires_in: 2591999 });
  const kv = memoryKV({ tokens: tokensJson(jwt(nowSec() + 11 * 3600), { di_client_id: id }) }, { events });
  await runCron(kv);
  const c = calls[0];
  const form = new URLSearchParams(c?.body ?? "");
  check(`T7 ${id}: una sola llamada`, calls.length, 1);
  check(`T7 ${id}: POST a diauth`, `${c?.method} ${c?.url}`, `POST ${DIAUTH}`);
  check(`T7 ${id}: Content-Type exacto`, c?.headers.get("Content-Type"), "application/x-www-form-urlencoded");
  check(`T7 ${id}: formulario de 3 campos`, [...form.keys()].length, 3);
  check(`T7 ${id}: grant_type`, form.get("grant_type"), "refresh_token");
  check(`T7 ${id}: client_id`, form.get("client_id"), id);
  check(`T7 ${id}: refresh_token intacto tras decodificar`, form.get("refresh_token"), OLD_RT);
  check(`T7 ${id}: Basic con el client_id`, c?.headers.get("Authorization"), basic);
  check(`T7 ${id}: Accept`, c?.headers.get("Accept"), "application/json");
  check(`T7 ${id}: Cache-Control`, c?.headers.get("Cache-Control"), "no-cache");
  for (const [h, v] of NATIVE) check(`T7 ${id}: ${h}`, c?.headers.get(h), v);
}

// --- T8 should_store_the_rotated_tokens_in_kv_immediately_after_a_successful_refresh ---
// El refresh token rotado solo existe en esa respuesta: perderlo acaba con la sesion.
// Sin campos extra, para que un garmin_tokens.json recien hecho y lo que escribe el
// cron sean intercambiables.
{
  reset();
  const NEW_AT = jwt(nowSec() + 89604);
  diauth = ok200({ access_token: NEW_AT, refresh_token: NEW_RT, expires_in: 89604, refresh_token_expires_in: 2591999 });
  const kv = memoryKV({ tokens: tokensJson(jwt(nowSec() + 11 * 3600)) }, { events });
  await runCron(kv);
  const stored = JSON.parse(kv.raw("tokens") ?? "{}");
  check("T8 guarda exactamente los tres campos", JSON.stringify(Object.keys(stored).sort()), '["di_client_id","di_refresh_token","di_token"]');
  check("T8 di_token nuevo", stored.di_token, NEW_AT);
  check("T8 di_refresh_token rotado", stored.di_refresh_token, NEW_RT);
  check("T8 mismo di_client_id", stored.di_client_id, CLIENT);
  check("T8 un solo kv.put", events.filter((e) => e.startsWith("kv.put")).length, 1);
  const i = events.indexOf(`fetch POST ${DIAUTH}`);
  check("T8 lo siguiente tras el refresco es el kv.put", events[i + 1], "kv.put tokens");
  check("T8 una sola llamada de red", events.filter((e) => e.startsWith("fetch ")).length, 1);
}

// --- T9 should_keep_the_stored_refresh_token_when_the_response_does_not_rotate_it ---
// JSON.stringify quita undefined: una escritura ingenua perderia di_refresh_token, la
// siguiente pasada veria una sesion malformada y la sesion moriria sin ningun error.
for (const [label, extra] of [
  ["(a) sin refresh_token", {}],
  ["(b) refresh_token null", { refresh_token: null }],
  ["(c) refresh_token vacio", { refresh_token: "" }],
] as [string, Record<string, unknown>][]) {
  reset();
  const NEW_AT = jwt(nowSec() + 89604);
  diauth = ok200({ access_token: NEW_AT, expires_in: 89604, ...extra });
  const kv = memoryKV({ tokens: tokensJson(jwt(nowSec() + 11 * 3600)) }, { events });
  await runCron(kv);
  const stored = JSON.parse(kv.raw("tokens") ?? "{}");
  check(`T9 ${label}: di_token nuevo`, stored.di_token, NEW_AT);
  check(`T9 ${label}: conserva el refresh token guardado`, stored.di_refresh_token, OLD_RT);
  check(`T9 ${label}: mismo di_client_id`, stored.di_client_id, CLIENT);
  check(`T9 ${label}: exactamente los tres campos`, JSON.stringify(Object.keys(stored).sort()), '["di_client_id","di_refresh_token","di_token"]');
}

// --- T10 should_refresh_only_when_the_access_token_has_less_than_12_hours_left ---
// Margenes de 1 h a cada lado de 12 h: el resultado no depende de si el reloj es
// Date.now() o controller.scheduledTime. La fila caducada es la recuperacion tras
// pasadas fallidas: las peticiones no refrescan (T3), asi que debe hacerlo el cron.
for (const [label, exp, refreshes] of [
  ["13 h", nowSec() + 13 * 3600, false],
  ["11 h", nowSec() + 11 * 3600, true],
  ["caducado hace 1 h", nowSec() - 3600, true],
] as [string, number, boolean][]) {
  reset();
  const NEW_AT = jwt(nowSec() + 89604);
  diauth = ok200({ access_token: NEW_AT, refresh_token: NEW_RT, expires_in: 89604 });
  const before = tokensJson(jwt(exp));
  const kv = memoryKV({ tokens: before }, { events });
  await runCron(kv);
  const fetches = calls.filter((c) => c.url === DIAUTH).length;
  if (refreshes) {
    check(`T10 ${label}: refresca una vez`, fetches, 1);
    check(`T10 ${label}: guarda el di_token nuevo`, JSON.parse(kv.raw("tokens") ?? "{}").di_token, NEW_AT);
  } else {
    check(`T10 ${label}: ninguna llamada de red`, calls.length, 0);
    check(`T10 ${label}: no escribe en KV`, events.filter((e) => e.startsWith("kv.put")).length, 0);
    check(`T10 ${label}: KV sin cambios`, kv.raw("tokens"), before);
  }
}

// --- T11 should_make_no_network_call_when_kv_has_no_or_malformed_tokens ---
// Las filas 3 y 4 caen dentro de la ventana de 12 h: solo la validez las para.
for (const [label, stored] of [
  ["sin clave tokens", undefined],
  ["no es JSON", "no-es-json-SECRETO"],
  ["falta di_refresh_token", tokensJson(jwt(nowSec() + 3600), { di_refresh_token: undefined })],
  ["di_client_id vacio", tokensJson(jwt(nowSec() + 3600), { di_client_id: "" })],
] as [string, string | undefined][]) {
  reset();
  diauth = ok200({ access_token: jwt(nowSec() + 89604), refresh_token: NEW_RT });
  const kv = memoryKV(stored === undefined ? {} : { tokens: stored }, { events });
  await runCron(kv);
  check(`T11 ${label}: 0 llamadas de red`, calls.length, 0);
  check(`T11 ${label}: no escribe en KV`, events.filter((e) => e.startsWith("kv.put")).length, 0);
  check(`T11 ${label}: KV sin cambios`, kv.raw("tokens"), stored ?? null);
}

// --- T12 should_leave_kv_untouched_and_ask_for_a_relogin_when_diauth_rejects_the_refresh_token ---
// 400/401 es definitivo: no se toca KV y el log dice que hay que volver a entrar.
for (const [label, status, body] of [
  ["(a) 400 invalid_grant", 400, '{"error":"invalid_grant"}'],
  ["(b) 401 vacio", 401, ""],
] as [string, number, string][]) {
  reset();
  diauth = () => new Response(body, { status });
  const before = tokensJson(jwt(nowSec() + 11 * 3600));
  const kv = memoryKV({ tokens: before }, { events });
  const { lines } = await runCron(kv);
  check(`T12 ${label}: no escribe en KV`, events.filter((e) => e.startsWith("kv.put")).length, 0);
  check(`T12 ${label}: KV sin cambios`, kv.raw("tokens"), before);
  check(`T12 ${label}: log de refresco rechazado`, lines.some((l) => l.includes("refresco rechazado: ejecuta garmin-mcp-auth")), true);
  check(`T12 ${label}: el log lleva el estado`, lines.join("\n").includes(String(status)), true);
}

// --- T13 should_leave_kv_untouched_when_the_refresh_fails_transiently_or_returns_an_unusable_token ---
// Un fallo pasajero deja KV igual para que la siguiente pasada reintente con el mismo
// refresh token. Un 200 nunca guarda un token que las peticiones rechazarian.
for (const [label, make, status] of [
  ["429", () => new Response("", { status: 429 }), "429"],
  ["500", () => new Response("", { status: 500 }), "500"],
  ["503", () => new Response("", { status: 503 }), "503"],
  ["error de red", () => { throw new TypeError("fetch failed"); }, null],
  ["200 con {}", () => new Response("{}", { status: 200 }), "200"],
  ["200 con un access_token que no es JWT", () => new Response(JSON.stringify({ access_token: "no-es-un-jwt", refresh_token: NEW_RT }), { status: 200 }), "200"],
] as [string, () => Response, string | null][]) {
  reset();
  diauth = make;
  const before = tokensJson(jwt(nowSec() + 11 * 3600));
  const kv = memoryKV({ tokens: before }, { events });
  const { lines } = await runCron(kv);
  check(`T13 ${label}: no escribe en KV`, events.filter((e) => e.startsWith("kv.put")).length, 0);
  check(`T13 ${label}: KV sin cambios`, kv.raw("tokens"), before);
  check(`T13 ${label}: no se da por rechazado`, lines.some((l) => l.includes("refresco rechazado")), false);
  check(`T13 ${label}: deja algun log`, lines.length > 0, true);
  if (status) check(`T13 ${label}: el log lleva el estado`, lines.join("\n").includes(status), true);
}

// --- T14 should_log_a_relogin_hint_when_the_kv_write_after_a_successful_refresh_fails ---
// Garmin ya ha rotado el token: el guardado puede estar muerto. Reintentar en la misma
// pasada fallaria en el mejor caso y quemaria el token en el peor.
{
  reset();
  diauth = ok200({ access_token: jwt(nowSec() + 89604), refresh_token: NEW_RT, expires_in: 89604 });
  const before = tokensJson(jwt(nowSec() + 11 * 3600));
  const kv = memoryKV({ tokens: before }, { events, failPut: new Error("KV no disponible") });
  const { lines } = await runCron(kv);
  check("T14 un solo refresco", calls.filter((c) => c.url === DIAUTH).length, 1);
  check("T14 log que pide volver a entrar", lines.some((l) => l.includes("garmin-mcp-auth")), true);
  check("T14 no se da por rechazado", lines.some((l) => l.includes("refresco rechazado")), false);
  check("T14 KV sin cambios", kv.raw("tokens"), before);
}

// --- T15 should_never_write_a_token_to_the_logs ---
// MARK esta en OLD_RT, NEW_RT y en la firma de todo JWT. Se revisan las lineas de
// consola, el error que salga de scheduled y los rechazos de waitUntil (Workers los
// escribe en sus logs), con mensaje y pila. Loguear o lanzar un token, el cuerpo del
// formulario, el valor guardado, un cuerpo de respuesta o el mensaje de un JSON.parse
// que lo cite haria fallar esta prueba.
const noDiauth = () => { throw new Error("la fila (f) no debe llegar a diauth"); };
for (const [label, make, stored, failPut] of [
  ["(a) 200 rotado", ok200({ access_token: jwt(nowSec() + 89604), refresh_token: NEW_RT }), undefined, false],
  ["(b) 400 que repite el token", () => new Response(JSON.stringify({ error: "invalid_grant", refresh_token: OLD_RT }), { status: 400 }), undefined, false],
  ["(c) 503 que repite el token", () => new Response("upstream error " + OLD_RT, { status: 503 }), undefined, false],
  ["(d) error de red", () => { throw new TypeError("fetch failed"); }, undefined, false],
  ["(e) 200 y el put falla", ok200({ access_token: jwt(nowSec() + 89604), refresh_token: NEW_RT }), undefined, true],
  // Se para al leer KV, antes de cualquier fetch.
  ["(f) KV con algo que no es JSON", noDiauth, "no-es-json-SECRETO", false],
  // Cuerpo corto a proposito: el SyntaxError de res.json() lo cita entero.
  ["(g) 200 cuyo cuerpo no es JSON", () => new Response(OLD_RT, { status: 200 }), undefined, false],
  // Un JWT sin exp: inservible, pero sigue siendo una credencial y lleva MARK en la firma.
  ["(h) 200 con un access_token sin exp", () => new Response(JSON.stringify({ access_token: jwt(), refresh_token: NEW_RT }), { status: 200 }), undefined, false],
] as [string, () => Response, string | undefined, boolean][]) {
  reset();
  diauth = make;
  const kv = memoryKV({ tokens: stored ?? tokensJson(jwt(nowSec() + 11 * 3600)) },
    { events, failPut: failPut ? new Error("KV no disponible") : undefined });
  const { lines, threw, rejections } = await runCron(kv);
  check(`T15 ${label}: ningun log con un secreto`, lines.some((l) => l.includes(MARK)), false);
  check(`T15 ${label}: el error lanzado no lleva un secreto`, threw !== undefined && format(threw).includes(MARK), false);
  check(`T15 ${label}: ningun rechazo de waitUntil con un secreto`, rejections.some((r) => format(r).includes(MARK)), false);
}

console.log(fail ? `\n${fail} FALLO(S)` : "\nTodo correcto.");
process.exit(fail ? 1 : 0);
