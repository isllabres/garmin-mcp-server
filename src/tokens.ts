// Sesion DI OAuth2 guardada en KV: la forma de garmin_tokens.json que escribe
// garmin-mcp-auth (python-garminconnect). La usan las peticiones y el cron.

export interface Tokens {
  di_token: string;          // JWT de acceso, dura ~25 h
  di_refresh_token: string;  // rota en cada refresco, dura 30 dias
  di_client_id: string;
}

export const NO_SESSION = "sin sesion de Garmin: ejecuta garmin-mcp-auth y carga el token en KV";

/** Claim exp (epoch segundos) del JWT, decodificando base64url sin Buffer; null si no lo hay. */
function jwtExp(token: string): number | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)));
    return typeof payload?.exp === "number" ? payload.exp : null;
  } catch {
    return null;
  }
}

/**
 * Valida la sesion guardada: tres cadenas no vacias y un di_token con exp. Lanza
 * NO_SESSION sin citar el valor ni el error: JSON.parse citaria la entrada.
 */
export function parseTokens(raw: string | null): { tokens: Tokens; exp: number } {
  let t: Partial<Tokens> | null = null;
  try {
    t = raw === null ? null : JSON.parse(raw);
  } catch { /* cae al error de abajo */ }
  const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;
  if (t && typeof t === "object" && str(t.di_token) && str(t.di_refresh_token) && str(t.di_client_id)) {
    const exp = jwtExp(t.di_token);
    if (exp !== null) {
      return {
        tokens: { di_token: t.di_token, di_refresh_token: t.di_refresh_token, di_client_id: t.di_client_id },
        exp,
      };
    }
  }
  throw new Error(NO_SESSION);
}
