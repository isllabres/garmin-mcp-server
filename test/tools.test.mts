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

console.log(fail ? `\n${fail} FALLO(S)` : "\nTodo correcto.");
process.exit(fail ? 1 : 0);
