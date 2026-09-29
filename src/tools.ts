import { connectapi, displayName, type OAuth1Token } from "./garmin.ts";
import { idArg, dateArg, intArg } from "./validate.ts";

// unknown impide operar con un argumento crudo (a.month - 1 no compila), pero una
// plantilla `${a.x}` acepta unknown: todo argumento que vaya a una URL debe pasar
// por idArg, dateArg o intArg. El test 10 de test/tools.test.mts lo comprueba.
type Handler = (t: OAuth1Token, a: Record<string, unknown>) => Promise<unknown>;

const DATE = { type: "string", description: "Fecha YYYY-MM-DD" } as const;

export interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: Handler;
}

const obj = (props: Record<string, unknown>, required: string[] = []) =>
  ({ type: "object", properties: props, required });

export const TOOLS: Tool[] = [
  // ---------- biometria: para lo que existe este servidor ----------
  {
    name: "get_sleep_data",
    description:
      "Sueno de una noche: fases, duracion, puntuacion y FC en reposo. " +
      "Usalo para decidir si la carga prevista del dia se sostiene.",
    inputSchema: obj({ date: DATE }, ["date"]),
    handler: async (t, a) => {
      const date = dateArg(a.date, "date");
      return connectapi(t,
        `/wellness-service/wellness/dailySleepData/${await displayName(t)}` +
        `?date=${date}&nonSleepBufferMinutes=60`);
    },
  },
  {
    name: "get_hrv_data",
    description:
      "Variabilidad de la frecuencia cardiaca de la noche, con el estado " +
      "respecto a la linea base del atleta. Es el mejor indicador de fatiga real.",
    inputSchema: obj({ date: DATE }, ["date"]),
    handler: async (t, a) => {
      const date = dateArg(a.date, "date");
      return connectapi(t, `/hrv-service/hrv/${date}`);
    },
  },
  {
    name: "get_training_readiness",
    description:
      "Puntuacion de disposicion para entrenar (0-100) y los factores que la " +
      "componen: sueno, HRV, carga aguda y tiempo de recuperacion.",
    inputSchema: obj({ date: DATE }, ["date"]),
    handler: async (t, a) => {
      const date = dateArg(a.date, "date");
      return connectapi(t, `/metrics-service/metrics/trainingreadiness/${date}`);
    },
  },
  {
    name: "get_body_battery",
    description: "Body Battery por dias en un rango: energia disponible y gasto.",
    inputSchema: obj({ start_date: DATE, end_date: DATE }, ["start_date", "end_date"]),
    handler: async (t, a) => {
      const start = dateArg(a.start_date, "start_date");
      const end = dateArg(a.end_date, "end_date");
      return connectapi(t,
        `/wellness-service/wellness/bodyBattery/reports/daily` +
        `?startDate=${start}&endDate=${end}`);
    },
  },
  {
    name: "get_stress_data",
    description: "Estres a lo largo del dia, en la escala 0-100 de Garmin.",
    inputSchema: obj({ date: DATE }, ["date"]),
    handler: async (t, a) => {
      const date = dateArg(a.date, "date");
      return connectapi(t, `/wellness-service/wellness/dailyStress/${date}`);
    },
  },

  // ---------- actividades ----------
  {
    name: "get_activities",
    description: "Lista de actividades recientes, de la mas nueva a la mas vieja.",
    inputSchema: obj({
      start: { type: "number", description: "Desplazamiento (por defecto 0)" },
      limit: { type: "number", description: "Cuantas traer (por defecto 20)" },
    }),
    handler: async (t, a) => {
      const start = intArg(a.start ?? 0, "start", 0);
      const limit = intArg(a.limit ?? 20, "limit", 1);
      return connectapi(t,
        `/activitylist-service/activities/search/activities` +
        `?start=${start}&limit=${limit}`);
    },
  },
  {
    name: "get_activity",
    description: "Detalle completo de una actividad: potencia, FC, vueltas y series.",
    inputSchema: obj({ activity_id: { type: "string" } }, ["activity_id"]),
    handler: async (t, a) => {
      const id = idArg(a.activity_id, "activity_id");
      return connectapi(t, `/activity-service/activity/${id}`);
    },
  },

  // ---------- entrenos: escritura ----------
  {
    name: "upload_workout",
    description:
      "Crea un entreno en Garmin Connect desde JSON crudo del DTO de Garmin. " +
      "Es la unica via que admite CARGA EN KG en fuerza: pon weightValue y " +
      "weightUnit {unitId:8, unitKey:'kilogram', factor:1000} en cada paso. " +
      "Devuelve el workoutId, que necesitas para programarlo.",
    inputSchema: obj({
      workout: { type: "object", description: "DTO de entreno de Garmin" },
    }, ["workout"]),
    handler: (t, a) =>
      connectapi(t, `/workout-service/workout`, { method: "POST", body: a.workout }),
  },
  {
    name: "schedule_workout",
    description: "Pone un entreno ya creado en el calendario, en una fecha.",
    inputSchema: obj({
      workout_id: { type: "string" },
      date: DATE,
    }, ["workout_id", "date"]),
    handler: async (t, a) => {
      const id = idArg(a.workout_id, "workout_id");
      const date = dateArg(a.date, "date");
      return connectapi(t, `/workout-service/schedule/${id}`,
        { method: "POST", body: { date } });
    },
  },
  {
    name: "get_scheduled_workouts",
    description:
      "Entrenos programados de un mes. OJO: Garmin usa meses 0-11, la " +
      "conversion ya va hecha aqui — pasa el mes normal (1-12).",
    inputSchema: obj({
      year: { type: "number" }, month: { type: "number", description: "1-12" },
    }, ["year", "month"]),
    handler: async (t, a) => {
      const year = intArg(a.year, "year", 1000, 9999);
      const month = intArg(a.month, "month", 1, 12);
      return connectapi(t, `/calendar-service/year/${year}/month/${month - 1}`);
    },
  },
  {
    name: "delete_workout",
    description: "Borra un entreno de Garmin Connect.",
    inputSchema: obj({ workout_id: { type: "string" } }, ["workout_id"]),
    handler: async (t, a) => {
      const id = idArg(a.workout_id, "workout_id");
      return connectapi(t, `/workout-service/workout/${id}`, { method: "DELETE" });
    },
  },
  {
    name: "get_user_settings",
    description:
      "Ajustes del perfil: FTP, zonas de potencia y de frecuencia cardiaca, " +
      "peso y umbral. Util para comprobar que las zonas cuadran con el plan.",
    inputSchema: obj({}),
    handler: (t) => connectapi(t, `/userprofile-service/userprofile/user-settings`),
  },
];

export const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));
