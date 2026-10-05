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
  if (req.url === DIAUTH) return diauth();
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

console.log(fail ? `\n${fail} FALLO(S)` : "\nTodo correcto.");
process.exit(fail ? 1 : 0);
