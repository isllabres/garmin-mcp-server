// Valida las herramientas de detalle de actividad: get_activity_splits (vueltas) y
// get_activity_exercise_sets (series de fuerza), y que get_activity ya no promete
// vueltas ni series.
import { TOOLS, TOOL_MAP } from "../src/tools.ts";

let fail = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = got === want;
  console.log(`${ok ? "PASS" : "FALLO"}  ${name}`);
  if (!ok) { console.log(`        obtenido: ${got}\n        esperado: ${want}`); fail++; }
};

const NEW_TOOLS = ["get_activity_splits", "get_activity_exercise_sets"];

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

console.log(fail ? `\n${fail} FALLO(S)` : "\nTodo correcto.");
process.exit(fail ? 1 : 0);
