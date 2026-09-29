// Validacion de los argumentos de las herramientas antes de construir URLs de
// Garmin. Sin imports relativos: los tests de Node lo importan directamente.

// Error comun: "<argumento> invalido: <regla>", en ASCII.
const invalid = (name: string, rule: string) => new Error(`${name} invalido: ${rule}`);

/** Entero positivo, como cadena de digitos o como numero. Devuelve la cadena a interpolar. */
export function idArg(value: unknown, name: string): string {
  if (typeof value === "string" && /^\d+$/.test(value) && /[1-9]/.test(value)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  throw invalid(name, "debe ser un entero positivo");
}

/** Fecha real en formato YYYY-MM-DD. La devuelve sin cambios. */
export function dateArg(value: unknown, name: string): string {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    // Tabla de dias por mes en vez de Date: new Date("2026-02-30") se desborda a marzo.
    const [y, m, d] = value.split("-").map(Number);
    const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
    if (days !== undefined && d >= 1 && d <= days) return value;
  }
  throw invalid(name, "debe ser una fecha real YYYY-MM-DD");
}

/** Entero dentro de [min, max], ambos inclusive (sin maximo si se omite). Lo devuelve como numero. */
export function intArg(value: unknown, name: string, min: number, max?: number): number {
  return value as number;
}
