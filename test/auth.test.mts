// Valida la comprobacion del Bearer de src/auth.ts. Node no tiene
// crypto.subtle.timingSafeEqual (solo existe en Workers), asi que se inyecta el
// timingSafeEqual de node:crypto, que cumple el mismo contrato: devuelve un
// booleano si las longitudes coinciden y lanza si no.
import { timingSafeEqual } from "node:crypto";
import { isAuthorized } from "../src/auth.ts";

let fail = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = got === want;
  console.log(`${ok ? "PASS" : "FALLO"}  ${name}`);
  if (!ok) { console.log(`        obtenido: ${got}\n        esperado: ${want}`); fail++; }
};

// Una excepcion se registra como valor ("THROW: <mensaje>") y sale como FALLO,
// en vez de abortar el script.
async function run(fn: () => unknown): Promise<unknown> {
  try { return await fn(); }
  catch (e) { return `THROW: ${e instanceof Error ? e.message : String(e)}`; }
}

const TOKEN = "tok_abc123";
const OK = "Bearer tok_abc123";

// --- T1 should_authorize_when_header_is_Bearer_plus_the_configured_token ---
check("auth: token correcto", await run(() => isAuthorized(OK, TOKEN, timingSafeEqual)), true);

// --- T2 should_take_the_verdict_from_the_injected_comparator ---
// Guarda que el veredicto lo da eq y no ===: si alguien vuelve a comparar con ===,
// el resultado pasa a ser true. Que el eq por defecto sea la primitiva de Workers
// no lo comprueba ningun test automatico; solo la revision y la prueba manual T6.
// El stub solo da datos.
check("auth: decide el comparador", await run(() => isAuthorized(OK, TOKEN, () => false)), false);

// --- T3 should_reject_a_wrong_token_of_any_length_without_throwing ---
// Las dos primitivas lanzan si las longitudes en bytes difieren; en Workers eso
// seria un 500 (error 1101) donde toca un 401. "Bearer tok_abc12ñ" tiene 17
// caracteres, como el valido, pero 18 bytes: pilla comparar string.length.
for (const [label, header] of [
  ["auth: token distinto, misma longitud", "Bearer tok_abc124"],
  ["auth: esquema en minusculas", "bearer tok_abc123"],
  ["auth: token mas corto (sin excepcion)", "Bearer tok_abc12"],
  ["auth: token mas largo (sin excepcion)", "Bearer tok_abc1234"],
  ["auth: multibyte, distinta longitud en bytes", "Bearer tok_abc12ñ"],
]) {
  check(label, await run(() => isAuthorized(header, TOKEN, timingSafeEqual)), false);
}

// --- T4 should_reject_when_the_Authorization_header_is_missing_or_empty ---
// Headers.get devuelve null si no hay cabecera. Guarda contra un header.length
// que reviente con null.
check("auth: sin cabecera", await run(() => isAuthorized(null, TOKEN, timingSafeEqual)), false);
check("auth: cabecera vacia", await run(() => isAuthorized("", TOKEN, timingSafeEqual)), false);

// --- T5 should_reject_every_header_when_UPSTREAM_TOKEN_is_missing_or_empty ---
// Sin la guarda, un Worker desplegado sin el secreto aceptaria "Bearer " o
// "Bearer undefined": acceso total a la cuenta.
for (const [label, header, token] of [
  ["auth: UPSTREAM_TOKEN vacio", "Bearer ", ""],
  ["auth: UPSTREAM_TOKEN ausente", "Bearer undefined", undefined],
  ["auth: sin token ni cabecera", null, ""],
] as [string, string | null, string | undefined][]) {
  check(label, await run(() => isAuthorized(header, token, timingSafeEqual)), false);
}

console.log(fail ? `\n${fail} FALLO(S)` : "\nTodo correcto.");
process.exit(fail ? 1 : 0);
