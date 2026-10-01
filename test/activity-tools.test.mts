// Valida las herramientas de detalle de actividad: get_activity_splits (vueltas) y
// get_activity_exercise_sets (series de fuerza), y que get_activity ya no promete
// vueltas ni series.
import { TOOLS, TOOL_MAP } from "../src/tools.ts";
import { presetConsumer } from "../src/garmin.ts";

let fail = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = got === want;
  console.log(`${ok ? "PASS" : "FALLO"}  ${name}`);
  if (!ok) { console.log(`        obtenido: ${got}\n        esperado: ${want}`); fail++; }
};

const NEW_TOOLS = ["get_activity_splits", "get_activity_exercise_sets"];

// Stub de fetch que graba cada llamada. Contesta el intercambio OAuth y las rutas
// de actividad (con el fixture del test en curso); cualquier otra URL lanza, asi
// que una llamada no prevista falla en vez de salir a la red.
const EXCHANGE = "https://connectapi.garmin.com/oauth-service/oauth/exchange/user/2.0";
const ACTIVITY = "https://connectapi.garmin.com/activity-service/activity/";
const calls: { url: string; method: string; body: unknown }[] = [];
let fixture: unknown;
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  calls.push({ url, method: init?.method ?? "GET", body: init?.body });
  if (url === EXCHANGE && init?.method === "POST") {
    return new Response(JSON.stringify({ access_token: "test-access-token", expires_in: 3600 }), { status: 200 });
  }
  if (url.startsWith(ACTIVITY)) return new Response(JSON.stringify(fixture), { status: 200 });
  throw new Error("fetch inesperado: " + url);
};
// Llamadas a la API sin el intercambio: que haya intercambio o no depende de si
// tokenCache, que vive en el modulo, ya tiene token por un test anterior.
const apiCalls = () => calls.filter((c) => c.url !== EXCHANGE);

// Consumer precargado: nada se pide al bucket S3.
presetConsumer("test-consumer-key", "test-consumer-secret");
const TOKEN = { oauth_token: "test-token", oauth_token_secret: "test-token-secret" };

// --- T1 should_register_get_activity_splits_and_get_activity_exercise_sets_with_unique_names ---
{
  for (const name of NEW_TOOLS) {
    const tool = TOOL_MAP.get(name);
    check(`T1 ${name} esta registrada con su nombre`, tool?.name, name);
    check(`T1 ${name} tiene descripcion`, typeof tool?.description === "string" && tool.description.length > 0, true);
    check(`T1 ${name} tiene inputSchema de tipo object`, tool?.inputSchema.type, "object");
  }
  check("T1 ningun nombre de herramienta esta repetido", TOOL_MAP.size, TOOLS.length);
}

// --- T2 should_require_activity_id_declared_identically_to_get_activity ---
// Ata las herramientas nuevas al contrato de activity_id de get_activity, sin repetirlo aqui.
{
  type Schema = { properties: Record<string, unknown>; required: string[] };
  const ref = (TOOL_MAP.get("get_activity")!.inputSchema as Schema).properties.activity_id;
  for (const name of NEW_TOOLS) {
    const schema = TOOL_MAP.get(name)?.inputSchema as Schema | undefined;
    check(`T2 ${name}: su unica propiedad es activity_id`, JSON.stringify(Object.keys(schema?.properties ?? {})), '["activity_id"]');
    check(`T2 ${name}: activity_id es obligatorio`, JSON.stringify(schema?.required), '["activity_id"]');
    check(`T2 ${name}: activity_id igual que en get_activity`, JSON.stringify(schema?.properties.activity_id), JSON.stringify(ref));
  }
}

// --- T3 should_GET_the_splits_endpoint_for_the_activity_id_and_return_garmins_json_unchanged ---
// --- T4 should_GET_the_exerciseSets_endpoint_for_the_activity_id_and_return_garmins_json_unchanged ---
// El id de 11 cifras no cabe en int32: delata una conversion numerica que lo trunque.
// Las rutas de Garmin distinguen mayusculas: exerciseSets, no exercisesets.
for (const [test, name, suffix, data] of [
  ["T3", "get_activity_splits", "splits",
    { activityId: 12345678901, lapDTOs: [{ lapIndex: 1, distance: 1000 }] }],
  ["T4", "get_activity_exercise_sets", "exerciseSets",
    { activityId: 12345678901, exerciseSets: [{ setType: "ACTIVE", repetitionCount: 10, weight: 60000 }] }],
] as [string, string, string, unknown][]) {
  fixture = data;
  calls.length = 0;
  let result: unknown;
  try { result = await TOOL_MAP.get(name)!.handler(TOKEN, { activity_id: "12345678901" }); }
  catch (e) { result = `THROW: ${(e as Error).message}`; }
  const api = apiCalls();
  check(`${test} ${name}: 1 llamada a la API`, api.length, 1);
  check(`${test} ${name}: URL de /${suffix}`, api[0]?.url, `${ACTIVITY}12345678901/${suffix}`);
  check(`${test} ${name}: metodo GET`, api[0]?.method, "GET");
  check(`${test} ${name}: una sola llamada y sin cuerpo`, api.length === 1 && api[0].body === undefined, true);
  check(`${test} ${name}: devuelve el JSON de Garmin sin cambios`, JSON.stringify(result), JSON.stringify(data));
}

console.log(fail ? `\n${fail} FALLO(S)` : "\nTodo correcto.");
process.exit(fail ? 1 : 0);
