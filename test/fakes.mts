// Dobles compartidos por los tests de la sesion DI en KV. No es un .test.mts:
// npm test no lo ejecuta, como workers-crypto.mts.

import { format } from "node:util";

type GetType = "text" | "json" | { type?: "text" | "json" };

// KV en memoria. Graba "kv.get <clave>" y "kv.put <clave>" en events para que
// los tests comprueben el orden y el numero de operaciones.
export function memoryKV(
  initial: Record<string, string> = {},
  opts: { events?: string[]; failGet?: Error; failPut?: Error } = {},
) {
  const store = new Map(Object.entries(initial));
  const events = opts.events ?? [];
  return {
    async get(key: string, type?: GetType) {
      events.push(`kv.get ${key}`);
      if (opts.failGet) throw opts.failGet;
      const raw = store.get(key);
      if (raw === undefined) return null;
      const t = typeof type === "string" ? type : type?.type;
      return t === "json" ? JSON.parse(raw) : raw;
    },
    async put(key: string, value: unknown, _opts?: unknown) {
      events.push(`kv.put ${key}`);
      if (opts.failPut) throw opts.failPut;
      if (typeof value !== "string") throw new TypeError("memoryKV solo guarda cadenas");
      store.set(key, value);
    },
    // Siembra desde el test, sin evento.
    set(key: string, value: string) { store.set(key, value); },
    raw(key: string) { return store.get(key) ?? null; },
  };
}

// Todo secreto de los fixtures contiene MARK: un solo includes(MARK) delata la
// fuga de cualquiera de ellos a un resultado o a un log.
export const MARK = "SECRETO";
export const CLIENT = "GARMIN_CONNECT_MOBILE_ANDROID_DI_2025Q2";
export const OLD_RT = "rt-viejo+/=SECRETO";   // +/= obligan a codificar el formulario
export const NEW_RT = "rt-nuevo-SECRETO";

export const nowSec = () => Math.floor(Date.now() / 1000);

// JWT de prueba con el exp dado (sin exp si es undefined). El payload empieza por
// eyJzdWIiOiJ-fn4_Pz8-Pj4i: lleva - y _, asi que un atob directo sobre el segmento
// falla y obliga a decodificar base64url.
export const jwt = (exp?: number) =>
  "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9." +
  Buffer.from(JSON.stringify({ sub: "~~~???>>>", exp })).toString("base64url") +
  ".firmaSECRETO";

// La forma de garmin_tokens.json. { di_refresh_token: undefined } quita la clave.
export const tokensJson = (di_token: string, over: Record<string, unknown> = {}) =>
  JSON.stringify({ di_token, di_refresh_token: OLD_RT, di_client_id: CLIENT, ...over });

// Graba todo lo que se escribe en la consola mientras corre fn y la restaura al
// acabar. Envuelve solo el Act: check() imprime PASS/FALLO con console.log.
export async function captureLogs(fn: () => unknown) {
  const lines: string[] = [];
  let threw: unknown;
  const methods = ["log", "info", "warn", "error", "debug"] as const;
  const orig = methods.map((m) => console[m]);
  for (const m of methods) console[m] = (...args: unknown[]) => { lines.push(format(...args)); };
  try { await fn(); } catch (e) { threw = e; }
  finally { methods.forEach((m, i) => { console[m] = orig[i]; }); }
  return { lines, threw };
}
