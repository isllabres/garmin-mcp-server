// Node no tiene crypto.subtle.timingSafeEqual: solo existe en Workers, y el portero
// de src/index.ts lo usa. Los tests que llaman a worker.fetch importan este modulo,
// que instala el timingSafeEqual de node:crypto (mismo contrato: booleano si las
// longitudes coinciden, excepcion si no) solo si falta, para no tapar nunca uno
// real. test/auth.test.mts no lo usa: inyecta el comparador.
import { timingSafeEqual } from "node:crypto";

const subtle = crypto.subtle as SubtleCrypto & { timingSafeEqual?: unknown };
if (typeof subtle.timingSafeEqual !== "function") subtle.timingSafeEqual = timingSafeEqual;
