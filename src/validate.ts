// Validacion de los argumentos de las herramientas antes de construir URLs de
// Garmin. Sin imports relativos: los tests de Node lo importan directamente.

/** Entero positivo en forma de cadena de digitos. Devuelve la cadena a interpolar. */
export function idArg(value: unknown, name: string): string {
  if (typeof value === "string" && /^\d+$/.test(value)) return value;
  throw new Error(`${name} invalido: debe ser un entero positivo`);
}
