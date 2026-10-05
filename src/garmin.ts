// Cliente Garmin minimo para Cloudflare Workers.
//
// La sesion es DI OAuth2, como en python-garminconnect 0.3.x. El login (SSO con
// MFA) NO esta aqui a proposito: lo haces una vez en tu maquina con
// `garmin-mcp-auth` y cargas garmin_tokens.json en el KV GARMIN_KV, clave "tokens".
// Aqui solo se lee de KV el token de acceso y se llama a connectapi.garmin.com con
// Bearer. User-Agent sacado de garth 0.8.0; NK, de python-garminconnect 0.3.2.

import { parseTokens, EXPIRED, TOKENS_KEY } from "./tokens.ts";

const API = "https://connectapi.garmin.com";
const UA = "GCM-iOS-5.22.1.4";            // garth/http.py — Garmin rechaza otros

// Cache por isolate del displayName: no es secreto y solo cambiaria si se carga en
// KV la sesion de otra cuenta (un isolate caliente seguiria con el nombre anterior).
let displayNameCache: string | null = null;

/** GET/POST/DELETE contra connectapi con el Bearer de la sesion guardada en KV. */
export async function connectapi(
  kv: KVNamespace,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<unknown> {
  const { tokens, exp } = parseTokens(await kv.get(TOKENS_KEY));
  // Solo el cron refresca. 60 s de margen para no usar un token que caduca a mitad de vuelo.
  if (exp - 60 <= Math.floor(Date.now() / 1000)) throw new Error(EXPIRED);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${tokens.di_token}`,
    "User-Agent": UA,
    "Accept": "application/json",
    "NK": "NT",           // Garmin devuelve 403 sin esta cabecera
  };
  if (init.body !== undefined) headers["Content-Type"] = "application/json";

  const res = await fetch(`${API}${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });

  if (res.status === 204) return { ok: true };
  const text = await res.text();
  if (!res.ok) throw new Error(`Garmin ${res.status} en ${path}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : { ok: true };
}

/** El endpoint de sueno se indexa por displayName, no por fecha sola. */
export async function displayName(kv: KVNamespace): Promise<string> {
  if (displayNameCache) return displayNameCache;
  const p = (await connectapi(kv, "/userprofile-service/socialProfile")) as {
    displayName: string;
  };
  displayNameCache = p.displayName;
  return displayNameCache;
}
