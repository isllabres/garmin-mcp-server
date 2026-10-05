// Refresco programado de la sesion DI OAuth2 (Cron Trigger). Es el UNICO que
// escribe la sesion en KV: las peticiones solo la leen. La peticion copia la del
// spike del 2026-10-05 (python-garminconnect 0.3.17, _refresh_di_token); no
// cambies estas cabeceras de memoria.

import { parseTokens } from "./tokens.ts";

const DIAUTH = "https://diauth.garmin.com/di-oauth2-service/oauth/token";
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
  const { tokens } = parseTokens(await kv.get("tokens"));
  await fetch(DIAUTH, {
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
    }).toString(),
  });
}
