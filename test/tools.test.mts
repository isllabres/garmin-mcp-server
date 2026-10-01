// Valida que las herramientas rechazan argumentos invalidos antes de llamar a
// Garmin y que, con argumentos validos, construyen exactamente la peticion de hoy.
// fetch esta sustituido por un stub que graba cada llamada: nunca sale a la red.
import { TOOL_MAP } from "../src/tools.ts";
import { presetConsumer } from "../src/garmin.ts";
import worker from "../src/index.ts";

let fail = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = got === want;
  console.log(`${ok ? "PASS" : "FALLO"}  ${name}`);
  if (!ok) { console.log(`        obtenido: ${got}\n        esperado: ${want}`); fail++; }
};

// Ejecuta fn y devuelve "ok" si rechaza con un mensaje ASCII que nombra el
// argumento y dice "invalido"; si no, devuelve el motivo del fallo.
async function rejects(fn: () => unknown, argName: string): Promise<string> {
  try {
    await fn();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes(argName)) return `el mensaje no nombra ${argName}: ${msg}`;
    if (!msg.includes("invalido")) return `el mensaje no dice invalido: ${msg}`;
    if (!/^[\x00-\x7F]*$/.test(msg)) return `el mensaje no es ASCII: ${msg}`;
    return "ok";
  }
  return "no rechaza";
}

// Stub de fetch: graba {method, url, body} y nunca delega en el fetch real.
const calls: { method: string; url: string; body: unknown }[] = [];
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  calls.push({ method: init?.method ?? "GET", url, body: init?.body });
  if (url.includes("/oauth-service/oauth/exchange/user/2.0")) {
    return new Response(JSON.stringify({ access_token: "AT", expires_in: 3600 }), { status: 200 });
  }
  if (url.endsWith("/userprofile-service/socialProfile")) {
    return new Response(JSON.stringify({ displayName: "atleta" }), { status: 200 });
  }
  return new Response("{}", { status: 200 });
};

presetConsumer("ck", "cs");
const token = { oauth_token: "tok", oauth_token_secret: "sec" };
const run = (tool: string, args: Record<string, unknown>) => TOOL_MAP.get(tool)!.handler(token, args);
const A = "https://connectapi.garmin.com";
// Ultima llamada grabada como "METODO URL [BODY]": no depende de las caches de token ni de displayName.
const lastCall = () => {
  const c = calls[calls.length - 1];
  return c ? `${c.method} ${c.url}${c.body !== undefined ? ` ${c.body}` : ""}` : "(ninguna)";
};

// --- 1. un activity_id con path traversal se rechaza sin llamar a fetch ---
{
  calls.length = 0;
  check("get_activity rechaza activity_id con traversal",
    await rejects(() => run("get_activity", { activity_id: "../../userprofile-service/socialProfile" }), "activity_id"), "ok");
  check("get_activity con traversal: 0 llamadas a fetch", calls.length, 0);
}

// --- 10. cada herramienta con argumentos rechaza los invalidos antes de cualquier fetch ---
// Va antes del test 9: get_sleep_data debe validar antes de await displayName(),
// y eso solo se observa mientras la cache de displayName sigue vacia.
for (const [tool, args, argName] of [
  ["get_sleep_data", { date: "2026-02-30" }, "date"],
  ["get_hrv_data", { date: "../../userprofile-service/userprofile/user-settings" }, "date"],
  ["get_training_readiness", { date: "2026-3-1" }, "date"],
  ["get_stress_data", {}, "date"],
  ["get_body_battery", { start_date: "2026-01-01", end_date: "2026-01-02&foo=bar" }, "end_date"],
  ["get_body_battery", { start_date: "2026-1-1", end_date: "2026-01-02" }, "start_date"],
  ["get_activities", { limit: -5 }, "limit"],
  ["get_activities", { start: 1.5 }, "start"],
  ["get_scheduled_workouts", { year: 2026, month: 13 }, "month"],
  ["get_scheduled_workouts", { year: 2026, month: "abc" }, "month"],
  ["get_scheduled_workouts", { year: 26, month: 3 }, "year"],
  ["schedule_workout", { workout_id: "../../userprofile-service/socialProfile", date: "2026-03-02" }, "workout_id"],
  ["schedule_workout", { workout_id: "987", date: "2026-02-30" }, "date"],
  ["delete_workout", { workout_id: "../../activity-service/activity/1" }, "workout_id"],
  ["get_activity_splits", { activity_id: "../../userprofile-service/socialProfile" }, "activity_id"],
] as [string, Record<string, unknown>, string][]) {
  calls.length = 0;
  const label = `${tool} ${JSON.stringify(args)}`;
  check(`${label} rechaza ${argName}`, await rejects(() => run(tool, args), argName), "ok");
  check(`${label}: 0 llamadas a fetch`, calls.length, 0);
}

