// Valida que el Worker responde -32600 a los mensajes JSON-RPC que no son objetos,
// en vez de romper con un HTTP 500 o callar con un 202. Todo se observa a traves
// de worker.fetch; fetch esta sustituido por una trampa: ningun caso sale a la red.
import { isDeepStrictEqual } from "node:util";
import worker from "../src/index.ts";

// Trampa de red: es un stub de guarda, nunca se comprueba cuantas veces se llamo.
globalThis.fetch = () => { throw new Error("red prohibida en tests"); };

let fail = 0;
// detalle: lo que se imprime si falla (por ejemplo, el cuerpo de la respuesta).
const check = (name: string, got: unknown, want: unknown, detalle?: string) => {
  const ok = got === want;
  console.log(`${ok ? "PASS" : "FALLO"}  ${name}`);
  if (!ok) {
    console.log(`        obtenido: ${got}\n        esperado: ${want}`);
    if (detalle !== undefined) console.log(`        detalle: ${detalle}`);
    fail++;
  }
};

// Sin GARMIN_CONSUMER_KEY/SECRET: presetConsumer no hace nada y las caches no se tocan.
const env = { GARMIN_OAUTH1: '{"oauth_token":"x","oauth_token_secret":"y"}', UPSTREAM_TOKEN: "t" };

// Manda raw tal cual. Si fetch rechaza, lo devuelve en rejected en vez de abortar el script.
async function post(raw: string) {
  try {
    const res = await worker.fetch(new Request("http://localhost/", {
      method: "POST",
      headers: { Authorization: "Bearer t", "Content-Type": "application/json" },
      body: raw,
    }), env);
    return { rejected: null, status: res.status, contentType: res.headers.get("Content-Type"), text: await res.text() };
  } catch (e) {
    return { rejected: e instanceof Error ? e.message : String(e), status: 0, contentType: null, text: "" };
  }
}

const parse = (text: string): unknown => {
  try { return JSON.parse(text); } catch { return undefined; }
};

const INVALID_REQUEST = { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Peticion invalida" } };
const PING_REQ = { jsonrpc: "2.0", id: 1, method: "ping" };
const PING_RES = { jsonrpc: "2.0", id: 1, result: {} };
const NOTIF = { jsonrpc: "2.0", method: "notifications/initialized" };

// --- T1 should_answer_200_invalid_request_with_null_id_when_body_is_null ---
// Un cuerpo null tumbaba el Worker (HTTP 500): ahora recibe -32600 con id null.
{
  const r = await post("null");
  check("T1 cuerpo null: no rechaza", r.rejected, null);
  check("T1 cuerpo null: HTTP 200", r.status, 200);
  check("T1 cuerpo null: Content-Type application/json", r.contentType, "application/json");
  check("T1 cuerpo null: -32600 con id null", isDeepStrictEqual(parse(r.text), INVALID_REQUEST), true, r.text);
}

// --- T2 should_answer_invalid_request_entry_instead_of_crashing_when_batch_item_is_null ---
// Un null dentro de un lote tambien tumbaba el Worker: fija que la guarda cubre el lote.
{
  const r = await post("[null]");
  check("T2 lote [null]: no rechaza", r.rejected, null);
  check("T2 lote [null]: HTTP 200", r.status, 200);
  check("T2 lote [null]: [-32600 con id null]", isDeepStrictEqual(parse(r.text), [INVALID_REQUEST]), true, r.text);
}

// --- T3 should_answer_invalid_request_when_single_message_is_a_non_null_primitive ---
// Un mensaje primitivo recibia un 202 mudo. Mezcla verdaderos y un falso (false)
// para que una guarda parcial como !req o req === null falle al menos uno.
for (const raw of ["5", '"x"', "true", "false"]) {
  const r = await post(raw);
  check(`T3 cuerpo ${raw}: HTTP 200 y -32600 con id null`,
    r.status === 200 && isDeepStrictEqual(parse(r.text), INVALID_REQUEST), true,
    `HTTP ${r.status} ${r.rejected ?? r.text}`);
}

// --- T4 should_return_valid_responses_plus_one_error_per_invalid_item_in_mixed_batch ---
// Antes 5 y "x" se trataban como notificaciones. No se fija el orden: JSON-RPC §6 lo deja libre.
{
  const r = await post(JSON.stringify([PING_REQ, 5, NOTIF, "x"]));
  const body = parse(r.text);
  const count = (want: unknown) => Array.isArray(body) ? body.filter((e) => isDeepStrictEqual(e, want)).length : -1;
  check("T4 lote mixto: HTTP 200", r.status, 200, r.rejected ?? r.text);
  check("T4 lote mixto: 3 entradas", Array.isArray(body) ? body.length : -1, 3, r.text);
  check("T4 lote mixto: 1 respuesta de ping", count(PING_RES), 1, r.text);
  check("T4 lote mixto: 2 errores -32600 con id null", count(INVALID_REQUEST), 2, r.text);
}

// --- T5 should_answer_single_non_array_invalid_request_when_batch_is_empty ---
// Un lote vacio recibia un 202 mudo. JSON-RPC §6: se responde un solo error, no una lista.
{
  const r = await post("[]");
  const body = parse(r.text);
  check("T5 lote vacio: HTTP 200", r.status, 200, r.rejected ?? r.text);
  check("T5 lote vacio: la respuesta no es una lista", Array.isArray(body), false, r.text);
  check("T5 lote vacio: -32600 con id null", isDeepStrictEqual(body, INVALID_REQUEST), true, r.text);
}

// --- T6 should_still_answer_202_empty_when_batch_contains_only_notifications ---
// Sigue igual que antes. Falla si el lote vacio se mira en la salida filtrada y no en la entrada.
{
  const r = await post(JSON.stringify([NOTIF, NOTIF]));
  check("T6 lote solo de notificaciones: HTTP 202", r.status, 202, r.rejected ?? r.text);
  check("T6 lote solo de notificaciones: cuerpo vacio", r.text, "");
}

console.log(fail ? `\n${fail} FALLO(S)` : "\nTodo correcto.");
process.exit(fail ? 1 : 0);
