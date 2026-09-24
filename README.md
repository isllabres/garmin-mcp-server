# garmin-mcp-server

A small [Model Context Protocol](https://modelcontextprotocol.io) server that
gives Claude (or any MCP client) access to your **Garmin Connect** account.
It runs as a **Cloudflare Worker on the free tier**: no container, no Docker,
no Durable Objects, no paid bindings, and no runtime dependencies.

It exposes 12 tools. They read recovery data (sleep, HRV, training readiness,
Body Battery, stress) and activities, and they can write workouts (create,
schedule, list, delete). This is enough for an assistant to adjust a training
plan to how you actually recovered.

```
Claude ──► MCP portal (Cloudflare Access + your IdP) ──► Worker ──► connectapi.garmin.com
                  injects the Bearer token               checks it  OAuth1 → OAuth2 → REST
```

> **Unofficial API.** This talks to the same private endpoints the Garmin
> Connect mobile app uses. Garmin can change them at any time, and can suspend
> accounts that use them. Use at your own risk.

## Why it's this small

The hard part of talking to Garmin is logging in: SSO, MFA, and a WebView
user agent. **That part doesn't run here.** You log in once on your own
machine with an existing tool, which saves a long-lived OAuth1 token, and you
upload that token as a Worker secret. At runtime the Worker only needs two
things:

1. A signed OAuth1 (HMAC-SHA1) `POST` that exchanges the OAuth1 token (valid
   for about a year) for an OAuth2 access token (valid for about an hour).
2. Plain `GET`/`POST`/`DELETE` calls to `connectapi.garmin.com` with that
   Bearer token.

The endpoints, user agents and exchange flow were taken from
[garth](https://github.com/matin/garth) 0.8.0 and
[python-garminconnect](https://github.com/cyberjunky/python-garminconnect) 0.3.2.

## Tools

All dates are `YYYY-MM-DD`. Every tool returns Garmin's raw JSON response as
text. Tool descriptions are written in Spanish, since the model reads them.

### Recovery and wellness

| Tool | Arguments | What it returns | Garmin endpoint |
|---|---|---|---|
| `get_sleep_data` | `date` | Sleep stages, duration, sleep score, resting HR | `/wellness-service/wellness/dailySleepData/{displayName}` |
| `get_hrv_data` | `date` | Overnight HRV and its status against your baseline | `/hrv-service/hrv/{date}` |
| `get_training_readiness` | `date` | Readiness score (0–100) and what went into it | `/metrics-service/metrics/trainingreadiness/{date}` |
| `get_body_battery` | `start_date`, `end_date` | Body Battery per day: charged and drained | `/wellness-service/wellness/bodyBattery/reports/daily` |
| `get_stress_data` | `date` | Stress over the day on Garmin's 0–100 scale | `/wellness-service/wellness/dailyStress/{date}` |

### Activities

| Tool | Arguments | What it returns | Garmin endpoint |
|---|---|---|---|
| `get_activities` | `start` (default 0), `limit` (default 20) | Recent activities, newest first | `/activitylist-service/activities/search/activities` |
| `get_activity` | `activity_id` | Details of one activity | `/activity-service/activity/{id}` |

### Workouts and settings

| Tool | Arguments | What it does | Garmin endpoint |
|---|---|---|---|
| `upload_workout` | `workout` (Garmin workout DTO) | Creates a workout and returns its `workoutId` | `POST /workout-service/workout` |
| `schedule_workout` | `workout_id`, `date` | Adds an existing workout to the calendar | `POST /workout-service/schedule/{id}` |
| `get_scheduled_workouts` | `year`, `month` (1–12) | Calendar items for a month | `/calendar-service/year/{y}/month/{m-1}` |
| `delete_workout` | `workout_id` | Deletes a workout | `DELETE /workout-service/workout/{id}` |
| `get_user_settings` | none | Profile settings: FTP, power and HR zones, weight, thresholds | `/userprofile-service/userprofile/user-settings` |

Notes:

- **Strength loads in kg.** `upload_workout` takes the raw DTO. That makes it
  the only way to set weights on strength steps: add
  `weightValue` and `weightUnit: {"unitId": 8, "unitKey": "kilogram", "factor": 1000}`
  to each step.
- **Months.** Garmin's calendar numbers months 0–11. `get_scheduled_workouts`
  takes a normal 1–12 month and converts it for you.
- **Sleep.** Garmin looks up sleep by the user's `displayName`, not only by
  date. The Worker fetches the name once from
  `/userprofile-service/socialProfile` and caches it.

## Requirements

- A Cloudflare account. A domain on Cloudflare is needed for the default
  custom-domain route; see [Deploy](#4-deploy) for the `workers.dev` option.
- Node.js ≥ 22, which Wrangler 4 requires. The test script needs a Node
  version that runs TypeScript directly (22.18+ or 23.6+).
- [uv](https://docs.astral.sh/uv/), used once to generate the Garmin token.
- A Garmin Connect account.

## Setup

### 1. Get a Garmin OAuth1 token (once, on your machine)

```bash
uvx --python 3.12 --from git+https://github.com/Taxuspt/garmin_mcp garmin-mcp-auth
cat ~/.garminconnect/oauth1_token.json
```

The whole JSON file is the secret. It lasts about a year.

### 2. Pin the OAuth consumer credentials (recommended)

If you don't set these, the Worker downloads the consumer key and secret from
a third-party S3 bucket (`thegarth.s3.amazonaws.com`) on every cold start. If
that bucket goes away, your server stops working. Fetch them once:

```bash
curl -s https://thegarth.s3.amazonaws.com/oauth_consumer.json
# {"consumer_key": "...", "consumer_secret": "..."}
```

### 3. Upload the secrets

```bash
npm install
npx wrangler secret put GARMIN_OAUTH1 < ~/.garminconnect/oauth1_token.json
npx wrangler secret put UPSTREAM_TOKEN          # e.g. the output of: openssl rand -hex 32
npx wrangler secret put GARMIN_CONSUMER_KEY     # from step 2
npx wrangler secret put GARMIN_CONSUMER_SECRET  # from step 2
```

| Secret | Required | Purpose |
|---|---|---|
| `GARMIN_OAUTH1` | yes | Contents of `oauth1_token.json` (`oauth_token`, `oauth_token_secret`) |
| `UPSTREAM_TOKEN` | yes | Shared Bearer token. Any request without `Authorization: Bearer <UPSTREAM_TOKEN>` gets a 401 |
| `GARMIN_CONSUMER_KEY` | recommended | OAuth1 consumer key. Removes the dependency on the S3 bucket |
| `GARMIN_CONSUMER_SECRET` | recommended | OAuth1 consumer secret |

### 4. Deploy

Replace the placeholder domain in `wrangler.jsonc` with your own:

```jsonc
"routes": [
  { "pattern": "garmin-mcp.example.com", "custom_domain": true }
]
```

If you don't have a domain on Cloudflare, set `"workers_dev": true` and remove
`routes`. The Worker is then served at `https://garmin-mcp.<your-subdomain>.workers.dev`.

```bash
npm run typecheck
npm run deploy
```

### 5. Connect a client

**Through a Cloudflare MCP portal (recommended).** Claude's clients don't
forward custom headers to remote MCP servers (see
[cloudflare/mcp#95](https://github.com/cloudflare/mcp/issues/95)). A portal
solves this: it handles authentication and injects the Bearer token on the
server side.

1. In **Cloudflare One → AI Controls → MCP server portals**, create a portal
   (CNAME to `gateway.agents.cloudflare.com`).
2. Add an upstream server pointing at your Worker URL, with transport
   **Streamable HTTP** and the header `Authorization: Bearer <UPSTREAM_TOKEN>`.
3. Set the Access policy to **your own email only**.
4. Add the portal URL to Claude as a custom connector.

**Directly.** The Worker checks the Bearer token on its own, so any client
that can send custom headers can connect directly. For example, Claude Code:

```bash
claude mcp add --transport http garmin https://garmin-mcp.example.com \
  --header "Authorization: Bearer <UPSTREAM_TOKEN>"
```

### Smoke test

```bash
# No token: expect 401
curl -s -o /dev/null -w "%{http_code}\n" https://garmin-mcp.example.com

# List the tools
curl -s -X POST https://garmin-mcp.example.com \
  -H "Authorization: Bearer <UPSTREAM_TOKEN>" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Local development

Wrangler reads local secrets from `.dev.vars`, which is git-ignored:

```dotenv
GARMIN_OAUTH1={"oauth_token":"...","oauth_token_secret":"..."}
UPSTREAM_TOKEN=localtest
GARMIN_CONSUMER_KEY=...
GARMIN_CONSUMER_SECRET=...
```

```bash
npm run dev    # wrangler dev, serves on http://localhost:8787
```

`initialize`, `tools/list` and `ping` work with dummy values. `tools/call`
needs a real token, because it talks to Garmin.

### Tests

```bash
node test/oauth1.test.mts
```

This checks the RFC 3986 percent-encoding and the OAuth1 HMAC-SHA1 signature
against the canonical OAuth 1.0a test vector (Twitter's documented example).
It builds the base string the same way `exchange()` in `src/garmin.ts` does.
Node may print a `MODULE_TYPELESS_PACKAGE_JSON` warning; it's harmless.

### Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Runs the Worker locally with Wrangler |
| `npm run deploy` | Deploys to Cloudflare (`wrangler deploy`) |
| `npm run typecheck` | `tsc --noEmit` against `@cloudflare/workers-types` |

## How it works

### MCP transport

- Streamable HTTP, **stateless**. Every `POST` gets a single
  `application/json` response. There is no SSE stream and no session ID.
- Protocol version `2025-06-18`. It supports `initialize`, `ping`,
  `tools/list`, `tools/call` and notifications. Notifications get
  `202 Accepted` with no body.
- It also accepts JSON-RPC batches (arrays). Notifications are dropped from
  the reply, and a batch made only of notifications returns `202`.
- Order of checks: missing or wrong Bearer → `401`. Any method other than
  `POST` → `405`. Malformed JSON → JSON-RPC `-32700`. Unknown method →
  `-32601`. Unknown tool → `-32602`.
- When a tool fails (a Garmin error, an expired token), the result comes back
  with `isError: true` instead of as a protocol error. That way the model sees
  the message and can react to it.

### Garmin authentication

- `exchange()` signs a `POST` to
  `/oauth-service/oauth/exchange/user/2.0` with OAuth1/HMAC-SHA1, using Web
  Crypto. This is the same flow as `garth.sso.exchange`.
- The OAuth2 token is cached per isolate. It is refreshed 60 seconds before it
  expires, so a request never starts with a token that expires partway
  through. The consumer credentials and `displayName` are cached the same way.
  When an isolate is recycled, the next request pays for one extra exchange.
- API calls send `User-Agent: GCM-iOS-5.22.1.4` and `NK: NT`. Garmin rejects
  requests without them.

### Project layout

```
src/index.ts          Worker entry point: Bearer check, JSON-RPC/MCP dispatch
src/garmin.ts         Minimal Garmin client: OAuth1 signing, OAuth2 exchange, caching, connectapi()
src/tools.ts          Tool definitions: name, description, JSON Schema, handler
test/oauth1.test.mts  OAuth1 signature test against the canonical vector
wrangler.jsonc        Worker config: name, route, observability
DESPLIEGUE.md         Deployment guide (Spanish)
```

### Adding a tool

Add an entry to the `TOOLS` array in `src/tools.ts`:

```ts
{
  name: "get_something",
  description: "What it returns and when the model should use it.",
  inputSchema: obj({ date: DATE }, ["date"]),
  handler: (t, a) => connectapi(t, `/some-service/some/${a.date}`),
},
```

`tools/list` and `tools/call` pick it up automatically through `TOOLS` and
`TOOL_MAP`.

## Maintenance and troubleshooting

| Symptom | Cause and fix |
|---|---|
| `401 Unauthorized` from the Worker | Missing or wrong `Authorization` header, or `UPSTREAM_TOKEN` isn't set |
| `405 Method Not Allowed` | Only `POST` is supported. The server doesn't open SSE streams on `GET` |
| `500` with `GARMIN_OAUTH1 no es un oauth1_token.json valido` | The `GARMIN_OAUTH1` secret isn't valid JSON, or it's missing `oauth_token` or `oauth_token_secret` |
| Tool error `Refresco de token fallido (401)` | The OAuth1 token has expired (about a year). Repeat steps 1 and 3 |
| Tool error `No se pudo leer el oauth_consumer` | The S3 bucket is unreachable. Set `GARMIN_CONSUMER_KEY` and `GARMIN_CONSUMER_SECRET` (step 2) |
| Tool error `Garmin 4xx/5xx en /path` | Garmin rejected the call. If an endpoint moved, update its path in `src/tools.ts` |

Logs are available in the Cloudflare dashboard, because `observability` is
enabled in `wrangler.jsonc`.

## Security and limitations

- **Full account access.** Whoever holds `UPSTREAM_TOKEN` can read all your
  health data, and can create and delete workouts. Keep the token secret. When
  you use a portal, limit the Access policy to your own identity.
- **One account per deployment.** The Garmin identity comes from a single
  secret.
- **garmin.com only.** The `domain` field in `oauth1_token.json` is ignored,
  so accounts on `garmin.cn` are not supported.
- **Raw responses.** Tool output is Garmin's JSON, unfiltered. Some responses,
  such as sleep or activity details, can be large.
- **Free-tier limits.** Workers' free plan allows 100,000 requests a day, far
  more than a personal assistant needs.
