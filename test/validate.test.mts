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

console.log(fail ? `\n${fail} FALLO(S)` : "\nTodo correcto.");
process.exit(fail ? 1 : 0);
