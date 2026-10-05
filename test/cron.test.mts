// Valida el refresco programado de la sesion DI OAuth2 (worker.scheduled): la
// peticion exacta a diauth, que el token rotado se guarda en KV antes de nada, el
// umbral de 12 h, y que ningun fallo toca KV ni escribe un token en los logs.
// Solo se llama a worker.scheduled; fetch esta sustituido por un stub que graba
// cada llamada y lanza ante cualquier URL que no sea diauth.
import worker from "../src/index.ts";
import { memoryKV, jwt, nowSec, tokensJson, captureLogs, CLIENT, OLD_RT, NEW_RT } from "./fakes.mts";

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
async function runCron(kv: ReturnType<typeof memoryKV>) {
  const pending: Promise<unknown>[] = [];
  const controller = { scheduledTime: Date.now(), cron: "0 */6 * * *", noRetry() {} };
  const ctx = { waitUntil(p: Promise<unknown>) { pending.push(p); }, passThroughOnException() {} };
  const env = { GARMIN_KV: kv, UPSTREAM_TOKEN: "test-upstream" };
  return captureLogs(async () => {
    await (worker as any).scheduled(controller, env, ctx);
    await Promise.allSettled(pending);
  });
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

console.log(fail ? `\n${fail} FALLO(S)` : "\nTodo correcto.");
process.exit(fail ? 1 : 0);
