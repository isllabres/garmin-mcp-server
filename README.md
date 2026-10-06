# garmin-mcp-server

An [MCP](https://modelcontextprotocol.io) server that gives Claude, or any MCP client, access to a Garmin Connect account through 14 tools: recovery data (sleep, HRV, training readiness, Body Battery, stress), activities, and workouts. It runs as a single Cloudflare Worker on the free tier, with no runtime dependencies.

> **Unofficial API.** The server relies on the Garmin Connect app's private endpoints, which can change without notice. Garmin may suspend accounts that use them. Use at your own risk.

## Tools

Dates are `YYYY-MM-DD`. Tools return Garmin's JSON unchanged.

| Tool | Arguments | Returns |
|---|---|---|
| `get_sleep_data` | `date` | Sleep stages, duration, score, resting HR |
| `get_hrv_data` | `date` | Overnight HRV and baseline status |
| `get_training_readiness` | `date` | Readiness score (0–100) and factors |
| `get_body_battery` | `start_date`, `end_date` | Daily Body Battery charge and drain |
| `get_stress_data` | `date` | Stress over the day (0–100) |
| `get_activities` | `start` (default 0), `limit` (default 20) | Recent activities, newest first |
| `get_activity` | `activity_id` | Activity summary with basic split summaries |
| `get_activity_splits` | `activity_id` | Laps of one activity, one by one |
| `get_activity_exercise_sets` | `activity_id` | Sets of one strength session: exercise, reps, weight |
| `upload_workout` | `workout` (Garmin workout DTO) | Creates a workout; returns `workoutId` |
| `schedule_workout` | `workout_id`, `date` | Adds a workout to the calendar |
| `get_scheduled_workouts` | `year`, `month` (1–12) | Calendar items for a month |
| `delete_workout` | `workout_id` | Deletes a workout |
| `get_user_settings` | none | FTP, power and HR zones, weight, thresholds |

- To set strength loads in kilograms, use `upload_workout` and add `weightValue` and `weightUnit: {"unitId": 8, "unitKey": "kilogram", "factor": 1000}` to each step.
- `get_scheduled_workouts` converts the month to Garmin's 0–11 numbering.

## Requirements

- A Cloudflare account (free plan). A domain on Cloudflare is needed only for the MCP portal (setup step 5).
- Node.js 22 or later (22.18+ or 23.6+ to run the tests)
- [uv](https://docs.astral.sh/uv/)
- A Garmin Connect account

## Setup

1. **Log in to Garmin** once, on your machine. `garmin-mcp-auth` (in `auth/`) asks for your email, password and MFA code every time, even if a saved session exists, logs in with [python-garminconnect](https://github.com/cyberjunky/python-garminconnect) 0.3.17, and saves Garmin's DI OAuth2 tokens in `~/.garminconnect/garmin_tokens.json`, readable only by you. That file holds an access token that lasts about 25 hours and a refresh token that lasts 30 days and changes on every refresh.

   ```bash
   uvx --from "git+https://github.com/isllabres/garmin-mcp-server#subdirectory=auth" garmin-mcp-auth
   ```

   Garmin changed its login in March 2026. If the login fails with `429`, wait before retrying, because repeated attempts extend the block.

2. **Create the KV namespace** that holds the session. This repo's `wrangler.jsonc` already has its namespace id. For your own copy, create one and let wrangler write its id into `wrangler.jsonc`:

   ```bash
   npm install
   npx wrangler kv namespace create GARMIN_KV --binding GARMIN_KV --update-config
   ```

3. **Load the session and set the client secret.**

   ```bash
   npx wrangler kv key put tokens --binding GARMIN_KV --remote --path ~/.garminconnect/garmin_tokens.json
   npx wrangler secret put UPSTREAM_TOKEN          # e.g. openssl rand -hex 32
   ```

   | Where | Name | Purpose |
   |---|---|---|
   | KV `GARMIN_KV` | key `tokens` | The Garmin session (`garmin_tokens.json`). Requests read it; only the cron writes it. |
   | Secret | `UPSTREAM_TOKEN` | Bearer token that clients must send |

   A Cron Trigger, set in `wrangler.jsonc` to run every 6 hours, refreshes the access token when it has less than 12 hours left and stores the new refresh token in KV. Once the session is in KV, don't refresh the same `garmin_tokens.json` anywhere else, for example in another script or a local `wrangler dev` holding this token. Each refresh replaces the refresh token, so the Worker's copy would stop working. Keep `--remote`: without it, Wrangler writes to the local KV and the deployed Worker never sees the session. To log in again, repeat steps 1 and 3.

4. **Deploy.** `wrangler.jsonc` serves the Worker at `https://garmin-mcp-server.<your-subdomain>.workers.dev`. Run:

   ```bash
   npm run typecheck
   npm run deploy   # wrangler deploy
   ```

   To serve it on a domain you have on Cloudflare instead, set `"workers_dev": false` and add `"routes": [{ "pattern": "garmin-mcp.example.com", "custom_domain": true }]`. If the repo is connected to Workers Builds, every push to `main` deploys, and the Worker name in the dashboard must match `name` in `wrangler.jsonc`.

5. **Connect a client.**

   - **Cloudflare MCP portal (recommended).** Claude clients do not forward custom headers ([cloudflare/mcp#95](https://github.com/cloudflare/mcp/issues/95)), so a portal adds the Bearer token server-side. In **Cloudflare One → AI Controls → MCP server portals**, create a portal (CNAME to `gateway.agents.cloudflare.com`), add the Worker as an upstream (**Streamable HTTP**, header `Authorization: Bearer <UPSTREAM_TOKEN>`), restrict the Access policy to your email, and add the portal URL to Claude as a custom connector.
   - **Direct.** Clients that send custom headers can connect directly, for example Claude Code:

     ```bash
     claude mcp add --transport http garmin https://garmin-mcp.example.com \
       --header "Authorization: Bearer <UPSTREAM_TOKEN>"
     ```

## Smoke test

```bash
# Without a token: expect 401
curl -s -o /dev/null -w "%{http_code}\n" https://garmin-mcp.example.com

# List the tools
curl -s -X POST https://garmin-mcp.example.com \
  -H "Authorization: Bearer <UPSTREAM_TOKEN>" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Local development

Put the local secret in `.dev.vars` (git-ignored):

```dotenv
UPSTREAM_TOKEN=localtest
```

```bash
npm run dev                 # wrangler dev on http://localhost:8787
npm run typecheck           # tsc --noEmit over src/
npm test                    # every test/*.test.mts, each in its own process
```

`npm run dev` uses a local KV, separate from the deployed one. `wrangler kv key …` commands write to that local KV when you pass `--local` or no flag at all; only `--remote` reaches the deployed namespace. The local KV starts empty, so `initialize`, `tools/list` and `ping` work, and `tools/call` answers `sin sesion de Garmin`. To try the cron locally, run `npm run dev -- --test-scheduled` and `curl "http://localhost:8787/__scheduled?cron=0+*/6+*+*+*"`. Never load the production `garmin_tokens.json` into the local KV (with `--local`): a local refresh would replace its refresh token and leave the deployed Worker without a session.

## Troubleshooting

| Symptom | Resolution |
|---|---|
| `401 Unauthorized` | Send `Authorization: Bearer <UPSTREAM_TOKEN>`; check the secret is set. |
| `405 Method Not Allowed` | Use `POST`; `GET` and SSE are not supported. |
| `garmin-mcp-auth` exits with `Login sin tokens DI validos` | Garmin completed the login but returned no usable DI tokens, usually because python-garminconnect fell back to a web session. Nothing was saved, and the session in KV is unchanged. Try again later. |
| Tool result `sin sesion de Garmin: ejecuta garmin-mcp-auth y carga el token en KV` | KV has no valid session. Repeat setup steps 1 and 3. |
| Tool result `sesion de Garmin caducada: el refresco programado esta fallando…` | The scheduled refresh has been failing. Check the Worker logs for `refresco…` lines. |
| Log `refresco rechazado: ejecuta garmin-mcp-auth (HTTP 400)` or `401` | Garmin rejected the refresh token, because it expired or was refreshed somewhere else. Repeat setup steps 1 and 3. |
| Log `refresco fallido (HTTP 403)` on every run | diauth is blocking the Worker's requests. The config is fine; the block is on Garmin's side. |
| Log `refresco hecho pero no se pudo guardar en KV` | The new refresh token was lost. Repeat setup steps 1 and 3. |
| `Garmin 4xx/5xx en /path` | Garmin rejected the call. If an endpoint moved, update `src/tools.ts`. |

Logs are in the Cloudflare dashboard (`observability` is enabled in `wrangler.jsonc`).

## Security and limitations

- Anyone with `UPSTREAM_TOKEN` can read the account's health data and create or delete workouts. Keep it secret and restrict portal access to your own identity.
- Each deployment serves a single Garmin account.
- Only `garmin.com` accounts are supported (not `garmin.cn`).
- The Garmin session is stored in Workers KV. Anyone with access to your Cloudflare account can read it.
- Responses are unfiltered Garmin JSON and can be large.
- The Workers free plan allows 100,000 requests per day.

## Further reading

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): transport, authentication, endpoints, project layout, and adding a tool
- [DESPLIEGUE.md](DESPLIEGUE.md): deployment guide, in Spanish
