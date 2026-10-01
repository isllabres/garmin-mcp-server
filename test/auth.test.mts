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
// Unica guarda automatica de que se usa la primitiva de tiempo constante: si alguien
// vuelve a comparar con ===, el resultado pasa a ser true. El stub solo da datos.
check("auth: decide el comparador", await run(() => isAuthorized(OK, TOKEN, () => false)), false);

console.log(fail ? `\n${fail} FALLO(S)` : "\nTodo correcto.");
process.exit(fail ? 1 : 0);
