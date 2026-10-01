// Comprobacion del Bearer del portero. Sin imports relativos ni node:*: los tests
// de Node lo importan directamente y el Worker no tiene nodejs_compat.

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
  return eq(enc.encode(String(header)), enc.encode("Bearer " + token));
}
