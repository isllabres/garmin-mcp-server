// Valida las reglas de src/validate.ts: formato, calendario, signo, rango y tipo.
// Funciones puras: sin dobles, sin red.
import { idArg, dateArg } from "../src/validate.ts";

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

// --- 4. dateArg devuelve sin cambios las fechas reales YYYY-MM-DD ---
for (const input of ["2026-03-01", "2026-01-01", "2026-12-31", "2024-02-29", "2000-02-29"]) {
  let got: unknown;
  try { got = dateArg(input, "date"); } catch (e) { got = `THROW: ${(e as Error).message}`; }
  check(`dateArg acepta ${input}`, got, input);
}

// --- 5. dateArg rechaza lo que no sea una cadena YYYY-MM-DD estricta ---
for (const input of [
  "2026-01-02&foo=bar", "../../userprofile-service/userprofile/user-settings", "2026-01-05/../x",
  "2026-1-5", "26-01-05", "20260105", "2026/01/05", "2026-01-05T00:00:00Z", " 2026-01-05",
  "2026-01-05\n", "", 20260105, ["2026-01-05"], null, undefined,
] as unknown[]) {
  check(`dateArg rechaza ${show(input)}`, rejects(() => dateArg(input, "end_date"), "end_date"), "ok");
}

// --- 6. dateArg rechaza fechas bien formadas que no existen en el calendario ---
for (const input of [
  "2026-02-29", "2026-02-30", "2100-02-29", "2026-04-31", "2026-13-01", "2026-00-10", "2026-01-00", "2026-01-32",
]) {
  check(`dateArg rechaza ${show(input)}`, rejects(() => dateArg(input, "date"), "date"), "ok");
}

console.log(fail ? `\n${fail} FALLO(S)` : "\nTodo correcto.");
process.exit(fail ? 1 : 0);
