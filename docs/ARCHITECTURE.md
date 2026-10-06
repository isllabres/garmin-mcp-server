# Architecture

This document describes how garmin-mcp-server works internally. For setup and usage, see the [README](../README.md).

## Design

```
Claude ──► MCP portal (Cloudflare Access + your IdP) ──► Worker ──► connectapi.garmin.com
                  injects the Bearer token               checks it  Bearer from the KV session
Cron Trigger (every 6 h) ──► Worker ──► diauth.garmin.com: refresh, rotated tokens → KV
```

The server is a single Cloudflare Worker sized for the free tier. It needs no container, Docker, Durable Objects or paid bindings, and it has no runtime dependencies.

The Garmin login (SSO and MFA) is deliberately kept out of the Worker. It runs once on the user's machine with `garmin-mcp-auth` in `auth/` (python-garminconnect 0.3.17), which saves Garmin's DI OAuth2 tokens. The user loads that file into the `GARMIN_KV` namespace under the key `tokens`. At runtime the Worker does two things:

1. `tools/call` reads the session from KV on every call and sends `GET`, `POST` and `DELETE` requests to `connectapi.garmin.com` with the access token as Bearer. Requests never refresh.
2. A Cron Trigger refreshes the access token at `diauth.garmin.com` and writes the rotated tokens back to KV. It is the only writer.

