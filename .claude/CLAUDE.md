# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`garmin-mcp-server` is a stateless [MCP](https://modelcontextprotocol.io) server that gives Claude access to a Garmin Connect account. It runs as a single **Cloudflare Worker on the free tier**: no container, no Durable Objects, no paid bindings, **zero runtime dependencies**. It exposes 12 tools: recovery data (sleep, HRV, training readiness, Body Battery, stress), activities, and workout write operations (create, schedule, list, delete).

The Garmin login (SSO + MFA) deliberately does **not** run here. It happens once on the user's machine, and the resulting long-lived OAuth1 token is uploaded as a Worker secret. At runtime the Worker only swaps OAuth1 for OAuth2 (a signed POST) and makes Bearer calls to `connectapi.garmin.com`.

`README.md` (English) is the user-facing reference: tools, setup, local development, and troubleshooting. `docs/ARCHITECTURE.md` (English) holds the internals: transport, Garmin authentication, the Garmin endpoint behind each tool, argument validation, the project layout, and how to add a tool. `DESPLIEGUE.md` is the original deployment guide, in Spanish.

## Current state of the code (read before assuming otherwise)

- **Unofficial API.** Every endpoint in `src/tools.ts` is a private Garmin Connect endpoint, taken from garth 0.8.0 and python-garminconnect 0.3.2. Nothing is contract-tested against Garmin. Don't "fix" a path or header from memory; check it against those libraries.
- **Required headers.** `connectapi()` in `src/garmin.ts` sends `User-Agent: GCM-iOS-5.22.1.4` and `NK: NT`, and the token exchange uses the `com.garmin.android.apps.connectmobile` UA. Garmin rejects requests without them. Never drop or "clean up" these.
- **Module-level caches.** `tokenCache`, `consumerCache` and `displayNameCache` in `src/garmin.ts` live per isolate and outlive a single request. Tests that import these functions share that state.
- **Tool errors are not protocol errors.** A failing tool returns `result.isError: true` with the message as text, so the model can react (`src/index.ts`). Keep JSON-RPC `error` for protocol failures only: parse errors, unknown method, unknown tool.
- **Tool arguments are validated before any request.** Every argument that goes into a URL passes through `idArg`, `dateArg` or `intArg` (`src/validate.ts`) before the handler does anything else. Invalid input returns an `isError` result without calling Garmin. The compiler doesn't enforce this, because template literals accept `unknown`; Tests 1 and 10 in `test/tools.test.mts` do, with Test 1 covering `get_activity` and Test 10 the other tools. A new tool with URL arguments therefore needs its own Test 10 row. `upload_workout`'s `workout` body is passed through unvalidated.
- **`domain` is ignored.** `OAuth1Token` reads `mfa_token`, which the exchange sends in its form body and signs, as garth does. It still ignores the `domain` field of `oauth1_token.json`, and the API domain is hard-coded to `garmin.com`.
- **Tests are not wired into npm.** The `test/*.test.mts` files are standalone scripts with no test runner and no `npm test`. `tsconfig.json` only includes `src/**`, so `npm run typecheck` doesn't cover `test/`.
- **Placeholder domain.** `wrangler.jsonc` routes to `garmin-mcp.TUDOMINIO.com` with `workers_dev: false`, so a real deploy needs that edited first. Dry-run builds and `wrangler dev` work as-is.
- **`package.json` has no `"type": "module"`.** Node prints a harmless `MODULE_TYPELESS_PACKAGE_JSON` warning when the test imports `src/garmin.ts`.

## Architecture

```
src/index.ts    Worker entry: Bearer gate (UPSTREAM_TOKEN) → POST only → JSON-RPC dispatch
                (initialize, ping, tools/list, tools/call, notifications, batches)
src/garmin.ts   Minimal Garmin client: RFC 3986 pct(), hmacSha1() via Web Crypto,
                OAuth1→OAuth2 exchange(), per-isolate caches, connectapi(), displayName()
src/tools.ts    TOOLS array: name + description + JSON Schema + handler → one Garmin endpoint each
src/validate.ts idArg / dateArg / intArg: argument validation before any URL is built
test/           Standalone Node scripts: OAuth1 signing, MFA exchange, validators, tool requests
```

