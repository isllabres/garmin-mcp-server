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

console.log(fail ? `\n${fail} FALLO(S)` : "\nTodo correcto.");
process.exit(fail ? 1 : 0);