The data endpoints and user agents come from [garth](https://github.com/matin/garth) 0.8.0 and [python-garminconnect](https://github.com/cyberjunky/python-garminconnect) 0.3.2. The DI refresh request comes from python-garminconnect 0.3.17 (`_refresh_di_token`). The `/splits` and `/exerciseSets` endpoints behind `get_activity_splits` and `get_activity_exercise_sets` were checked against python-garminconnect 0.3.16.

## MCP transport

- The transport is stateless Streamable HTTP. Each `POST` receives a single `application/json` response. There is no SSE stream and no session ID.
- The protocol version is `2025-06-18`. The server supports `initialize`, `ping`, `tools/list`, `tools/call` and notifications. A notification receives `202 Accepted` with no body.
- JSON-RPC batches (arrays) are accepted. Notifications are left out of the reply, and a batch made only of notifications returns `202`. Each batch item that is not a JSON object gets its own `-32600` entry, with `id: null`, next to the responses for the valid items. An empty batch `[]` gets a single `-32600` error, not an array.
- Requests are checked in this order:

  | Condition | Response |
  |---|---|
  | Missing or wrong Bearer token | HTTP `401` |
  | Method other than `POST` | HTTP `405` |
  | Malformed JSON body | HTTP `400`, JSON-RPC `-32700` |
  | Message that is not a JSON object (`null`, a number, a string, a boolean, or an array inside a batch), or an empty batch | HTTP `200`, JSON-RPC `-32600` with `id: null` |
  | Unknown method | JSON-RPC `-32601` |
  | Unknown tool | JSON-RPC `-32602` |

- The Bearer token is compared in constant time by `isAuthorized` in `src/auth.ts`, with `crypto.subtle.timingSafeEqual`. A missing or empty `UPSTREAM_TOKEN` rejects every request, and a token of the wrong length gets `401` without an exception.
- A tool failure, such as a Garmin error or a missing or expired session, is returned as a result with `isError: true`, not as a protocol error. The model sees the message and can react to it. `initialize`, `ping` and `tools/list` never need a session.

## Garmin authentication

- **The session.** `GARMIN_KV`, key `tokens`, holds `garmin_tokens.json` as python-garminconnect writes it: `{di_token, di_refresh_token, di_client_id}`. `parseTokens` in `src/tokens.ts` accepts it only if the three fields are non-empty strings and `di_token` is a JWT whose payload has a finite numeric `exp`. Its error never quotes the stored value.
- **Requests.** `connectapi()` in `src/garmin.ts` reads the session on every call, after the handler has validated its arguments; there is no per-isolate token cache. It sends `Authorization: Bearer <di_token>`, `User-Agent: GCM-iOS-5.22.1.4` and `NK: NT`, and Garmin rejects requests without these headers.
  - A missing or malformed session gives `isError` `sin sesion de Garmin: ejecuta garmin-mcp-auth y carga el token en KV`.
  - An access token with 60 s or less left gives `sesion de Garmin caducada: el refresco programado esta fallando; revisa los logs o ejecuta garmin-mcp-auth`.

  Neither case calls Garmin. The user's `displayName` is cached per isolate.
- **Refresh.** `scheduled` in `src/index.ts` runs `refreshSession` (`src/refresh.ts`) every 6 h (`triggers.crons` in `wrangler.jsonc`). It refreshes only when the access token has less than 12 h left.
  - The request is `POST https://diauth.garmin.com/di-oauth2-service/oauth/token`, with the form body `grant_type=refresh_token`, `client_id`, `refresh_token`, `Authorization: Basic base64(client_id + ":")` and the Android app's headers (`User-Agent: GCM-Android-5.23`, `X-Garmin-User-Agent`, …).
  - The access token lasts about 25 h, the refresh token 30 days, and Garmin returns a new refresh token on every refresh. So the cron refreshes about every 18 h, with about 6.9 h to spare, and the session survives one failed run.
  - The clock is `Date.now()`, not `controller.scheduledTime`.
- **Single writer.** Only the cron writes KV, so isolates never race to rotate the same refresh token. KV's eventual consistency is harmless, because a stale read still has hours of validity. On a 200, the new tokens go through `parseTokens` and are written before anything else. A missing, null or empty `refresh_token` keeps the stored one. The `di_client_id` is the stored one; python-garminconnect also re-reads it from the new token's `client_id` claim.
- **Failures** leave KV untouched and log fixed text with at most the status code, never a token or a body:

  | Response | Log | Meaning |
  |---|---|---|
  | 400 / 401 | `refresco rechazado: ejecuta garmin-mcp-auth (HTTP n)` | The refresh token was rejected: log in again. |
  | Other non-2xx, a network error, or a 2xx without usable tokens | `refresco fallido (…): se reintenta en la proxima pasada` | Transient: the next run retries. A 403 on every run means diauth is blocking the Worker. |
  | The KV write fails after a 200 | `refresco hecho pero no se pudo guardar en KV: ejecuta garmin-mcp-auth` | The rotated refresh token is lost: log in again. |
- **Rotation hazard.** Anything else that refreshes with the same refresh token rotates it and kills the Worker's copy. That includes a local script with the same file, or a local `wrangler dev` holding the production token. For the same reason `garmin-mcp-auth` always logs in with credentials and never passes a tokenstore to python-garminconnect's `login()`, which would reuse, or even refresh, an existing `garmin_tokens.json` whose refresh token the cron may already have rotated.

## Tool endpoints

Tool descriptions are written in Spanish because the model reads them. Each tool calls one Garmin endpoint:

| Tool | Garmin endpoint |
|---|---|
| `get_sleep_data` | `GET /wellness-service/wellness/dailySleepData/{displayName}?date=…&nonSleepBufferMinutes=60` |
| `get_hrv_data` | `GET /hrv-service/hrv/{date}` |
| `get_training_readiness` | `GET /metrics-service/metrics/trainingreadiness/{date}` |
| `get_body_battery` | `GET /wellness-service/wellness/bodyBattery/reports/daily?startDate=…&endDate=…` |
| `get_stress_data` | `GET /wellness-service/wellness/dailyStress/{date}` |
| `get_activities` | `GET /activitylist-service/activities/search/activities?start=…&limit=…` |
| `get_activity` | `GET /activity-service/activity/{id}` |
| `get_activity_splits` | `GET /activity-service/activity/{id}/splits` |
| `get_activity_exercise_sets` | `GET /activity-service/activity/{id}/exerciseSets` |
| `upload_workout` | `POST /workout-service/workout` |
| `schedule_workout` | `POST /workout-service/schedule/{id}` with body `{"date": …}` |
| `get_scheduled_workouts` | `GET /calendar-service/year/{year}/month/{month - 1}` |
| `delete_workout` | `DELETE /workout-service/workout/{id}` |
| `get_user_settings` | `GET /userprofile-service/userprofile/user-settings` |

Garmin indexes sleep data by the user's `displayName`, not by date alone. The Worker reads the name once from `/userprofile-service/socialProfile` and caches it.

Before any request, each handler validates every argument that goes into the URL with `idArg`, `dateArg` or `intArg` from `src/validate.ts`. The rules are:

- dates are real `YYYY-MM-DD` dates;
- ids are positive integers, given as a digit-only string or a number;
- `year`, `month`, `start` and `limit` are integer JSON numbers, so `"3"` and `2.5` are rejected;
- `month` is 1–12, `year` is 1000–9999, `start` is at least 0 (default 0), and `limit` is at least 1 (default 20, no upper cap);
- `get_body_battery` also rejects a `start_date` later than its `end_date`.

Invalid input becomes an `isError` result with a message such as `month invalido: debe ser un entero entre 1 y 12`, and Garmin is never called. This stops a crafted argument such as `../../userprofile-service/socialProfile` from reaching a different endpoint.

## Project layout

```
src/index.ts                  Worker entry point: Bearer check, JSON-RPC/MCP dispatch
src/garmin.ts                 Garmin client: KV session read, connectapi(), displayName()
src/tokens.ts                 KV session: parseTokens, TOKENS_KEY, the no-session and expired messages
src/refresh.ts                Cron refresh: refreshSession, the DI refresh request, failure logs
src/tools.ts                  Tool definitions: name, description, JSON Schema, handler
src/validate.ts               Argument validation: idArg, dateArg, intArg
src/auth.ts                   Bearer check: isAuthorized, constant-time comparison
test/validate.test.mts        Validation rules: format, calendar, sign, range and type
test/tools.test.mts           Tool requests: invalid arguments never reach fetch; valid ones build today's URLs
test/jsonrpc.test.mts         JSON-RPC framing: messages that are not objects and the empty batch get -32600
test/activity-tools.test.mts  Activity detail tools: registration, schema, endpoints, descriptions, invalid ids
test/auth.test.mts            Bearer check: correct token, comparator decides, wrong length, missing header or secret
test/kv-session.test.mts      Request path: KV session read per call, no refresh, no-session and expired isError
test/cron.test.mts            Cron: refresh request, rotated tokens stored first, 12 h threshold, failures, no secrets
test/fakes.mts                Test helpers: in-memory KV, JWT fixtures, log capture
test/workers-crypto.mts       Test shim: node:crypto's timingSafeEqual on crypto.subtle, for tests that call worker.fetch
auth/                         garmin-mcp-auth: one-time Garmin login with python-garminconnect, writes garmin_tokens.json
wrangler.jsonc                Worker config: name, KV binding, cron trigger, observability
docs/ARCHITECTURE.md          This document
DESPLIEGUE.md                 Deployment guide (Spanish)
```

## Testing

Tests are standalone Node scripts in `test/`, and none of them touches the network. `npm test` runs every `test/*.test.mts` in its own `node` process, prints each file's name before its output, and exits non-zero if any file fails, after running them all. To run a single file, use `node <file>`; don't pass several files to one `node`, which treats the extra files as arguments to the first. Relative imports in `src/` carry the `.ts` extension, so the tests can import any module. A test that calls `worker.fetch` must import `./workers-crypto.mts` before `src/index.ts`: Node has no `crypto.subtle.timingSafeEqual`, and that shim installs `node:crypto`'s version only when it is missing.

- `test/validate.test.mts` checks the rules in `src/validate.ts` one by one. They include coercion traps such as `[123]` and `1e21`, and calendar rollover such as `2026-02-30`.
- `test/tools.test.mts` runs the tool handlers against a recording `fetch` stub and an in-memory KV holding a valid session. Invalid arguments must fail before any `fetch` or KV read, including `displayName()`. Valid arguments must build exactly today's method, URL and body. It also sends a `tools/call` through `src/index.ts` with an empty KV and checks that a validation failure comes back as its own `isError`, not the no-session one.
- `test/jsonrpc.test.mts` sends raw bodies to the Worker's `fetch` handler. The global `fetch` is replaced by a stub that throws, so nothing reaches the network. A single message that is not an object (`null`, a number, a string, a boolean) and an empty batch must get HTTP `200` with `-32600` and `id: null`. In a batch, each such item, including `null` and a nested array, gets its own `-32600` entry, and a batch made only of notifications still gets `202` with no body.
- `test/activity-tools.test.mts` covers `get_activity_splits` and `get_activity_exercise_sets`. Both must be registered with the same required `activity_id` schema as `get_activity`, and send exactly one `GET` to `/splits` or `/exerciseSets`, returning Garmin's JSON unchanged. `get_activity`'s description must not promise laps or sets and must name both tools, and the three descriptions must have no diacritics. Through `tools/call`, an invalid `activity_id` must give the same `isError` text as `get_activity`, with no `fetch` at all.
- `test/auth.test.mts` checks `isAuthorized` with `node:crypto`'s `timingSafeEqual` injected as the comparator. The correct token is accepted; a stub comparator decides the verdict, so a return to `===` fails; a wrong token of any length, including a multibyte one, is rejected without throwing; and a missing header or a missing or empty `UPSTREAM_TOKEN` is rejected. The Workers primitive itself is checked only by `npm run typecheck` and a manual `wrangler dev` run.
- `test/kv-session.test.mts` drives `worker.fetch` with an in-memory KV. `initialize`, `ping` and `tools/list` must read neither KV nor the network. `tools/call` must send the KV access token as Bearer with today's headers, re-read KV on every call, and never refresh or write. A missing, malformed or expired session must give the exact `isError` text without calling Garmin and without leaking the stored value.
- `test/cron.test.mts` drives `worker.scheduled`. It checks:
  - the exact refresh request;
  - that the rotated tokens are written right after a 200, with the stored refresh token kept when none comes back;
  - the 12 h threshold, and that a bad session makes no network call;
  - the rejected, transient, unusable-200 and failed-write paths;
  - that no console line, thrown error or `waitUntil` rejection ever contains a token.
- `test/fakes.mts` is not a test. It holds the in-memory KV with an event log, the JWT and token fixtures, and the log capture. Every fixture token contains the marker `SECRETO`, so one `includes` check catches a leak.

`npm run typecheck` runs `tsc --noEmit` over `src/` against `@cloudflare/workers-types`.

## Adding a tool

Add an entry to the `TOOLS` array in `src/tools.ts`:

```ts
{
  name: "get_something",
  description: "What it returns and when the model should use it.",
  inputSchema: obj({ date: DATE }, ["date"]),
  handler: async (t, a) => {
    const date = dateArg(a.date, "date");
    return connectapi(t, `/some-service/some/${date}`);
  },
},
```

`t` is the KV namespace; `connectapi(t, …)` reads the session only after the handler has validated its arguments. Validate every argument that goes into the URL as the handler's first statement. The type checker doesn't catch a raw `${a.date}`, so add a row for the tool to Test 10 in `test/tools.test.mts`. `tools/list` and `tools/call` pick the tool up automatically through `TOOLS` and `TOOL_MAP`.