- **Transport**: Streamable HTTP, stateless, protocol `2025-06-18`. Every POST gets one `application/json` response. There is no SSE and no session ID. Notifications get `202`, anything other than POST gets `405`, and a missing or wrong Bearer gets `401`.
- **Secrets**: `GARMIN_OAUTH1` (required, the JSON of `oauth1_token.json`), `UPSTREAM_TOKEN` (required), `GARMIN_CONSUMER_KEY` / `GARMIN_CONSUMER_SECRET` (recommended; without them the consumer is fetched from a third-party S3 bucket). For local runs they go in `.dev.vars`, which is git-ignored.
- **Adding a tool**: add one entry to `TOOLS` in `src/tools.ts`, using the `obj()` / `DATE` schema helpers and calling `connectapi()`. Validate every URL argument with `idArg` / `dateArg` / `intArg` as the handler's first statement, and add a row for the tool to Test 10 in `test/tools.test.mts`. `tools/list` and `TOOL_MAP` pick the tool up automatically.

**Stack**: TypeScript (strict, ES2022), Cloudflare Workers runtime (`@cloudflare/workers-types`), Wrangler 4, Node ≥ 22 (22.18+/23.6+ to run `.mts` tests directly).

## Conventions

- **Language.** Code comments, tool `description`s and error messages are in **Spanish written without diacritics** (`Sueno`, `Metodo`, `invalido`, `anio`). Match that in `src/`. `README.md` and `docs/ARCHITECTURE.md` are English. `DESPLIEGUE.md` is Spanish with normal accents.
- **Keep it tiny.** No runtime dependencies, no frameworks, no build step beyond Wrangler's bundler. Anything used at runtime must exist in the Workers runtime (Web Crypto, `fetch`, `btoa`); the same APIs exist in Node, which is why `src/` modules can be imported straight into tests.
- **Relative imports** in `src/` carry the `.ts` extension (`import … from "./garmin.ts"`, enabled by `allowImportingTsExtensions`). Node's test loader needs it. An import without the extension still passes `tsc` and Wrangler, but it breaks every test that imports that module.
- **Tests** follow the existing pattern: a plain `.mts` script with a small `check()` helper, `PASS`/`FALLO` output, and a non-zero exit on failure. Pure logic goes in exported functions so it can be tested without the network. Never call real Garmin endpoints from tests.

## Development commands

```bash
npm install                                  # dev dependencies only (wrangler, typescript, workers-types)
npm run typecheck                            # tsc --noEmit over src/
node test/oauth1.test.mts                    # OAuth1 signing test (exit 1 on failure)
npx wrangler deploy --dry-run --outdir dist  # bundle check without deploying (no login needed)
npm run dev                                  # wrangler dev on :8787, reads .dev.vars
npm run deploy                               # real deploy (needs the domain in wrangler.jsonc)
```

Local protocol smoke test: `initialize`, `tools/list` and `ping` work with dummy secrets in `.dev.vars`. `tools/call` needs a real token because it hits Garmin. See the "Local development" and "Smoke test" sections of `README.md` for the curl commands.

**Verification before a PR**: `npm run typecheck`, every `test/*.test.mts` script (run each with `node <file>`; Node treats extra files as arguments), and the dry-run bundle must all pass. There is no linter or formatter configured.

## Issue workflow

Read by the `/create-issue`, `/implement-issue`, `/update-issue` and `/review-issue` commands in `.claude/commands/`.

- **Repository:** `isllabres/garmin-mcp-server`, default branch `main`.
- **Ticket tracker:** none. GitHub issues are the only tracker, so the commands use the default GitHub-only naming: branch `issue-<n>`, commit prefix `[<initials>][#<n>]`.
- **EDD:** this server returns raw Garmin JSON and has no LLM behavior of its own. Tool *descriptions* shape how a model uses the tools, so only changes to those warrant `/define-evals`.
