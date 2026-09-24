# garmin-mcp-server

An [MCP](https://modelcontextprotocol.io) server that gives Claude, or any MCP client, access to a Garmin Connect account through 12 tools: recovery data (sleep, HRV, training readiness, Body Battery, stress), activities, and workouts. It runs as a single Cloudflare Worker on the free tier, with no runtime dependencies.

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
| `get_activity` | `activity_id` | Details of one activity |
| `upload_workout` | `workout` (Garmin workout DTO) | Creates a workout; returns `workoutId` |
| `schedule_workout` | `workout_id`, `date` | Adds a workout to the calendar |
| `get_scheduled_workouts` | `year`, `month` (1–12) | Calendar items for a month |
| `delete_workout` | `workout_id` | Deletes a workout |
| `get_user_settings` | none | FTP, power and HR zones, weight, thresholds |

- To set strength loads in kilograms, use `upload_workout` and add `weightValue` and `weightUnit: {"unitId": 8, "unitKey": "kilogram", "factor": 1000}` to each step.
- `get_scheduled_workouts` converts the month to Garmin's 0–11 numbering.

## Requirements

- A Cloudflare account, with a domain on Cloudflare for the default route
- Node.js 22 or later (22.18+ or 23.6+ to run the tests)
- [uv](https://docs.astral.sh/uv/)
- A Garmin Connect account

## Setup

1. **Generate the Garmin token** once, on your machine. It is valid for about a year.

   ```bash
   uvx --python 3.12 --from git+https://github.com/Taxuspt/garmin_mcp garmin-mcp-auth
   cat ~/.garminconnect/oauth1_token.json
   ```

2. **Fetch the OAuth consumer credentials** (recommended). Otherwise, the Worker downloads them from a third-party S3 bucket on each cold start.

   ```bash
   curl -s https://thegarth.s3.amazonaws.com/oauth_consumer.json
   # {"consumer_key": "...", "consumer_secret": "..."}
   ```

3. **Store the secrets.**

   ```bash
   npm install
   npx wrangler secret put GARMIN_OAUTH1 < ~/.garminconnect/oauth1_token.json
   npx wrangler secret put UPSTREAM_TOKEN          # e.g. openssl rand -hex 32
   npx wrangler secret put GARMIN_CONSUMER_KEY
   npx wrangler secret put GARMIN_CONSUMER_SECRET
   ```

   | Secret | Required | Purpose |
   |---|---|---|
   | `GARMIN_OAUTH1` | Yes | Contents of `oauth1_token.json` |
   | `UPSTREAM_TOKEN` | Yes | Bearer token that clients must send |
   | `GARMIN_CONSUMER_KEY`, `GARMIN_CONSUMER_SECRET` | Recommended | OAuth1 consumer credentials |

4. **Deploy.** In `wrangler.jsonc`, replace the placeholder domain `garmin-mcp.TUDOMINIO.com` with your own. Then run:

   ```bash
   npm run typecheck
   npm run deploy   # wrangler deploy
   ```

   Without a domain on Cloudflare, set `"workers_dev": true` and remove `routes` to serve the Worker at `https://garmin-mcp.<your-subdomain>.workers.dev`.

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

Put local secrets in `.dev.vars` (git-ignored):

```dotenv
GARMIN_OAUTH1={"oauth_token":"...","oauth_token_secret":"..."}
UPSTREAM_TOKEN=localtest
GARMIN_CONSUMER_KEY=...
GARMIN_CONSUMER_SECRET=...
```

```bash
npm run dev                 # wrangler dev on http://localhost:8787
npm run typecheck           # tsc --noEmit over src/
node test/oauth1.test.mts   # OAuth1 signature test
```

`initialize`, `tools/list` and `ping` work with placeholder secrets; `tools/call` needs a valid Garmin token. The test may print a harmless `MODULE_TYPELESS_PACKAGE_JSON` warning.

## Troubleshooting

| Symptom | Resolution |
|---|---|
| `401 Unauthorized` | Send `Authorization: Bearer <UPSTREAM_TOKEN>`; check the secret is set. |
| `405 Method Not Allowed` | Use `POST`; `GET` and SSE are not supported. |
| `500` with `GARMIN_OAUTH1 no es un oauth1_token.json valido` | Upload the full `oauth1_token.json` as `GARMIN_OAUTH1`. |
| `Refresco de token fallido (401)` | The OAuth1 token expired. Repeat setup steps 1 and 3. |
| `No se pudo leer el oauth_consumer` | Set `GARMIN_CONSUMER_KEY` and `GARMIN_CONSUMER_SECRET` (setup step 2). |
| `Garmin 4xx/5xx en /path` | Garmin rejected the call. If an endpoint moved, update `src/tools.ts`. |

Logs are in the Cloudflare dashboard (`observability` is enabled in `wrangler.jsonc`).

## Security and limitations

- Anyone with `UPSTREAM_TOKEN` can read the account's health data and create or delete workouts. Keep it secret and restrict portal access to your own identity.
- Each deployment serves a single Garmin account.
- Only `garmin.com` accounts are supported (not `garmin.cn`); the `domain` field of `oauth1_token.json` is ignored.
- Responses are unfiltered Garmin JSON and can be large.
- The Workers free plan allows 100,000 requests per day.

## Further reading

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): transport, authentication, endpoints, project layout, and adding a tool
- [DESPLIEGUE.md](DESPLIEGUE.md): deployment guide, in Spanish
