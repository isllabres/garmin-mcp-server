# Architecture

This document describes how garmin-mcp-server works internally. For setup and usage, see the [README](../README.md).

## Design

```
Claude ──► MCP portal (Cloudflare Access + your IdP) ──► Worker ──► connectapi.garmin.com
                  injects the Bearer token               checks it  OAuth1 → OAuth2 → REST
```

The server is a single Cloudflare Worker sized for the free tier. It needs no container, Docker, Durable Objects or paid bindings, and it has no runtime dependencies.

The Garmin login (SSO, MFA and a WebView user agent) is deliberately kept out of the Worker. It runs once on the user's machine and produces a long-lived OAuth1 token, which the Worker stores as a secret. At runtime the Worker performs only two operations:

1. A signed OAuth1 (HMAC-SHA1) `POST` that exchanges the OAuth1 token, valid for about a year, for an OAuth2 access token, valid for about an hour.
2. `GET`, `POST` and `DELETE` requests to `connectapi.garmin.com` with that Bearer token.

The endpoints, user agents and exchange flow come from [garth](https://github.com/matin/garth) 0.8.0 and [python-garminconnect](https://github.com/cyberjunky/python-garminconnect) 0.3.2. The `/splits` and `/exerciseSets` endpoints behind `get_activity_splits` and `get_activity_exercise_sets` were checked against python-garminconnect 0.3.16.

## MCP transport

- The transport is stateless Streamable HTTP. Each `POST` receives a single `application/json` response. There is no SSE stream and no session ID.
- The protocol version is `2025-06-18`. The server supports `initialize`, `ping`, `tools/list`, `tools/call` and notifications. A notification receives `202 Accepted` with no body.
- JSON-RPC batches (arrays) are accepted. Notifications are left out of the reply, and a batch made only of notifications returns `202`. Each batch item that is not a JSON object gets its own `-32600` entry, with `id: null`, next to the responses for the valid items. An empty batch `[]` gets a single `-32600` error, not an array.
- Requests are checked in this order:

  | Condition | Response |
  |---|---|
  | Missing or wrong Bearer token | HTTP `401` |
  | Method other than `POST` | HTTP `405` |
  | `GARMIN_OAUTH1` is not a valid `oauth1_token.json` | HTTP `500`, JSON-RPC `-32603` |
  | Malformed JSON body | HTTP `400`, JSON-RPC `-32700` |
  | Message that is not a JSON object (`null`, a number, a string, a boolean, or an array inside a batch), or an empty batch | HTTP `200`, JSON-RPC `-32600` with `id: null` |
  | Unknown method | JSON-RPC `-32601` |
  | Unknown tool | JSON-RPC `-32602` |

- A tool failure, such as a Garmin error or an expired token, is returned as a result with `isError: true`, not as a protocol error. The model sees the message and can react to it.

## Garmin authentication

- `exchange()` in `src/garmin.ts` signs a `POST` to `/oauth-service/oauth/exchange/user/2.0` with OAuth1/HMAC-SHA1, using Web Crypto. It follows `garth.sso.exchange`.
- The OAuth2 token is cached per isolate and refreshed 60 seconds before it expires, so no request starts with a token that is about to expire. The consumer credentials and the user's `displayName` are cached the same way. When an isolate is recycled, the next request performs one extra exchange.
- Without `GARMIN_CONSUMER_KEY` and `GARMIN_CONSUMER_SECRET`, the consumer credentials are downloaded from `https://thegarth.s3.amazonaws.com/oauth_consumer.json`.
- API requests send `User-Agent: GCM-iOS-5.22.1.4` and `NK: NT`. The token exchange sends `User-Agent: com.garmin.android.apps.connectmobile`. Garmin rejects requests without these headers.

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
src/garmin.ts                 Garmin client: OAuth1 signing, OAuth2 exchange, caching, connectapi()
src/tools.ts                  Tool definitions: name, description, JSON Schema, handler
src/validate.ts               Argument validation: idArg, dateArg, intArg
test/oauth1.test.mts          OAuth1 signature test against the canonical vector
test/exchange-mfa.test.mts    Token exchange test: mfa_token in the form body and the signature
test/validate.test.mts        Validation rules: format, calendar, sign, range and type
test/tools.test.mts           Tool requests: invalid arguments never reach fetch; valid ones build today's URLs
test/jsonrpc.test.mts         JSON-RPC framing: messages that are not objects and the empty batch get -32600
test/activity-tools.test.mts  Activity detail tools: registration, schema, endpoints, descriptions, invalid ids
wrangler.jsonc                Worker config: name, route, observability
docs/ARCHITECTURE.md          This document
DESPLIEGUE.md                 Deployment guide (Spanish)
```

## Testing

Tests are standalone Node scripts in `test/`, and none of them touches the network. `npm test` runs every `test/*.test.mts` in its own `node` process, prints each file's name before its output, and exits non-zero if any file fails, after running them all. To run a single file, use `node <file>`; don't pass several files to one `node`, which treats the extra files as arguments to the first. Relative imports in `src/` carry the `.ts` extension, so the tests can import any module.

- `test/oauth1.test.mts` checks RFC 3986 percent-encoding and the OAuth1 HMAC-SHA1 signature against the canonical OAuth 1.0a test vector, Twitter's documented example. It builds the signature base string the same way `exchange()` does.
- `test/exchange-mfa.test.mts` runs `connectapi()` against a stubbed `fetch` and checks the token exchange request it captures. When `mfa_token` is set, it must be in the form body and in the signature, but not in the `Authorization` header. Accounts without MFA must send an unchanged request. The test verifies each signature the way Garmin's server would (RFC 5849).
- `test/validate.test.mts` checks the rules in `src/validate.ts` one by one. They include coercion traps such as `[123]` and `1e21`, and calendar rollover such as `2026-02-30`.
- `test/tools.test.mts` runs the tool handlers against a recording `fetch` stub. Invalid arguments must fail before any `fetch`, including the OAuth exchange and `displayName()`. Valid arguments must build exactly today's method, URL and body. It also sends a `tools/call` through `src/index.ts` and checks that a validation failure comes back as `isError`.
- `test/jsonrpc.test.mts` sends raw bodies to the Worker's `fetch` handler. The global `fetch` is replaced by a stub that throws, so nothing reaches the network. A single message that is not an object (`null`, a number, a string, a boolean) and an empty batch must get HTTP `200` with `-32600` and `id: null`. In a batch, each such item, including `null` and a nested array, gets its own `-32600` entry, and a batch made only of notifications still gets `202` with no body.
- `test/activity-tools.test.mts` covers `get_activity_splits` and `get_activity_exercise_sets`. Both must be registered with the same required `activity_id` schema as `get_activity`, and send exactly one `GET` to `/splits` or `/exerciseSets`, returning Garmin's JSON unchanged. `get_activity`'s description must not promise laps or sets and must name both tools, and the three descriptions must have no diacritics. Through `tools/call`, an invalid `activity_id` must give the same `isError` text as `get_activity`, with no `fetch` at all.

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

Validate every argument that goes into the URL as the handler's first statement. The type checker doesn't catch a raw `${a.date}`, so add a row for the tool to Test 10 in `test/tools.test.mts`. `tools/list` and `tools/call` pick the tool up automatically through `TOOLS` and `TOOL_MAP`.
