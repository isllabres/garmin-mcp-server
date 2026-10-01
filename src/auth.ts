// Comprobacion del Bearer del portero. Sin imports de node:*: el Worker no tiene
// nodejs_compat. Los tests de Node la importan directamente e inyectan su comparador.

type Eq = (a: Uint8Array, b: Uint8Array) => boolean;

// El token da acceso total a la cuenta de Garmin. Con !== la comparacion se corta
// en el primer byte distinto y su duracion revela cuanto del token se acerto, asi
// que se compara en tiempo constante con eq (en Workers, crypto.subtle.timingSafeEqual).
export function isAuthorized(
  header: string | null,
  token: string | undefined,
  eq: Eq = (a, b) => crypto.subtle.timingSafeEqual(a, b),
): boolean {
  const enc = new TextEncoder();
  const got = enc.encode(String(header));
  const want = enc.encode("Bearer " + token);
  // eq lanza si las longitudes en bytes difieren. En ese caso se compara want
  // consigo mismo para gastar el mismo trabajo y se rechaza sin lanzar.
  if (got.byteLength !== want.byteLength) {
    eq(want, want);
    return false;
  }
  return eq(got, want);
}
