// Cliente Garmin minimo para Cloudflare Workers.
//
// Solo cubre lo que hace falta EN EJECUCION. El login SSO (con MFA y el
// user-agent de WebView) NO esta aqui a proposito: eso lo haces una vez en tu
// maquina con `garmin-mcp-auth` y subes el token resultante como secreto.
//
// Lo que si hay:
//   1) refresco del token oauth2 a partir del oauth1, firmado con OAuth1/HMAC-SHA1
//   2) llamadas REST a connectapi.garmin.com con Bearer
//
// Endpoints y User-Agent extraidos de garth 0.8.0 y garminconnect 0.3.2.

const DOMAIN = "garmin.com";
const API = `https://connectapi.${DOMAIN}`;
const UA = "GCM-iOS-5.22.1.4";            // garth/http.py — Garmin rechaza otros
const UA_OAUTH = "com.garmin.android.apps.connectmobile";
const CONSUMER_URL = "https://thegarth.s3.amazonaws.com/oauth_consumer.json";

export interface OAuth1Token {
  oauth_token: string;
  oauth_token_secret: string;
  mfa_token?: string | null;
  domain?: string;
}

interface OAuth2Token {
  access_token: string;
  expires_at: number; // epoch segundos
}

// Cache por isolate. Si el isolate muere se refresca solo: cuesta una peticion.
let consumerCache: { key: string; secret: string } | null = null;
let tokenCache: OAuth2Token | null = null;
let displayNameCache: string | null = null;

const enc = new TextEncoder();

/** Percent-encoding de RFC 3986, que es el que exige OAuth1. */
export function pct(s: string): string {
  return encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

export async function hmacSha1(key: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey(
    "raw", enc.encode(key),
    { name: "HMAC", hash: "SHA-1" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", k, enc.encode(msg));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

export function presetConsumer(key?: string, secret?: string) {
  // Si los pasas como secretos, el servidor deja de depender en caliente de un
  // bucket S3 de terceros. Recomendado: sacalos una vez de CONSUMER_URL y fijalos.
  if (key && secret) consumerCache = { key, secret };
}

async function getConsumer() {
  if (consumerCache) return consumerCache;
  const r = await fetch(CONSUMER_URL, { headers: { "User-Agent": UA_OAUTH } });
  if (!r.ok) {
    throw new Error(
      `No se pudo leer el oauth_consumer (${r.status}). Fija GARMIN_CONSUMER_KEY ` +
      `y GARMIN_CONSUMER_SECRET como secretos para no depender de ese bucket.`,
    );
  }
  const j = (await r.json()) as { consumer_key: string; consumer_secret: string };
  consumerCache = { key: j.consumer_key, secret: j.consumer_secret };
  return consumerCache;
}

/**
 * Cambia el token oauth1 (dura ~1 anio) por un oauth2 (dura ~1 h).
 * Replica garth.sso.exchange.
 */
async function exchange(oauth1: OAuth1Token): Promise<OAuth2Token> {
  const { key: ck, secret: cs } = await getConsumer();
  const url = `${API}/oauth-service/oauth/exchange/user/2.0`;

  const params: Record<string, string> = {
    oauth_consumer_key: ck,
    oauth_nonce: crypto.randomUUID().replace(/-/g, ""),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: oauth1.oauth_token,
    oauth_version: "1.0",
  };

  // Base string: METODO&url&parametros ordenados, todo percent-encoded.
  const normalized = Object.keys(params).sort()
    .map((k) => `${pct(k)}=${pct(params[k])}`).join("&");
  const base = `POST&${pct(url)}&${pct(normalized)}`;
  const signingKey = `${pct(cs)}&${pct(oauth1.oauth_token_secret)}`;
  params.oauth_signature = await hmacSha1(signingKey, base);

  const header = "OAuth " + Object.keys(params).sort()
    .map((k) => `${pct(k)}="${pct(params[k])}"`).join(", ");

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: header,
      "User-Agent": UA_OAUTH,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: oauth1.mfa_token ? `mfa_token=${oauth1.mfa_token}` : "",
  });
  if (!res.ok) {
    throw new Error(
      `Refresco de token fallido (${res.status}). ` +
      `Si es 401, el token oauth1 ha caducado: repite garmin-mcp-auth en local.`,
    );
  }
  const j = (await res.json()) as { access_token: string; expires_in: number };
  return {
    access_token: j.access_token,
    // 60 s de margen para no usar un token que caduca a mitad de vuelo.
    expires_at: Math.floor(Date.now() / 1000) + j.expires_in - 60,
  };
}

async function bearer(oauth1: OAuth1Token): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (!tokenCache || tokenCache.expires_at <= now) {
    tokenCache = await exchange(oauth1);
  }
  return tokenCache.access_token;
}

/** GET/POST/DELETE contra connectapi con el Bearer puesto. */
export async function connectapi(
  oauth1: OAuth1Token,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<unknown> {
  const token = await bearer(oauth1);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
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
export async function displayName(oauth1: OAuth1Token): Promise<string> {
  if (displayNameCache) return displayNameCache;
  const p = (await connectapi(oauth1, "/userprofile-service/socialProfile")) as {
    displayName: string;
  };
  displayNameCache = p.displayName;
  return displayNameCache;
}
