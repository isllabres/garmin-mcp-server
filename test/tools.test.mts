// Valida que las herramientas rechazan argumentos invalidos antes de llamar a
// Garmin y que, con argumentos validos, construyen exactamente la peticion de hoy.
// fetch esta sustituido por un stub que graba cada llamada: nunca sale a la red.
import { TOOL_MAP } from "../src/tools.ts";
import { presetConsumer } from "../src/garmin.ts";

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

// --- 1. un activity_id con path traversal se rechaza sin llamar a fetch ---
{
  calls.length = 0;
  check("get_activity rechaza activity_id con traversal",
    await rejects(() => run("get_activity", { activity_id: "../../userprofile-service/socialProfile" }), "activity_id"), "ok");
  check("get_activity con traversal: 0 llamadas a fetch", calls.length, 0);
}

// --- 9. con argumentos validos, cada herramienta construye exactamente la peticion de hoy ---
{
  const A = "https://connectapi.garmin.com";
  const lastCall = () => {
    const c = calls[calls.length - 1];
    return c ? `${c.method} ${c.url}${c.body !== undefined ? ` ${c.body}` : ""}` : "(ninguna)";
  };
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

console.log(fail ? `\n${fail} FALLO(S)` : "\nTodo correcto.");
process.exit(fail ? 1 : 0);