// --- 9. con argumentos validos, cada herramienta construye exactamente la peticion de hoy ---
{
  for (const [tool, args, want] of [
    ["get_sleep_data", { date: "2026-03-01" },
      `GET ${A}/wellness-service/wellness/dailySleepData/atleta?date=2026-03-01&nonSleepBufferMinutes=60`],
    ["get_hrv_data", { date: "2026-03-01" }, `GET ${A}/hrv-service/hrv/2026-03-01`],
    ["get_training_readiness", { date: "2026-03-01" }, `GET ${A}/metrics-service/metrics/trainingreadiness/2026-03-01`],
    ["get_body_battery", { start_date: "2026-03-01", end_date: "2026-03-07" },
      `GET ${A}/wellness-service/wellness/bodyBattery/reports/daily?startDate=2026-03-01&endDate=2026-03-07`],
    ["get_stress_data", { date: "2026-03-01" }, `GET ${A}/wellness-service/wellness/dailyStress/2026-03-01`],
    ["get_activities", {}, `GET ${A}/activitylist-service/activities/search/activities?start=0&limit=20`],
    ["get_activities", { start: null, limit: null }, `GET ${A}/activitylist-service/activities/search/activities?start=0&limit=20`],
    ["get_activities", { start: 40, limit: 500 }, `GET ${A}/activitylist-service/activities/search/activities?start=40&limit=500`],
    ["get_activity", { activity_id: "12345678901" }, `GET ${A}/activity-service/activity/12345678901`],
    ["get_activity", { activity_id: 12345678901 }, `GET ${A}/activity-service/activity/12345678901`],
    ["schedule_workout", { workout_id: "987", date: "2026-03-02" },
      `POST ${A}/workout-service/schedule/987 {"date":"2026-03-02"}`],
    ["get_scheduled_workouts", { year: 2026, month: 1 }, `GET ${A}/calendar-service/year/2026/month/0`],
    ["get_scheduled_workouts", { year: 2026, month: 12 }, `GET ${A}/calendar-service/year/2026/month/11`],
    ["delete_workout", { workout_id: "987" }, `DELETE ${A}/workout-service/workout/987`],
  ] as [string, Record<string, unknown>, string][]) {
    calls.length = 0;
    let got: string;
    try { await run(tool, args); got = lastCall(); } catch (e) { got = `THROW: ${(e as Error).message}`; }
    check(`${tool} ${JSON.stringify(args)} construye la peticion de hoy`, got, want);
  }
}

// --- 11. get_body_battery rechaza start_date posterior a end_date y acepta rangos iguales o entre anios ---
{
  calls.length = 0;
  check("get_body_battery rechaza start_date posterior a end_date",
    await rejects(() => run("get_body_battery", { start_date: "2026-03-08", end_date: "2026-03-01" }), "start_date"), "ok");
  check("get_body_battery con rango invertido: 0 llamadas a fetch", calls.length, 0);
  for (const [start, end] of [["2026-03-01", "2026-03-01"], ["2025-12-31", "2026-01-01"]]) {
    calls.length = 0;
    let got: string;
    try { await run("get_body_battery", { start_date: start, end_date: end }); got = lastCall(); }
    catch (e) { got = `THROW: ${(e as Error).message}`; }
    check(`get_body_battery acepta ${start} a ${end}`, got,
      `GET ${A}/wellness-service/wellness/bodyBattery/reports/daily?startDate=${start}&endDate=${end}`);
  }
}

// --- 12. tools/call devuelve el fallo de validacion como isError, no como error JSON-RPC, sin fetch ---
{
  calls.length = 0;
  const env = {
    GARMIN_OAUTH1: JSON.stringify({ oauth_token: "tok", oauth_token_secret: "sec" }),
    UPSTREAM_TOKEN: "up", GARMIN_CONSUMER_KEY: "ck", GARMIN_CONSUMER_SECRET: "cs",
  };
  const res = await worker.fetch(new Request("https://worker.test/", {
    method: "POST",
    headers: { Authorization: "Bearer up" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "delete_workout", arguments: { workout_id: "../../userprofile-service/socialProfile" } },
    }),
  }), env);
  const body = await res.json() as { result?: { isError?: boolean; content?: { text: string }[] }; error?: unknown };
  const text = body.result?.content?.[0]?.text ?? "";
  check("tools/call con workout_id invalido: HTTP 200", res.status, 200);
  check("tools/call con workout_id invalido: result.isError", body.result?.isError, true);
  check("tools/call con workout_id invalido: texto 'Error: ' que nombra workout_id",
    text.startsWith("Error: ") && text.includes("workout_id"), true);
  check("tools/call con workout_id invalido: sin error JSON-RPC", "error" in body, false);
  check("tools/call con workout_id invalido: 0 llamadas a fetch", calls.length, 0);
}

console.log(fail ? `\n${fail} FALLO(S)` : "\nTodo correcto.");
process.exit(fail ? 1 : 0);
