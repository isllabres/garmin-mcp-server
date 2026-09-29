// Valida las reglas de src/validate.ts: formato, calendario, signo, rango y tipo.
// Funciones puras: sin dobles, sin red.
import { idArg } from "../src/validate.ts";

let fail = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = got === want;
  console.log(`${ok ? "PASS" : "FALLO"}  ${name}`);
  if (!ok) { console.log(`        obtenido: ${got}\n        esperado: ${want}`); fail++; }
};

// --- 2. idArg acepta enteros positivos como cadena o numero y devuelve la cadena ---
for (const [input, want] of [
  ["123", "123"],
  [123, "123"],
  ["12345678901", "12345678901"],
  [12345678901, "12345678901"],
  [1, "1"],
] as [unknown, string][]) {
  let got: unknown;
  try { got = idArg(input, "activity_id"); } catch (e) { got = `THROW: ${(e as Error).message}`; }
  check(`idArg acepta ${JSON.stringify(input)}`, got, want);
}

// Ejecuta fn y devuelve "ok" si lanza un error ASCII que nombra el argumento y
// dice "invalido"; si no, devuelve el motivo del fallo.
function rejects(fn: () => unknown, argName: string): string {
  try {
    fn();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes(argName)) return `el mensaje no nombra ${argName}: ${msg}`;
    if (!msg.includes("invalido")) return `el mensaje no dice invalido: ${msg}`;
    if (!/^[\x00-\x7F]*$/.test(msg)) return `el mensaje no es ASCII: ${msg}`;
    return "ok";
  }
  return "no rechaza";
}

// Etiqueta legible incluso para undefined, NaN, Infinity y objetos.
const show = (v: unknown) =>
  typeof v === "number" || v === undefined ? String(v) : JSON.stringify(v);

// --- 3. idArg rechaza todo lo que no sea un entero positivo, nombrando el argumento ---
for (const input of [
  "0", 0, -3, "-3", 1.5, "1.5", "", " 12", "12 ", "123\n", "+12", "1e3", "0x1F", "12a",
  "１２３", "../../userprofile-service/socialProfile", "1/../../x",
  1e21, Infinity, NaN, [123], {}, true, null, undefined,
] as unknown[]) {
  check(`idArg rechaza ${show(input)}`, rejects(() => idArg(input, "activity_id"), "activity_id"), "ok");
}
check("idArg nombra el argumento recibido (workout_id)", rejects(() => idArg("abc", "workout_id"), "workout_id"), "ok");

console.log(fail ? `\n${fail} FALLO(S)` : "\nTodo correcto.");
process.exit(fail ? 1 : 0);
