// Dobles compartidos por los tests de la sesion DI en KV. No es un .test.mts:
// npm test no lo ejecuta, como workers-crypto.mts.

type GetType = "text" | "json" | { type?: "text" | "json" };

// KV en memoria. Graba "kv.get <clave>" y "kv.put <clave>" en events para que
// los tests comprueben el orden y el numero de operaciones.
export function memoryKV(
  initial: Record<string, string> = {},
  opts: { events?: string[]; failGet?: Error; failPut?: Error } = {},
) {
  const store = new Map(Object.entries(initial));
  const events = opts.events ?? [];
  return {
    async get(key: string, type?: GetType) {
      events.push(`kv.get ${key}`);
      if (opts.failGet) throw opts.failGet;
      const raw = store.get(key);
      if (raw === undefined) return null;
      const t = typeof type === "string" ? type : type?.type;
      return t === "json" ? JSON.parse(raw) : raw;
    },
    async put(key: string, value: unknown, _opts?: unknown) {
      events.push(`kv.put ${key}`);
      if (opts.failPut) throw opts.failPut;
      if (typeof value !== "string") throw new TypeError("memoryKV solo guarda cadenas");
      store.set(key, value);
    },
    // Siembra desde el test, sin evento.
    set(key: string, value: string) { store.set(key, value); },
    raw(key: string) { return store.get(key) ?? null; },
  };
}
