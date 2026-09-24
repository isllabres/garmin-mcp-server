# MCP de Garmin — Worker de Cloudflare (free tier)

Sin contenedor, sin Docker, sin Workers Paid. Mismo patrón que MyWhoosh.

```
Claude ──► MCP Portal (Access + tu IdP) ──► Worker ──► connectapi.garmin.com
                     inyecta Bearer        valida       OAuth1 → oauth2 → REST
```

**Por qué esto es pequeño.** El login de Garmin (SSO, MFA, user-agent de
WebView) es lo complicado, y **no corre aquí**: lo haces una vez en tu máquina.
En ejecución solo hacen falta dos cosas: un POST firmado con OAuth1 para
refrescar el token, y GETs con Bearer. De ahí que quepa en 400 líneas.

## Lo que está verificado

- Firma OAuth1/HMAC-SHA1 contra el vector de test canónico (`test/oauth1.test.mts`).
- Protocolo MCP probado en local: `initialize`, `tools/list`, `tools/call`,
  notificaciones, lotes, y el portero devolviendo 401.
- Endpoints y User-Agent extraídos de garth 0.8.0 y garminconnect 0.3.2,
  no de memoria.

## 1. Saca el token de Garmin (una vez, en local)

```bash
uvx --python 3.12 --from git+https://github.com/Taxuspt/garmin_mcp garmin-mcp-auth
cat ~/.garminconnect/oauth1_token.json
```

Ese JSON entero es el secreto. Dura ~1 año.

## 2. Fija el consumer (recomendado)

Sin esto, el Worker descarga las credenciales de consumer de un bucket S3 de
terceros en cada arranque en frío. Si ese bucket cae, tu rutina falla:

```bash
curl -s https://thegarth.s3.amazonaws.com/oauth_consumer.json
```

## 3. Sube los secretos

```bash
npx wrangler secret put GARMIN_OAUTH1          # el JSON del paso 1
npx wrangler secret put UPSTREAM_TOKEN         # openssl rand -hex 32
npx wrangler secret put GARMIN_CONSUMER_KEY    # del paso 2
npx wrangler secret put GARMIN_CONSUMER_SECRET
```

## 4. Despliega

```bash
npm install
npm run typecheck
npx wrangler deploy      # pon tu dominio en wrangler.jsonc antes
```

## 5. Portal MCP

En **Cloudflare One → AI Controls → MCP server portals**: CNAME a
`gateway.agents.cloudflare.com`, servidor upstream apuntando a tu Worker con
transporte **Streamable HTTP** y credencial `Authorization: Bearer <UPSTREAM_TOKEN>`.
Política de Access: **solo tu correo**.

> Si los portales no entran en el plan gratuito de Zero Trust, el Worker ya
> valida el Bearer por su cuenta: puedes conectarlo directo mientras tanto.

## Prueba

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://garmin-mcp.TUDOMINIO.com   # 401

curl -s -X POST https://garmin-mcp.TUDOMINIO.com \
  -H "Authorization: Bearer <UPSTREAM_TOKEN>" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Las 12 herramientas

| Herramienta | Para qué |
|---|---|
| `get_sleep_data` | Fases, duración, FC en reposo |
| `get_hrv_data` | HRV nocturna y estado vs. tu línea base |
| `get_training_readiness` | Puntuación 0-100 y sus factores |
| `get_body_battery` | Energía disponible por días |
| `get_stress_data` | Estrés a lo largo del día |
| `get_activities` / `get_activity` | Actividades y su detalle |
| `upload_workout` | Crear entreno — **admite kg** (`weightValue`) |
| `schedule_workout` | Ponerlo en el calendario |
| `get_scheduled_workouts` | Ver el mes |
| `delete_workout` | Borrar |
| `get_user_settings` | FTP y zonas |

## Mantenimiento

- **Token**: caduca en ~1 año. Repite pasos 1 y 3.
- **Endpoints**: si Garmin cambia una ruta, se toca en `src/tools.ts`.
- **El riesgo de fondo no cambia**: es API no oficial y Garmin puede
  suspender la cuenta. Eso es del método, no del lenguaje.
