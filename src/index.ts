// MCP server de Garmin sobre Cloudflare Workers (free tier).
// Transporte: Streamable HTTP, sin estado — cada POST se responde con JSON.

import { TOOLS, TOOL_MAP } from "./tools.ts";
import { presetConsumer, type OAuth1Token } from "./garmin.ts";
import { isAuthorized } from "./auth.ts";

const PROTOCOL = "2025-06-18";

interface Env {
  GARMIN_OAUTH1: string;    // secreto: contenido de oauth1_token.json
  UPSTREAM_TOKEN: string;   // secreto: el portero
  GARMIN_CONSUMER_KEY?: string;     // opcional pero recomendado
  GARMIN_CONSUMER_SECRET?: string;
}

const rpc = (id: unknown, result: unknown) => ({ jsonrpc: "2.0", id, result });
const rpcErr = (id: unknown, code: number, message: string) =>
  ({ jsonrpc: "2.0", id, error: { code, message } });

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json" },
  });

// Solo un objeto puede ser un mensaje JSON-RPC. Lo demas (null, un numero, un
// texto, un booleano, una lista) recibe -32600 con id null: su id no se puede leer.
type RpcMessage = { id?: unknown; method?: unknown; params?: any };
const isMessage = (m: unknown): m is RpcMessage =>
  typeof m === "object" && m !== null && !Array.isArray(m);
const invalidRequest = () => rpcErr(null, -32600, "Peticion invalida");

// Solo tools/call necesita el token: los metodos de protocolo funcionan sin el.
// El error no incluye el valor: JSON.parse lo citaria y saldria en el resultado.
function readOAuth1(raw: string): OAuth1Token {
  try {
    const t = JSON.parse(raw) as OAuth1Token;
    if (t.oauth_token && t.oauth_token_secret) return t;
  } catch { /* cae al error de abajo */ }
  throw new Error("GARMIN_OAUTH1 no es un oauth1_token.json valido");
}

async function handleRpc(req: unknown, env: Env): Promise<unknown | null> {
  if (!isMessage(req)) return invalidRequest();
  const { id, method, params } = req;

  switch (method) {
    case "initialize":
      return rpc(id, {
        protocolVersion: PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: "garmin", version: "1.0.0" },
      });

    // Notificaciones: no llevan id y no se responden.
    case "notifications/initialized":
      return null;

    case "ping":
      return rpc(id, {});

    case "tools/list":
      return rpc(id, {
        tools: TOOLS.map(({ name, description, inputSchema }) =>
          ({ name, description, inputSchema })),
      });

    case "tools/call": {
      const tool = TOOL_MAP.get(params?.name);
      if (!tool) return rpcErr(id, -32602, `Herramienta desconocida: ${params?.name}`);
      try {
        const out = await tool.handler(readOAuth1(env.GARMIN_OAUTH1), params.arguments ?? {});
        return rpc(id, {
          content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
        });
      } catch (e: any) {
        // Error de la herramienta, no del protocolo: va como isError para que
        // el modelo lo lea y pueda reaccionar.
        return rpc(id, {
          content: [{ type: "text", text: `Error: ${e?.message ?? String(e)}` }],
          isError: true,
        });
      }
    }

    default:
      return id === undefined ? null : rpcErr(id, -32601, `Metodo no soportado: ${method}`);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // --- Portero ---
    // Este servidor da acceso total a la cuenta de Garmin. El Bearer lo inyecta
    // el MCP portal desde el servidor, no el cliente (los clientes de Claude no
    // reenvian cabeceras: ver cloudflare/mcp#95).
    if (!isAuthorized(request.headers.get("Authorization"), env.UPSTREAM_TOKEN)) {
      return new Response("Unauthorized", { status: 401 });
    }

    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    presetConsumer(env.GARMIN_CONSUMER_KEY, env.GARMIN_CONSUMER_SECRET);

    let body: any;
    try { body = await request.json(); }
    catch { return json(rpcErr(null, -32700, "JSON invalido"), 400); }

    // El cliente puede mandar un lote. Uno vacio recibe un solo error, no una lista.
    if (Array.isArray(body)) {
      if (body.length === 0) return json(invalidRequest());
      const out = (await Promise.all(body.map((m) => handleRpc(m, env))))
        .filter((r) => r !== null);
      return out.length ? json(out) : new Response(null, { status: 202 });
    }

    const res = await handleRpc(body, env);
    return res === null ? new Response(null, { status: 202 }) : json(res);
  },
};
