# MCP de Garmin — Worker de Cloudflare (free tier)

Sin contenedor, sin Docker, sin Workers Paid. Mismo patrón que MyWhoosh.

```
Claude ──► MCP Portal (Access + tu IdP) ──► Worker ──► connectapi.garmin.com
                     inyecta Bearer        valida       Bearer de la sesión en KV
Cron (cada 6 h) ──► Worker ──► diauth.garmin.com: refresca y guarda en KV los tokens rotados
```

**Por qué esto es pequeño.** El login de Garmin (SSO y MFA) es lo complicado, y
**no corre aquí**: lo haces una vez en tu máquina. En ejecución solo hacen falta
dos cosas: llamadas con Bearer leyendo la sesión de KV, y un refresco programado
del token (un POST a diauth cada ~18 h, desde un Cron Trigger). De ahí que quepa
en unos pocos cientos de líneas.

## Lo que está verificado

- Refresco DI OAuth2 probado desde el edge de Cloudflare (`wrangler dev --remote`,
  2026-10-05): diauth respondió 200 y connectapi aceptó el token nuevo.
- Protocolo MCP probado en local: `initialize`, `tools/list`, `tools/call`,
  notificaciones, lotes, y el portero devolviendo 401.
- Endpoints y User-Agent extraídos de garth 0.8.0 y garminconnect 0.3.2, y el
  refresco DI de garminconnect 0.3.17, no de memoria.

## 1. Entra en Garmin (una vez, en local)

```bash
uvx --from "git+https://github.com/isllabres/garmin-mcp-server#subdirectory=auth" garmin-mcp-auth
```

Pide email, contraseña y código MFA siempre, aunque ya exista una sesión
guardada, entra con python-garminconnect 0.3.17 y guarda los tokens DI OAuth2 en `~/.garminconnect/garmin_tokens.json`, legible
solo por ti: un token de acceso que dura ~25 h y un refresh token que dura
30 días y rota en cada refresco.

> Garmin cambió su login en marzo de 2026. Si falla con `429`, espera antes de
> reintentar: cada intento alarga el bloqueo. Si sale con `Login sin tokens DI
> validos`, Garmin no dio tokens DI utilizables (lo normal es que solo diera una
> sesión web): no se ha guardado nada y el KV sigue igual; reintenta más tarde.

## 2. Crea el namespace de KV

Este repo ya tiene su id en `wrangler.jsonc`. Para tu copia, créalo y deja que
wrangler escriba el id:

```bash
npm install
npx wrangler kv namespace create GARMIN_KV --binding GARMIN_KV --update-config
```

## 3. Carga la sesión y el portero

```bash
npx wrangler kv key put tokens --binding GARMIN_KV --remote --path ~/.garminconnect/garmin_tokens.json
npx wrangler secret put UPSTREAM_TOKEN         # openssl rand -hex 32
```

Un Cron Trigger (cada 6 h) refresca el token de acceso cuando le quedan menos de
12 h y guarda en KV el refresh token rotado. Una vez cargada la sesión, no
refresques ese fichero en otro sitio: el refresh token rota y el Worker se
quedaría sin sesión. No quites `--remote`: sin él, wrangler escribe en el KV
local y el Worker desplegado no ve la sesión. Para volver a entrar, repite los
pasos 1 y 3.

## 4. Despliega

```bash
npm install
npm run typecheck
npx wrangler deploy      # sirve en garmin-mcp-server.<tu-subdominio>.workers.dev
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
curl -s -o /dev/null -w "%{http_code}\n" https://garmin-mcp-server.<tu-subdominio>.workers.dev   # 401

curl -s -X POST https://garmin-mcp-server.<tu-subdominio>.workers.dev \
  -H "Authorization: Bearer <UPSTREAM_TOKEN>" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Las 14 herramientas

| Herramienta | Para qué |
|---|---|
| `get_sleep_data` | Fases, duración, FC en reposo |
| `get_hrv_data` | HRV nocturna y estado vs. tu línea base |
| `get_training_readiness` | Puntuación 0-100 y sus factores |
| `get_body_battery` | Energía disponible por días |
| `get_stress_data` | Estrés a lo largo del día |
| `get_activities` / `get_activity` | Actividades y su resumen |
| `get_activity_splits` | Vueltas de una actividad, una a una |
| `get_activity_exercise_sets` | Series de una sesión de fuerza |
| `upload_workout` | Crear entreno — **admite kg** (`weightValue`) |
| `schedule_workout` | Ponerlo en el calendario |
| `get_scheduled_workouts` | Ver el mes |
| `delete_workout` | Borrar |
| `get_user_settings` | FTP y zonas |

## Mantenimiento

- **Sesión**: el refresh token dura 30 días y el cron lo renueva cada ~18 h, así
  que no caduca mientras el Worker esté desplegado. Vuelve a entrar (pasos 1 y 3)
  solo si una herramienta responde `sin sesion de Garmin` o los logs muestran
  `refresco rechazado` o `refresco hecho pero no se pudo guardar en KV`.
- **Endpoints**: si Garmin cambia una ruta, se toca en `src/tools.ts`.
- **El riesgo de fondo no cambia**: es API no oficial y Garmin puede
  suspender la cuenta. Eso es del método, no del lenguaje.
