// Comprobacion del Bearer del portero. Sin imports de node:*: el Worker no tiene
// nodejs_compat. test/auth.test.mts la importa directamente e inyecta su comparador;
// los tests que pasan por worker.fetch usan el de por defecto con test/workers-crypto.mts.

type Eq = (a: Uint8Array, b: Uint8Array) => boolean;

// El token da acceso total a la cuenta de Garmin. Con !== la comparacion se corta
// en el primer byte distinto y su duracion revela cuanto del token se acerto, asi
// que se compara en tiempo constante con eq (en Workers, crypto.subtle.timingSafeEqual).
export function isAuthorized(
  header: string | null,
  token: string | undefined,
  eq: Eq = (a, b) => crypto.subtle.timingSafeEqual(a, b),
): boolean {
  // Sin secreto no se acepta nada: si no, "Bearer " o "Bearer undefined" entrarian.
  if (!token) return false;
  if (header === null) return false;
  const enc = new TextEncoder();
  const got = enc.encode(header);
  const want = enc.encode("Bearer " + token);
  // eq lanza si las longitudes en bytes difieren. En ese caso se compara want
  // consigo mismo para gastar el mismo trabajo y se rechaza sin lanzar.
  if (got.byteLength !== want.byteLength) {
    eq(want, want);
    return false;
  }
  return eq(got, want);
}
