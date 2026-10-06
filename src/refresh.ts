// Refresco programado de la sesion DI OAuth2 (Cron Trigger). Es el UNICO que
// escribe la sesion en KV: las peticiones solo la leen. La peticion copia la del
// spike del 2026-10-05 (python-garminconnect 0.3.17, _refresh_di_token); no
// cambies estas cabeceras de memoria.

import { parseTokens, TOKENS_KEY } from "./tokens.ts";

const DIAUTH = "https://diauth.garmin.com/di-oauth2-service/oauth/token";
// El cron corre cada 6 h y el token de acceso dura ~25 h: refrescando por debajo de
// 12 h se refresca cada ~18 h (una escritura de KV) con unas 6,9 h de margen, asi que
// el token sobrevive a una pasada fallida; con dos seguidas caduca hasta la siguiente.
const REFRESH_BELOW_SECONDS = 12 * 3600;
const NATIVE: Record<string, string> = {
  "User-Agent": "GCM-Android-5.23",
  "X-Garmin-User-Agent":
    "com.garmin.android.apps.connectmobile/5.23; ; Google/sdk_gphone64_arm64/google; Android/33; Dalvik/2.1.0",
  "X-Garmin-Paired-App-Version": "10861",
  "X-Garmin-Client-Platform": "Android",
  "X-App-Ver": "10861",
  "X-Lang": "en",
  "X-GCExperience": "GC5",
  "Accept-Language": "en-US,en;q=0.9",
};

export async function refreshSession(kv: KVNamespace): Promise<void> {
  const { tokens, exp } = parseTokens(await kv.get(TOKENS_KEY));
  if (exp - Math.floor(Date.now() / 1000) >= REFRESH_BELOW_SECONDS) return;

  const init: RequestInit = {
    method: "POST",
    headers: {
      ...NATIVE,
      Authorization: `Basic ${btoa(`${tokens.di_client_id}:`)}`,
      Accept: "application/json",
      // Explicito: con un URLSearchParams como cuerpo se anadiria ;charset=UTF-8.
      "Content-Type": "application/x-www-form-urlencoded",
      "Cache-Control": "no-cache",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: tokens.di_client_id,
      refresh_token: tokens.di_refresh_token,
    }),
  };

  // Los logs solo llevan texto fijo y el estado HTTP: nunca un token ni un cuerpo.
  let res: Response;
  try {
    res = await fetch(DIAUTH, init);
  } catch {
    console.error("refresco fallido (error de red): se reintenta en la proxima pasada");
    return;
  }
  if (res.status === 400 || res.status === 401) {
    console.error(`refresco rechazado: ejecuta garmin-mcp-auth (HTTP ${res.status})`);
    return;
  }
  if (!res.ok) {
    console.error(`refresco fallido (HTTP ${res.status}): se reintenta en la proxima pasada`);
    return;
  }

  // El candidato pasa por el mismo parseTokens que las peticiones: nunca se guarda una
  // sesion malformada. Si Garmin no rota el refresh token (ausente, null o vacio), se
  // conserva el guardado.
  let next: string;
  try {
    const data = (await res.json()) as { access_token?: unknown; refresh_token?: unknown };
    next = JSON.stringify({
      di_token: data.access_token,
      di_refresh_token: typeof data.refresh_token === "string" && data.refresh_token
        ? data.refresh_token : tokens.di_refresh_token,
      di_client_id: tokens.di_client_id,
    });
    parseTokens(next);
  } catch {
    console.error(`refresco fallido (HTTP ${res.status} sin un token valido): se reintenta en la proxima pasada`);
    return;
  }
  // Primera E/S tras el refresco: el refresh token anterior puede haber dejado de valer.
  // Si no se puede guardar, el rotado se pierde y el refresco no se repite en esta
  // pasada: si Garmin ya invalido el guardado, habra que volver a entrar.
  try {
    await kv.put(TOKENS_KEY, next);
  } catch {
    console.error("refresco hecho pero no se pudo guardar en KV: ejecuta garmin-mcp-auth");
  }
}
